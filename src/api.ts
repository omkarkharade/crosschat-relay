import { existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, hostname } from 'node:os';
import { isAbsolute } from 'node:path';

import { z, ZodError } from 'zod';

import type { Authenticator } from './auth.js';
import { browse } from './browse.js';
import { reveal, sendImage } from './files.js';
import { CUSTOM_HARNESS, detectHarnesses, findPreset } from './harnesses.js';
import { agentProfile, details, longText, newTask, priority, shortText, slug, taskStatus } from './schemas.js';
import { RelayError, type RelayStore, type WorkerConfig } from './store.js';
import type { WorkerManager } from './worker.js';
import { VERSION } from './version.js';

export interface ApiOptions {
  store: RelayStore;
  auth: Authenticator;
  /** The human agent the dashboard posts tasks as. */
  operatorSlug: string;
  workers?: WorkerManager;
  /** The relay's MCP endpoint as seen by harnesses on this computer. */
  localMcpUrl?: string;
}

/** Header the dashboard sends on every mutating request. Browsers cannot add it cross-site without CORS, which /api never allows. */
export const CSRF_HEADER = 'x-crosschat-request';

const MAX_BODY_BYTES = 1024 * 1024;
const STREAM_KEEPALIVE_MS = 25_000;

const createAgentBody = agentProfile.extend({ kind: z.enum(['agent', 'human']).default('agent') });
const sessionBody = z.object({ token: z.string().min(1).max(1_000) });
const reasonBody = z.object({ reason: longText });
const inviteBody = z.object({
  label: z.string().trim().max(120).optional(),
  expiresInHours: z.number().positive().max(24 * 30),
  maxUses: z.number().int().min(1).max(1000).optional(),
  displayName: shortText.optional(),
  role: details.min(1).optional(),
  firstTask: z.object({ title: shortText, instructions: longText, priority: priority.default(2) }).optional(),
});
const profileBody = z
  .object({ displayName: shortText.optional(), details: details.min(1).nullable().optional() })
  .refine((body) => body.displayName !== undefined || body.details !== undefined, 'Send displayName, details, or both.');
const enrollBody = agentProfile.extend({ invite: z.string().trim().min(1).max(200) });
const noteBody = z.object({ note: longText });
const workerBody = z.object({
  harness: z.string().trim().min(1).max(80),
  command: z.string().trim().min(1).max(1000).optional(),
  args: z.array(z.string().max(2000)).max(64).optional(),
  promptMode: z.enum(['stdin', 'file', 'argument']).optional(),
  workdir: z.string().trim().min(1).max(1000),
  allowedSenders: z.array(slug).max(100),
  timeoutMinutes: z.number().int().min(1).max(24 * 60).default(30),
  enabled: z.boolean().default(true),
  extraDirs: z.array(z.string().trim().min(1).max(1000)).max(20).default([]),
  maxRunsPerHour: z.number().int().min(1).max(500).default(20),
  exclusive: z.boolean().default(false),
});
const connectBody = z.object({
  harness: z.string().trim().min(1).max(80),
  slug,
  displayName: shortText,
  modelSlug: shortText.optional(),
  role: details.min(1).optional(),
  configureClient: z.boolean().default(true),
  worker: workerBody.omit({ harness: true }).optional(),
});

type Handler = (context: RequestContext) => Promise<void> | void;

interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body: () => Promise<unknown>;
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  /** Routes that work before signing in. */
  public?: boolean;
}

