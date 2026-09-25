import '../src/quiet-sqlite-warning.js';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createRelayHttpServer } from '../src/http.js';
import { RelayStore } from '../src/store.js';
import { WorkerManager } from '../src/worker.js';

const ADMIN_TOKEN = 'test-admin-token';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Relay {
  base: string;
  port: number;
  store: RelayStore;
}

async function startRelay(): Promise<Relay> {
  const directory = await mkdtemp(join(tmpdir(), 'crosschat-http-'));
  const publicDirectory = join(directory, 'public');
  await mkdir(join(publicDirectory, 'assets'), { recursive: true });
  await writeFile(join(publicDirectory, 'index.html'), '<!doctype html><title>Dashboard</title>');
  await writeFile(join(publicDirectory, 'assets', 'app.js'), 'console.log(1)');

  const store = new RelayStore(join(directory, 'data'));
  await store.init();
  await store.ensureOperator('operator');
  // Workers here run a fake harness that never calls the relay back, so the URL is only a placeholder.
  const localMcpUrl = 'http://localhost:4318/mcp';
  const workers = new WorkerManager(store, { mcpUrl: localMcpUrl, runDirectory: join(directory, 'runs') });
  const server = createRelayHttpServer({
    store,
    token: ADMIN_TOKEN,
    allowedHosts: ['localhost', '127.0.0.1'],
    allowedOrigins: ['localhost', '127.0.0.1'],
    publicDirectory,
    workers,
    localMcpUrl,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await workers.start();
  cleanups.push(async () => {
    await workers.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, port, store };
}

function rawRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.write(request));
    let received = '';
    socket.on('data', (chunk) => {
      received += String(chunk);
    });
    socket.on('close', () => resolve(received));
    socket.on('error', reject);
  });
}

