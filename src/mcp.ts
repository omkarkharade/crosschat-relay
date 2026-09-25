import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { actingSlug, principalFromAuthInfo, type Principal } from './auth.js';
import { capabilities, capability, details, leaseSeconds, longText, priority, shortText, slug } from './schemas.js';
import { DEFAULT_CAPABILITIES, RelayError, type RelayStore } from './store.js';
import { VERSION } from './version.js';

const selfSlug = (role: string) =>
  slug.optional().describe(`The ${role}'s agent slug. Omit it when connected with a per-agent token; it is filled in for you.`);

function response(value: unknown) {
  // Compact JSON: these results are read by models, so whitespace costs tokens.
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function failure(error: unknown) {
  const relayError = error instanceof RelayError ? error : undefined;
  if (!relayError) console.error('[relay] internal error:', error);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: relayError?.code ?? 'internal_error',
          message: relayError?.message ?? 'The relay could not complete this request.',
          ...(relayError?.details ? { details: relayError.details } : {}),
        }),
      },
    ],
  };
}

/** Run a tool body with the caller's principal, turning errors into tool errors. */
const tool = <T>(ctx: ServerContext, handler: (principal: Principal) => Promise<T>) =>
  Promise.resolve()
    .then(() => handler(principalFromAuthInfo(ctx.http?.authInfo)))
    .then(response)
    .catch(failure);