export function createApiHandler({ store, auth, operatorSlug, workers, localMcpUrl }: ApiOptions) {
  const routes: Route[] = [];
  const route = (method: string, path: string, handler: Handler, options: { public?: boolean } = {}) => {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_match, key: string) => (keys.push(key), '([^/]+)'))}$`);
    routes.push({ method, pattern, keys, handler, ...options });
  };

  // ------------------------------------------------------------- session
  route(
    'GET',
    '/api/session',
    ({ request, response }) => sendJson(response, 200, { authenticated: isAdmin(request), version: VERSION }),
    { public: true },
  );

  route(
    'POST',
    '/api/session',
    async ({ request, response, body }) => {
      const { token } = sessionBody.parse(await body());
      const cookie = auth.createSession(token, isSecure(request));
      if (!cookie) throw new RelayError('That token is not the admin token.', 'invalid_token', undefined, 401);
      response.setHeader('set-cookie', cookie);
      sendJson(response, 200, { authenticated: true, version: VERSION });
    },
    { public: true },
  );

  route('DELETE', '/api/session', ({ request, response }) => {
    response.setHeader('set-cookie', auth.clearSession(isSecure(request)));
    sendJson(response, 200, { authenticated: false });
  });

  // ------------------------------------------------------------ overview
  route('GET', '/api/overview', async ({ response }) => {
    sendJson(response, 200, { version: VERSION, operatorSlug, stats: await store.stats() });
  });

  // -------------------------------------------------------------- agents
  route('GET', '/api/agents', async ({ response }) => sendJson(response, 200, await store.listAgents(true)));

  route('POST', '/api/agents', async ({ response, body }) => {
    const input = createAgentBody.parse(await body());
    sendJson(response, 201, await store.createAgent(input));
  });

  // Set how an agent appears to everyone; the agent's own registrations keep these values.
  route('PATCH', '/api/agents/:slug', async ({ response, params, body }) => {
    const input = profileBody.parse(await body());
    sendJson(
      response,
      200,
      await store.updateAgentProfile(params.slug!, {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.details !== undefined ? { details: input.details } : {}),
      }),
    );
  });

  route('POST', '/api/agents/:slug/token', async ({ response, params }) => {
    sendJson(response, 200, { token: await store.issueToken(params.slug!) });
  });

  route('DELETE', '/api/agents/:slug/token', async ({ response, params }) => {
    await store.revokeToken(params.slug!);
    sendJson(response, 200, { revoked: true });
  });

  route('DELETE', '/api/agents/:slug', async ({ response, params }) => {
    if (params.slug === operatorSlug) throw new RelayError('The dashboard operator cannot be deleted.', 'operator_protected', undefined, 409);
    await store.deleteAgent(params.slug!);
    sendJson(response, 200, { deleted: true });
  });

  // --------------------------------------------------------------- tasks
  route('GET', '/api/tasks', async ({ response, url }) => {
    const statuses = url.searchParams.get('status')?.split(',').filter(Boolean).map((status) => taskStatus.parse(status));
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
    sendJson(
      response,
      200,
      await store.listTasks({
        ...(statuses ? { statuses } : {}),
        ...(url.searchParams.get('agent') ? { agentSlug: url.searchParams.get('agent')! } : {}),
        ...(url.searchParams.get('q') ? { search: url.searchParams.get('q')! } : {}),
        ...(limit !== undefined && Number.isFinite(limit) ? { limit } : {}),
      }),
    );
  });

  route('POST', '/api/tasks', async ({ response, body }) => {
    const input = newTask.parse(await body());
    sendJson(response, 201, await store.postTask({ ...input, senderSlug: operatorSlug }));
  });

  route('GET', '/api/tasks/:id', async ({ response, params }) => sendJson(response, 200, await store.getTaskById(params.id!)));

  // The steps of worker runs on a task; new steps arrive on the change stream.
  route('GET', '/api/tasks/:id/activity', async ({ response, params }) => {
    await store.getTaskById(params.id!);
    sendJson(response, 200, { entries: await store.listActivity(params.id!) });
  });

  // The owner may cancel or requeue any task; it is recorded as the sender's
  // action, marked as coming from the dashboard.
  route('POST', '/api/tasks/:id/cancel', async ({ response, params, body }) => {
    const { reason } = reasonBody.parse(await body());
    const task = await store.getTaskById(params.id!);
    sendJson(response, 200, await store.cancelTask(task.senderSlug, task.id, `${reason} (via dashboard)`));
  });

  route('POST', '/api/tasks/:id/request-changes', async ({ response, params, body }) => {
    const { note } = noteBody.parse(await body());
    const task = await store.getTaskById(params.id!);
    sendJson(response, 200, await store.requestChanges(task.senderSlug, task.id, `${note} (via dashboard)`));
  });

  // The task a task was delegated from, and the tasks delegated from it.
  route('GET', '/api/tasks/:id/related', async ({ response, params }) => sendJson(response, 200, await store.relatedTasks(params.id!)));

  // A picture a worker run on this task created or changed, for the dashboard on this computer.
  route('GET', '/api/tasks/:id/file', async ({ request, response, params, url }) => {
    requireLoopback(request);
    const path = url.searchParams.get('path') ?? '';
    if (!(await store.taskChangedFile(params.id!, path))) throw new RelayError('No run on this task changed that file.', 'not_found', undefined, 404);
    await sendImage(response, path);
  });

  route('POST', '/api/tasks/:id/reveal', async ({ request, response, params, body }) => {
    requireLoopback(request);
    const { path } = z.object({ path: z.string().min(1).max(4000) }).parse(await body());
    if (!(await store.taskChangedFile(params.id!, path))) throw new RelayError('No run on this task changed that file.', 'not_found', undefined, 404);
    reveal(path);
    sendJson(response, 200, { revealed: true });
  });

  route('POST', '/api/tasks/:id/requeue', async ({ response, params, body }) => {
    const { note } = noteBody.parse(await body());
    const task = await store.getTaskById(params.id!);
    sendJson(response, 200, await store.requeueTask(task.senderSlug, task.id, `${note} (via dashboard)`));
  });

  // ------------------------------------------------------------- invites
  route('GET', '/api/invites', async ({ response }) => sendJson(response, 200, await store.listInvites()));

  route('POST', '/api/invites', async ({ response, body }) => {
    const { label, expiresInHours, maxUses, displayName, role, firstTask } = inviteBody.parse(await body());
    sendJson(
      response,
      201,
      await store.createInvite({
        expiresInMs: expiresInHours * 60 * 60 * 1000,
        ...(label ? { label } : {}),
        ...(maxUses ? { maxUses } : {}),
        ...(displayName ? { displayName } : {}),
        ...(role ? { role } : {}),
        ...(firstTask ? { firstTask } : {}),
      }),
    );
  });

  route('DELETE', '/api/invites/:id', async ({ response, params }) => sendJson(response, 200, await store.revokeInvite(params.id!)));

  // An agent enrolls itself with an invite code (no session needed) and gets
  // its own token plus everything it needs to connect.
  route(
    'POST',
    '/api/enroll',
    async ({ request, response, body }) => {
      const { invite, ...profile } = enrollBody.parse(await body());
      const { agent, token, assignedTask } = await store.enroll(invite, profile, operatorSlug);
      const mcpUrl = `${publicOrigin(request)}/mcp`;
      const assigned: string[] = [];
      if (agent.ownerSet.displayName) assigned.push(`The relay owner named you "${agent.displayName}"; that is how everyone sees you.`);
      if (agent.ownerSet.details && agent.details) assigned.push(`Your role, as others see it: ${agent.details}`);
      sendJson(response, 201, {
        agent,
        token,
        mcpUrl,
        ...(assignedTask ? { assignedTask: { id: assignedTask.id, title: assignedTask.title, priority: assignedTask.priority } } : {}),
        setup: {
          claudeCode: `claude mcp add --transport http crosschat ${mcpUrl} --header "Authorization: Bearer ${token}"`,
          codex: `export CROSSCHAT_TOKEN=${token}\ncodex mcp add crosschat --url ${mcpUrl} --bearer-token-env-var CROSSCHAT_TOKEN`,
          json: { mcpServers: { crosschat: { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } },
          generic: `Add a Streamable HTTP MCP server named "crosschat" at ${mcpUrl} with the header "Authorization: Bearer ${token}".`,
        },
        next: [
          ...assigned,
          'Save the token now; it is shown only once and cannot be recovered.',
          'Add the relay as an MCP server using the setup entry for your client. If your client needs a restart or reload to see new MCP servers, ask the user to do that.',
          'Once the crosschat tools are available, call whoami to confirm you are connected as your slug.',
          ...(assignedTask
            ? [`A first task is already waiting for you: "${assignedTask.title}". After whoami, call claim_next_task to take it and start working.`]
            : []),
          'Follow the working rules from the invite message, and save them to your standing instructions.',
        ],
      });
    },
    { public: true },
  );

  // ------------------------------------------------------------- workers
  route('GET', '/api/workers', ({ request, response }) =>
    sendJson(response, 200, {
      paused: workers?.isPaused() ?? false,
      local: isLoopback(request),
      maxChainDepth: store.chainLimit(),
      workers: workers?.statuses() ?? [],
    }),
  );

  // The longest chain of agent-to-agent hand-offs worker runs may start.
  route('PUT', '/api/workers/limits', async ({ request, response, body }) => {
    requireLoopback(request);
    const { maxChainDepth } = z.object({ maxChainDepth: z.number().int().min(0).max(10) }).parse(await body());
    await store.setChainLimit(maxChainDepth);
    sendJson(response, 200, { maxChainDepth });
  });

  route('POST', '/api/workers/pause', async ({ response, body }) => {
    const { paused } = z.object({ paused: z.boolean() }).parse(await body());
    await requireWorkers().setPaused(paused);
    sendJson(response, 200, { paused });
  });

  // Workers start programs on this computer, so they can only be set up from it.
  route('PUT', '/api/workers/:slug', async ({ request, response, params, body }) => {
    requireLoopback(request);
    const config = await workerConfig(params.slug!, workerBody.parse(await body()));
    await store.saveWorkerConfig(config);
    await requireWorkers().reload(params.slug!);
    sendJson(response, 200, requireWorkers().status(params.slug!));
  });

  route('DELETE', '/api/workers/:slug', async ({ request, response, params }) => {
    requireLoopback(request);
    await store.deleteWorkerConfig(params.slug!);
    await requireWorkers().reload(params.slug!);
    sendJson(response, 200, { deleted: true });
  });

  // ------------------------------------------------ harnesses on this computer
  route('GET', '/api/local', ({ request, response }) => {
    requireLoopback(request);
    sendJson(response, 200, { hostname: hostname(), homeDirectory: homedir(), mcpUrl: localMcpUrl, harnesses: detectHarnesses() });
  });

  // Folder and program pickers: list this computer's folders.
  route('GET', '/api/local/browse', async ({ request, response, url }) => {
    requireLoopback(request);
    const mode = url.searchParams.get('mode') === 'file' ? 'file' : 'dir';
    const path = url.searchParams.get('path') ?? undefined;
    sendJson(response, 200, await browse({ ...(path ? { path } : {}), mode, hidden: url.searchParams.get('hidden') === '1' }));
  });

  /**
   * Connect a harness on this computer in one step: create its agent and
   * token, add the relay to the harness's own MCP settings, and (optionally)
   * start a worker so it picks up tasks unattended.
   */
  route('POST', '/api/local/connect', async ({ request, response, body }) => {
    requireLoopback(request);
    const input = connectBody.parse(await body());
    const preset = findPreset(input.harness);
    if (!preset && input.harness !== CUSTOM_HARNESS) throw new RelayError(`Unknown harness "${input.harness}".`, 'unknown_harness', undefined, 400);
    const detected = detectHarnesses().find((harness) => harness.id === input.harness);
    const command = input.worker?.command ?? detected?.path;
    if (input.worker) await workerConfig(input.slug, { ...input.worker, harness: input.harness }, true);

    const { agent, token } = await store.createAgent({
      slug: input.slug,
      displayName: input.displayName,
      modelSlug: input.modelSlug ?? preset?.name ?? 'custom',
      capabilities: ['text-input', 'text-output', 'code-execution', 'file-system'],
      ...(input.role ? { details: input.role } : {}),
    });
    await store.updateAgentProfile(agent.slug, { displayName: input.displayName, ...(input.role ? { details: input.role } : {}) });

    let connection: { configured: boolean; message: string; file?: string; snippet?: string } = {
      configured: false,
      message: 'Add the relay to this harness yourself with the details below.',
      snippet: JSON.stringify({ mcpServers: { crosschat: { url: localMcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
    };
    if (input.configureClient && preset && command && localMcpUrl) {
      connection = await preset.connect({ mcpUrl: localMcpUrl, token: token!, command }).catch((error: unknown) => ({
        configured: false,
        message: `Couldn't configure ${preset.name} automatically: ${error instanceof Error ? error.message : String(error)}`,
        snippet: connection.snippet!,
      }));
    }

    let worker;
    if (input.worker) {
      await store.saveWorkerConfig(await workerConfig(agent.slug, { ...input.worker, harness: input.harness }));
      await requireWorkers().reload(agent.slug);
      worker = requireWorkers().status(agent.slug);
    }
    sendJson(response, 201, {
      agent: await store.getAgent(agent.slug),
      connection,
      // The token is only returned when the harness still has to be configured by hand.
      ...(connection.configured ? {} : { token }),
      ...(worker ? { worker } : {}),
    });
  });

  // -------------------------------------------------------------- events
  route('GET', '/api/events', async ({ response, url }) => {
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const before = url.searchParams.get('before');
    sendJson(
      response,
      200,
      await store.listEvents({ limit: Number.isFinite(limit) ? limit : 50, ...(before ? { beforeSequence: Number(before) } : {}) }),
    );
  });

  route('GET', '/api/stream', ({ request, response }) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write('retry: 3000\n\n');
    const unsubscribe = store.subscribe((change) => {
      response.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
    });
    const keepalive = setInterval(() => response.write(': keepalive\n\n'), STREAM_KEEPALIVE_MS);
    request.on('close', () => {
      clearInterval(keepalive);
      unsubscribe();
    });
  });

  function requireWorkers(): WorkerManager {
    if (!workers) throw new RelayError('Workers are not available in this relay.', 'workers_unavailable', undefined, 503);
    return workers;
  }

  /** Validate a worker configuration and fill in the harness's program. */
  async function workerConfig(
    agentSlug: string,
    input: z.infer<typeof workerBody>,
    checkOnly = false,
  ): Promise<Omit<WorkerConfig, 'createdAt' | 'updatedAt'>> {
    const preset = findPreset(input.harness);
    if (input.harness !== CUSTOM_HARNESS && !preset?.run) {
      throw new RelayError(`${preset?.name ?? input.harness} can't run tasks headless; choose "custom" and give its command.`, 'harness_cannot_run', undefined, 400);
    }
    const command = input.command ?? detectHarnesses().find((harness) => harness.id === input.harness)?.path;
    if (!command || !existsSync(command)) {
      throw new RelayError(`Couldn't find the program for ${preset?.name ?? 'this harness'}${command ? ` at ${command}` : ''}. Give its full path.`, 'harness_not_found', undefined, 400);
    }
    if (!existsSync(input.workdir) || !statSync(input.workdir).isDirectory()) {
      throw new RelayError(`The working folder ${input.workdir} doesn't exist.`, 'workdir_not_found', undefined, 400);
    }
    if (input.harness === CUSTOM_HARNESS && (input.promptMode ?? 'stdin') === 'file' && !(input.args ?? []).some((arg) => arg.includes('{prompt_file}'))) {
      throw new RelayError('With the prompt in a file, include {prompt_file} in the arguments.', 'invalid_worker', undefined, 400);
    }
    for (const dir of input.extraDirs) {
      if (!isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new RelayError(`The extra folder ${dir} doesn't exist.`, 'workdir_not_found', undefined, 400);
      }
    }
    if (!checkOnly && input.allowedSenders.length === 0) {
      throw new RelayError('Allow at least one sender, or turn the worker off.', 'invalid_worker', undefined, 400);
    }
    return {
      agentSlug,
      harness: input.harness,
      command,
      args: input.args ?? [],
      promptMode: input.promptMode ?? 'stdin',
      workdir: input.workdir,
      allowedSenders: input.allowedSenders,
      timeoutMinutes: input.timeoutMinutes,
      enabled: input.enabled,
      extraDirs: [...new Set(input.extraDirs)],
      maxRunsPerHour: input.maxRunsPerHour,
      exclusive: input.exclusive,
    };
  }

  function isAdmin(request: IncomingMessage): boolean {
    const headers = toHeaders(request);
    return auth.fromSession({ headers })?.kind === 'admin' || auth.fromBearer({ headers })?.kind === 'admin';
  }

  return async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    try {
      const method = request.method ?? 'GET';
      let pathMatched = false;
      for (const candidate of routes) {
        const match = candidate.pattern.exec(url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (candidate.method !== method) continue;

        if (!candidate.public) {
          const headers = toHeaders(request);
          const viaSession = auth.fromSession({ headers })?.kind === 'admin';
          const viaBearer = auth.fromBearer({ headers })?.kind === 'admin';
          if (!viaSession && !viaBearer) {
            throw new RelayError('Sign in with the admin token.', 'unauthorized', undefined, 401);
          }
          // Cookies ride along automatically, so cookie-authenticated writes
          // must prove they came from the dashboard itself.
          if (viaSession && !viaBearer && method !== 'GET' && !request.headers[CSRF_HEADER]) {
            throw new RelayError(`Missing ${CSRF_HEADER} header.`, 'csrf_check_failed', undefined, 403);
          }
        }

        const params = Object.fromEntries(candidate.keys.map((key, index) => [key, decodeURIComponent(match[index + 1]!)]));
        await candidate.handler({ request, response, url, params, body: () => readJson(request) });
        return;
      }
      if (pathMatched) {
        sendJson(response, 405, { error: 'method_not_allowed' });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
    } catch (error: unknown) {
      sendError(response, error);
    }
  };
}