/** Call an MCP tool statelessly and return the parsed tool result. */
async function callTool(relay: Relay, token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${relay.base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await response.text();
  const payload = text.startsWith('{') ? text : text.split('\n').find((line) => line.startsWith('data: '))!.slice(6);
  const result = (JSON.parse(payload) as { result: { isError?: boolean; content: Array<{ text: string }> } }).result;
  return { isError: result.isError === true, value: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
}

async function signIn(relay: Relay): Promise<string> {
  const response = await fetch(`${relay.base}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: ADMIN_TOKEN }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}

describe('relay HTTP server', () => {
  it('survives a malformed Host header', async () => {
    const relay = await startRelay();
    const reply = await rawRequest(relay.port, 'GET /health HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n');
    expect(reply).toMatch(/^HTTP\/1\.1 200/);
    expect((await fetch(`${relay.base}/health`)).status).toBe(200);
  });

  it('rejects MCP requests without a valid token', async () => {
    const relay = await startRelay();
    const response = await fetch(`${relay.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer nope' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(response.status).toBe(401);
  });

  it('binds a per-agent token to its own slug', async () => {
    const relay = await startRelay();
    const { token } = await relay.store.createAgent({ slug: 'worker', displayName: 'Worker', modelSlug: 'm', capabilities: ['text-output'] });
    await relay.store.createAgent({ slug: 'other', displayName: 'Other', modelSlug: 'm', capabilities: ['text-output'] });

    expect((await callTool(relay, token!, 'whoami')).value).toMatchObject({ kind: 'agent', agent: { slug: 'worker' } });

    const posted = await callTool(relay, token!, 'post_task', { recipientSlug: 'other', title: 'Hi', instructions: 'Do it.' });
    expect(posted.isError).toBe(false);
    expect(posted.value).toMatchObject({ senderSlug: 'worker' });

    const spoofed = await callTool(relay, token!, 'post_task', {
      senderSlug: 'other',
      recipientSlug: 'worker',
      title: 'Spoof',
      instructions: 'Pretend to be other.',
    });
    expect(spoofed).toMatchObject({ isError: true, value: { error: 'identity_mismatch' } });

    expect((await callTool(relay, token!, 'claim_next_task', { recipientSlug: 'other' })).value).toMatchObject({ error: 'identity_mismatch' });
  });

  it('requires explicit slugs with the admin token', async () => {
    const relay = await startRelay();
    const result = await callTool(relay, ADMIN_TOKEN, 'claim_next_task', {});
    expect(result).toMatchObject({ isError: true, value: { error: 'slug_required' } });
    expect((await callTool(relay, ADMIN_TOKEN, 'claim_next_task', { recipientSlug: 'operator' })).value).toEqual({ status: 'idle' });
  });

  it('protects the REST API with the admin session and a CSRF header', async () => {
    const relay = await startRelay();
    expect((await fetch(`${relay.base}/api/agents`)).status).toBe(401);

    const wrong = await fetch(`${relay.base}/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    });
    expect(wrong.status).toBe(401);

    const cookie = await signIn(relay);
    const agents = (await (await fetch(`${relay.base}/api/agents`, { headers: { cookie } })).json()) as Array<{ slug: string }>;
    expect(agents.map((agent) => agent.slug)).toEqual(['operator']);

    const body = JSON.stringify({ slug: 'helper', displayName: 'Helper', modelSlug: 'm', capabilities: ['text-output'] });
    const withoutCsrf = await fetch(`${relay.base}/api/agents`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body });
    expect(withoutCsrf.status).toBe(403);

    const created = await fetch(`${relay.base}/api/agents`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-crosschat-request': '1' },
      body,
    });
    expect(created.status).toBe(201);
    const { token } = (await created.json()) as { token: string };
    expect(relay.store.authenticateAgentToken(token)).toBe('helper');

    // Agent tokens are for MCP only.
    expect((await fetch(`${relay.base}/api/agents`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    // The admin token works as a bearer without the CSRF header.
    expect((await fetch(`${relay.base}/api/overview`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })).status).toBe(200);
  });

  it('posts tasks as the operator and validates input', async () => {
    const relay = await startRelay();
    const cookie = await signIn(relay);
    const headers = { cookie, 'content-type': 'application/json', 'x-crosschat-request': '1' };
    await relay.store.createAgent({ slug: 'helper', displayName: 'Helper', modelSlug: 'm', capabilities: ['text-output'] });

    const invalid = await fetch(`${relay.base}/api/tasks`, { method: 'POST', headers, body: JSON.stringify({ recipientSlug: 'helper' }) });
    expect(invalid.status).toBe(400);

    const created = await fetch(`${relay.base}/api/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ recipientSlug: 'helper', title: 'From the dashboard', instructions: 'Please do this.', priority: 3 }),
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as { id: string; senderSlug: string };
    expect(task.senderSlug).toBe('operator');

    // A worker run's steps, for the live view.
    await relay.store.appendActivity(task.id, [{ at: new Date().toISOString(), kind: 'message', text: 'Working on it.' }]);
    const activity = await fetch(`${relay.base}/api/tasks/${task.id}/activity`, { headers: { cookie } });
    expect(((await activity.json()) as { entries: Array<{ text: string }> }).entries.map((entry) => entry.text)).toEqual(['Working on it.']);
    expect((await fetch(`${relay.base}/api/tasks/${task.id}/activity`)).status).toBe(401);
    expect((await fetch(`${relay.base}/api/tasks/00000000-0000-4000-8000-000000000000/activity`, { headers: { cookie } })).status).toBe(404);

    const cancelled = await fetch(`${relay.base}/api/tasks/${task.id}/cancel`, { method: 'POST', headers, body: JSON.stringify({ reason: 'Changed my mind.' }) });
    expect(((await cancelled.json()) as { status: string }).status).toBe('cancelled');
  });

  it('lets a harness enroll itself from an invite and connect with its own token', async () => {
    const relay = await startRelay();
    const cookie = await signIn(relay);
    const created = await fetch(`${relay.base}/api/invites`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-crosschat-request': '1' },
      body: JSON.stringify({ label: 'Test harness', expiresInHours: 1, maxUses: 1 }),
    });
    expect(created.status).toBe(201);
    const { code } = (await created.json()) as { code: string };

    // Enrollment needs no session: the invite code is the credential.
    const enroll = (body: object) =>
      fetch(`${relay.base}/api/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const profile = { slug: 'self-made', displayName: 'Self made', modelSlug: 'test-model', capabilities: ['text-output'] };

    expect((await enroll({ ...profile, invite: 'cci_wrong' })).status).toBe(403);
    const enrolled = await enroll({ ...profile, invite: code });
    expect(enrolled.status).toBe(201);
    const result = (await enrolled.json()) as { token: string; mcpUrl: string; setup: Record<string, unknown>; next: string[] };
    expect(result.mcpUrl).toBe(`${relay.base}/mcp`);
    expect(result.setup).toHaveProperty('claudeCode');
    expect(result.next.length).toBeGreaterThan(0);

    expect((await callTool(relay, result.token, 'whoami')).value).toMatchObject({ kind: 'agent', agent: { slug: 'self-made' } });
    // Single use.
    expect((await enroll({ ...profile, slug: 'second', invite: code })).status).toBe(403);
    // Invites are admin-only to create or list.
    expect((await fetch(`${relay.base}/api/invites`)).status).toBe(401);
  });

  it('tells an enrolling agent its assigned name, role, and waiting first task', async () => {
    const relay = await startRelay();
    const cookie = await signIn(relay);
    const headers = { cookie, 'content-type': 'application/json', 'x-crosschat-request': '1' };
    const created = await fetch(`${relay.base}/api/invites`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        expiresInHours: 1,
        maxUses: 1,
        displayName: 'Docs writer',
        role: 'Writes and updates user documentation.',
        firstTask: { title: 'Document the invite flow', instructions: 'Write a README section about invites.' },
      }),
    });
    const { code } = (await created.json()) as { code: string };

    const enrolled = await fetch(`${relay.base}/api/enroll`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ invite: code, slug: 'docs-bot', displayName: 'Chosen name', modelSlug: 'm', capabilities: ['text-output'] }),
    });
    const result = (await enrolled.json()) as { token: string; agent: { displayName: string }; assignedTask: { title: string }; next: string[] };
    expect(result.agent.displayName).toBe('Docs writer');
    expect(result.assignedTask.title).toBe('Document the invite flow');
    expect(result.next.join(' ')).toContain('Docs writer');
    expect(result.next.join(' ')).toContain('claim_next_task');

    const claimed = await callTool(relay, result.token, 'claim_next_task', {});
    expect(claimed.value).toMatchObject({ status: 'task', task: { title: 'Document the invite flow', senderSlug: 'operator' } });

    const renamed = await fetch(`${relay.base}/api/agents/docs-bot`, { method: 'PATCH', headers, body: JSON.stringify({ displayName: 'Docs lead' }) });
    expect(((await renamed.json()) as { displayName: string }).displayName).toBe('Docs lead');
    expect((await fetch(`${relay.base}/api/agents/docs-bot`, { method: 'PATCH', headers, body: '{}' })).status).toBe(400);
  });

  it('connects a harness on this computer and starts a worker for it, from this computer only', async () => {
    const relay = await startRelay();
    const headers = { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };
    const harness = fileURLToPath(new URL('./fixtures/fake-harness.mjs', import.meta.url));
    const workdir = await mkdtemp(join(tmpdir(), 'crosschat-connect-'));

    // Local-only endpoints refuse requests that arrive through a proxy.
    const proxied = await fetch(`${relay.base}/api/local`, { headers: { ...headers, 'x-forwarded-for': '203.0.113.9' } });
    expect(proxied.status).toBe(403);
    const local = (await (await fetch(`${relay.base}/api/local`, { headers })).json()) as { harnesses: Array<{ id: string }> };
    expect(local.harnesses.map((item) => item.id)).toContain('claude-code');

    // The folder picker lists this computer's folders, for this computer only.
    const browsed = (await (await fetch(`${relay.base}/api/local/browse?mode=dir&path=${encodeURIComponent(tmpdir())}`, { headers })).json()) as { path: string };
    expect(browsed.path).toBe(tmpdir());
    expect((await fetch(`${relay.base}/api/local/browse?mode=dir`, { headers: { ...headers, 'x-forwarded-for': '203.0.113.9' } })).status).toBe(403);

    const connected = await fetch(`${relay.base}/api/local/connect`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        harness: 'custom',
        slug: 'local-bot',
        displayName: 'Local bot',
        role: 'Does small local jobs.',
        worker: { command: process.execPath, args: [harness], workdir, allowedSenders: ['operator'], timeoutMinutes: 1 },
      }),
    });
    expect(connected.status).toBe(201);
    const result = (await connected.json()) as { agent: { displayName: string }; token?: string; worker: { state: string } };
    expect(result.agent.displayName).toBe('Local bot');
    // A custom harness is configured by hand, so its token comes back once.
    expect(result.token).toMatch(/^cca_/);
    expect(['idle', 'running']).toContain(result.worker.state);

    const task = await relay.store.postTask({ senderSlug: 'operator', recipientSlug: 'local-bot', title: 'Say hi', instructions: 'MODE:done', requiredCapabilities: [], priority: 2 });
    const deadline = Date.now() + 15_000;
    let status = 'queued';
    while (status !== 'completed' && Date.now() < deadline) {
      status = (await relay.store.getTaskById(task.id)).status;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(status).toBe('completed');

    const workers = (await (await fetch(`${relay.base}/api/workers`, { headers })).json()) as { workers: Array<{ agentSlug: string; lastRun?: { outcome: string } }> };
    expect(workers.workers.find((worker) => worker.agentSlug === 'local-bot')?.lastRun?.outcome).toBe('completed');
    await rm(workdir, { recursive: true, force: true });
  });

  it('links tasks a worker run hands off, and stops chains at the limit', async () => {
    const relay = await startRelay();
    for (const slug of ['bob', 'carol']) await relay.store.createAgent({ slug, displayName: slug, modelSlug: 'm', capabilities: ['text-output'] });
    const first = await relay.store.postTask({ senderSlug: 'operator', recipientSlug: 'bob', title: 'Build', instructions: 'Go.', requiredCapabilities: [], priority: 2 });
    const runToken = await relay.store.issueRunToken('bob', first.id, 60_000);

    const handedOff = await callTool(relay, runToken, 'post_task', { recipientSlug: 'carol', title: 'Draw', instructions: 'Tiles.' });
    expect(handedOff.value).toMatchObject({ parentTaskId: first.id, depth: 1, senderSlug: 'bob' });

    await relay.store.setChainLimit(0);
    const refused = await callTool(relay, runToken, 'post_task', { recipientSlug: 'carol', title: 'More', instructions: 'Tiles.' });
    expect(refused).toMatchObject({ isError: true, value: { error: 'chain_limit' } });
  });

  it('gives chat sessions nothing when an agent\'s tasks go only to its worker', async () => {
    const relay = await startRelay();
    const { token } = await relay.store.createAgent({ slug: 'bob', displayName: 'Bob', modelSlug: 'm', capabilities: ['text-output'] });
    await relay.store.postTask({ senderSlug: 'operator', recipientSlug: 'bob', title: 'Work', instructions: 'Go.', requiredCapabilities: [], priority: 2 });
    await relay.store.saveWorkerConfig({
      agentSlug: 'bob', harness: 'custom', command: process.execPath, args: [], promptMode: 'stdin', workdir: tmpdir(),
      allowedSenders: ['nobody'], timeoutMinutes: 5, enabled: true, extraDirs: [], maxRunsPerHour: 20, exclusive: true,
    });
    const claimed = await callTool(relay, token!, 'claim_next_task', {});
    expect(claimed.value).toMatchObject({ status: 'idle' });
    expect(String(claimed.value.note)).toContain('worker');
  });

  it('lets a sender ask for changes over MCP, and previews only files a run changed', async () => {
    const relay = await startRelay();
    const alice = await relay.store.createAgent({ slug: 'alice', displayName: 'Alice', modelSlug: 'm', capabilities: ['text-output'] });
    const bob = await relay.store.createAgent({ slug: 'bob', displayName: 'Bob', modelSlug: 'm', capabilities: ['text-output'] });
    const posted = await relay.store.postTask({ senderSlug: 'alice', recipientSlug: 'bob', title: 'Draw', instructions: 'A fan.', requiredCapabilities: [], priority: 2 });
    await relay.store.claimNextTask('bob', 300);
    await relay.store.reportTask({ reporterSlug: 'bob', taskId: posted.id, kind: 'completed', message: 'Done.' });

    expect((await callTool(relay, bob.token!, 'request_changes', { taskId: posted.id, note: 'Mine.' })).value).toMatchObject({ error: 'task_changes_denied' });
    expect((await callTool(relay, alice.token!, 'request_changes', { taskId: posted.id, note: 'Blur it.' })).value).toMatchObject({ status: 'queued' });

    const pictures = await mkdtemp(join(tmpdir(), 'crosschat-pic-'));
    cleanups.push(() => rm(pictures, { recursive: true, force: true }));
    const picture = join(pictures, 'fan.png');
    await writeFile(picture, Buffer.from('89504e470d0a1a0a', 'hex'));
    await relay.store.appendActivity(posted.id, [{ at: new Date().toISOString(), kind: 'files', text: 'Files: 1 added', files: [{ path: picture, change: 'added' }] }]);
    const cookie = await signIn(relay);
    const preview = await fetch(`${relay.base}/api/tasks/${posted.id}/file?path=${encodeURIComponent(picture)}`, { headers: { cookie } });
    expect(preview.status).toBe(200);
    expect(preview.headers.get('content-type')).toBe('image/png');
    const other = await fetch(`${relay.base}/api/tasks/${posted.id}/file?path=${encodeURIComponent(join(tmpdir(), 'other.png'))}`, { headers: { cookie } });
    expect(other.status).toBe(404);
    const proxied = await fetch(`${relay.base}/api/tasks/${posted.id}/file?path=${encodeURIComponent(picture)}`, { headers: { cookie, 'x-forwarded-for': '203.0.113.9' } });
    expect(proxied.status).toBe(403);
  });

  it('streams committed changes to the dashboard', async () => {
    const relay = await startRelay();
    const cookie = await signIn(relay);
    const controller = new AbortController();
    const stream = await fetch(`${relay.base}/api/stream`, { headers: { cookie }, signal: controller.signal });
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = stream.body!.getReader();

    await relay.store.createAgent({ slug: 'streamed', displayName: 'Streamed', modelSlug: 'm', capabilities: ['text-output'] });
    let received = '';
    while (!received.includes('"slug":"streamed"')) {
      const { value, done } = await reader.read();
      if (done) break;
      received += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(received).toContain('event: change');
  });

  it('rejects dashboard and API requests for unexpected hosts or origins', async () => {
    const relay = await startRelay();
    const rebinding = await rawRequest(relay.port, 'GET /api/session HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
    expect(rebinding).toMatch(/^HTTP\/1\.1 403/);
    const foreign = await fetch(`${relay.base}/api/session`, { headers: { origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
  });

  it('serves the dashboard with security headers and never escapes its directory', async () => {
    const relay = await startRelay();
    const index = await fetch(`${relay.base}/tasks/some-client-route`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('<title>Dashboard</title>');
    expect(index.headers.get('content-security-policy')).toContain("default-src 'self'");

    const asset = await fetch(`${relay.base}/assets/app.js`);
    expect(asset.headers.get('cache-control')).toContain('immutable');

    const traversal = await rawRequest(relay.port, 'GET /..%2f..%2fdata%2frelay.db HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    expect(traversal).toContain('<title>Dashboard</title>');
  });
});