export function createRelayMcpServer(store: RelayStore): McpServer {
  const server = new McpServer({ name: 'crosschat-relay', version: VERSION });

  server.registerTool(
    'whoami',
    {
      title: 'Show which agent this connection acts as',
      description: 'Return the agent slug bound to this connection’s token, or note that the admin token is in use.',
      inputSchema: z.object({}),
    },
    (_input, ctx) =>
      tool(ctx, async (principal) =>
        principal.kind === 'agent'
          ? { kind: 'agent', agent: await store.getAgent(principal.slug) }
          : { kind: 'admin', note: 'The admin token can act as any agent; pass the slug arguments explicitly.' },
      ),
  );

  server.registerTool(
    'register_agent',
    {
      title: 'Register or refresh an agent',
      description:
        'Register this agent under one unique slug, or refresh its availability and capability declaration. With a per-agent token, the slug is the token’s own. If the relay owner set your display name or role, those are kept and the values you send are ignored.',
      inputSchema: z.object({
        slug: selfSlug('registering agent'),
        displayName: shortText,
        modelSlug: shortText,
        capabilities: capabilities.min(1),
        details: details.optional(),
      }),
    },
    (input, ctx) => tool(ctx, (principal) => store.registerAgent({ ...input, slug: actingSlug(principal, input.slug, 'slug') })),
  );

  server.registerTool(
    'list_agents',
    {
      title: 'List available agents',
      description:
        'List registered agents: their display names, roles (details), model slugs, capabilities, and recent availability. Use an agent’s role to decide whom to send a task to, and its slug to address it.',
      inputSchema: z.object({ includeOffline: z.boolean().default(false) }),
    },
    ({ includeOffline }, ctx) => tool(ctx, () => store.listAgents(includeOffline)),
  );

  server.registerTool(
    'heartbeat',
    {
      title: 'Refresh an agent’s availability',
      description: 'Refresh this agent’s recent-availability timestamp. This is silent and does not create a relay message.',
      inputSchema: z.object({ agentSlug: selfSlug('agent') }),
    },
    ({ agentSlug }, ctx) => tool(ctx, (principal) => store.heartbeat(actingSlug(principal, agentSlug, 'agentSlug'))),
  );

  server.registerTool(
    'post_task',
    {
      title: 'Assign a task to an agent',
      description:
        'Queue one concrete task for a registered agent slug. This creates work; it never sends conversational acknowledgements or invites a reply.',
      inputSchema: z.object({
        senderSlug: selfSlug('sending agent'),
        recipientSlug: slug,
        title: shortText,
        instructions: longText,
        requiredCapabilities: z.array(capability).max(32).default([]),
        priority: priority.default(2).describe('1 = low, 2 = normal, 3 = urgent.'),
        parentTaskId: z.uuid().optional().describe('The task this one is part of (one you sent or received), to keep related work in one thread.'),
      }),
    },
    (input, ctx) =>
      tool(ctx, (principal) => {
        // A task posted during a worker run belongs to the task being run, and counts toward the hand-off limit.
        const runTaskId = principal.kind === 'agent' ? principal.runTaskId : undefined;
        const parentTaskId = runTaskId ?? input.parentTaskId;
        return store.postTask({
          ...input,
          senderSlug: actingSlug(principal, input.senderSlug, 'senderSlug'),
          ...(parentTaskId ? { parentTaskId } : {}),
          enforceChainLimit: Boolean(runTaskId),
        });
      }),
  );

  server.registerTool(
    'claim_next_task',
    {
      title: 'Claim one waiting task',
      description:
        'Atomically claim the most urgent task addressed to this agent (priority 3 first, then oldest). Optionally long-poll for up to 25 seconds. If no task is available, it returns {"status":"idle"}; do not turn that into a chat message.',
      inputSchema: z.object({
        recipientSlug: selfSlug('claiming agent'),
        waitMs: z.number().int().min(0).max(25_000).default(0),
        leaseSeconds: leaseSeconds.default(900),
      }),
    },
    ({ recipientSlug, waitMs, leaseSeconds: taskLeaseSeconds }, ctx) =>
      tool(ctx, async (principal) => {
        const slug = actingSlug(principal, recipientSlug, 'recipientSlug');
        // The owner set this agent's tasks to go only to its worker on the relay's computer.
        if (store.workerOnly(slug)) {
          await store.heartbeat(slug);
          return { status: 'idle', note: "This agent's tasks run automatically in its worker, so chat sessions don't receive them." };
        }
        const task = await store.waitForTask(slug, waitMs, taskLeaseSeconds);
        return task ? { status: 'task', task } : { status: 'idle' };
      }),
  );

  server.registerTool(
    'renew_task_lease',
    {
      title: 'Renew a claimed task lease',
      description: 'Extend the lease before it expires while actively working on a task. This is silent to the sender.',
      inputSchema: z.object({ reporterSlug: selfSlug('working agent'), taskId: z.uuid(), leaseSeconds: leaseSeconds.default(900) }),
    },
    ({ reporterSlug, taskId, leaseSeconds: taskLeaseSeconds }, ctx) =>
      tool(ctx, (principal) => store.renewLease(actingSlug(principal, reporterSlug, 'reporterSlug'), taskId, taskLeaseSeconds)),
  );

  server.registerTool(
    'report_task',
    {
      title: 'Report material task progress or a final result',
      description:
        'Send only a material progress update, a completed result, or a blocker for a claimed task. Do not use this tool for thanks, acknowledgements, or pleasantries.',
      inputSchema: z.object({
        reporterSlug: selfSlug('working agent'),
        taskId: z.uuid(),
        kind: z.enum(['progress', 'completed', 'blocked']),
        message: longText,
        result: z.string().trim().max(40_000).optional(),
      }),
    },
    (input, ctx) =>
      tool(ctx, (principal) => store.reportTask({ ...input, reporterSlug: actingSlug(principal, input.reporterSlug, 'reporterSlug') })),
  );

  server.registerTool(
    'release_task',
    {
      title: 'Release a claimed task',
      description: 'Return a task to its recipient queue if work cannot continue. The sender receives the reason as a material state change.',
      inputSchema: z.object({ reporterSlug: selfSlug('working agent'), taskId: z.uuid(), reason: longText }),
    },
    ({ reporterSlug, taskId, reason }, ctx) =>
      tool(ctx, (principal) => store.releaseTask(actingSlug(principal, reporterSlug, 'reporterSlug'), taskId, reason)),
  );

  server.registerTool(
    'read_updates',
    {
      title: 'Read material updates addressed to this agent',
      description:
        'Read new task state changes without replying to them. Reading advances this agent’s relay cursor; if no updates are present, continue without a conversational response.',
      inputSchema: z.object({ agentSlug: selfSlug('reading agent'), limit: z.number().int().min(1).max(100).default(25) }),
    },
    ({ agentSlug, limit }, ctx) => tool(ctx, (principal) => store.readUpdates(actingSlug(principal, agentSlug, 'agentSlug'), limit)),
  );

  server.registerTool(
    'get_task',
    {
      title: 'Read a task and its reports',
      description: 'Read task details and report history. Only the sender and assigned recipient can access it.',
      inputSchema: z.object({ requesterSlug: selfSlug('reading agent'), taskId: z.uuid() }),
    },
    ({ requesterSlug, taskId }, ctx) =>
      tool(ctx, (principal) => store.getTask(actingSlug(principal, requesterSlug, 'requesterSlug'), taskId)),
  );

  server.registerTool(
    'cancel_task',
    {
      title: 'Cancel a queued, claimed, or blocked task',
      description: 'Cancel a task you assigned. This emits one material cancellation update to the recipient.',
      inputSchema: z.object({ senderSlug: selfSlug('sending agent'), taskId: z.uuid(), reason: longText }),
    },
    ({ senderSlug, taskId, reason }, ctx) =>
      tool(ctx, (principal) => store.cancelTask(actingSlug(principal, senderSlug, 'senderSlug'), taskId, reason)),
  );

  server.registerTool(
    'requeue_task',
    {
      title: 'Requeue a blocked task',
      description:
        'Return a task you assigned from blocked to its recipient queue once the blocker is resolved. The note explains what changed and is sent to the recipient as a material update.',
      inputSchema: z.object({ senderSlug: selfSlug('sending agent'), taskId: z.uuid(), note: longText }),
    },
    ({ senderSlug, taskId, note }, ctx) =>
      tool(ctx, (principal) => store.requeueTask(actingSlug(principal, senderSlug, 'senderSlug'), taskId, note)),
  );

  server.registerTool(
    'request_changes',
    {
      title: 'Ask for changes to a finished task',
      description:
        'Send a completed task you assigned back to its recipient with exactly what to change. It reopens with its history, so the recipient sees its earlier result and your notes. Use this instead of posting a new task to fix earlier work.',
      inputSchema: z.object({ senderSlug: selfSlug('sending agent'), taskId: z.uuid(), note: longText.describe('What to change, specifically.') }),
    },
    ({ senderSlug, taskId, note }, ctx) =>
      tool(ctx, (principal) => store.requestChanges(actingSlug(principal, senderSlug, 'senderSlug'), taskId, note)),
  );

  server.registerResource(
    'relay-protocol',
    'crosschat://protocol',
    {
      title: 'Crosschat collaboration protocol',
      description: 'The rules an agent follows when working through the Crosschat relay.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [
        {
          uri: 'crosschat://protocol',
          mimeType: 'text/markdown',
          text: [
            '# Crosschat protocol',
            '',
            '1. Register once using a unique agent slug. A model slug is descriptive; the agent slug is the address. With a per-agent token, your slug is fixed and you can omit slug arguments.',
            '2. Use `claim_next_task` to take one task. `idle` is not an event worth mentioning.',
            '3. Send `report_task` only for progress that changes a decision, a completion, or a blocker. Never use it for thanks.',
            '4. Read updates without acknowledging them. Only react when an update changes work or asks for a decision.',
            '5. Renew the lease while working; release the task if it cannot be completed.',
            '6. When a task you assigned is blocked, resolve the blocker and use `requeue_task`, or cancel it.',
            '7. When finished work you assigned needs fixes, use `request_changes` on that task rather than posting a new one.',
            '',
            `Suggested capability labels: ${DEFAULT_CAPABILITIES.join(', ')}.`,
          ].join('\n'),
        },
      ],
    }),
  );

  return server;
}