function sendError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof RelayError) {
    sendJson(response, error.statusCode, { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) });
  } else if (error instanceof ZodError) {
    sendJson(response, 400, {
      error: 'invalid_request',
      message: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '),
    });
  } else if (error instanceof SyntaxError) {
    sendJson(response, 400, { error: 'invalid_json', message: 'The request body is not valid JSON.' });
  } else {
    console.error('[api] request failed:', error);
    sendJson(response, 500, { error: 'internal_error', message: 'The relay could not complete this request.' });
  }
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RelayError('The request body is too large.', 'payload_too_large', undefined, 413);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

function toHeaders(request: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

/** The scheme and host the caller used to reach the relay. The Host header was already checked against the allowlist. */
function publicOrigin(request: IncomingMessage): string {
  return `${isSecure(request) ? 'https' : 'http'}://${request.headers.host ?? 'localhost'}`;
}

/** Whether the request came from this computer and not through a proxy. */
function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress ?? '';
  const direct = !request.headers['x-forwarded-for'] && !request.headers.forwarded;
  return direct && (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1');
}

function requireLoopback(request: IncomingMessage): void {
  if (!isLoopback(request)) {
    throw new RelayError('This can only be done from the computer the relay runs on.', 'local_only', undefined, 403);
  }
}

/** Whether the browser reached us over HTTPS (directly or through a proxy). */
function isSecure(request: IncomingMessage): boolean {
  return 'encrypted' in request.socket || request.headers['x-forwarded-proto'] === 'https';
}
