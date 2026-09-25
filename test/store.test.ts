import '../src/quiet-sqlite-warning.js';

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RelayError, RelayStore, type RelayChange, type RelayStoreOptions } from '../src/store.js';

const temporaryDirectories: string[] = [];
const openStores: RelayStore[] = [];

async function newDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'crosschat-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function open(directory: string, options: RelayStoreOptions = {}): RelayStore {
  const store = new RelayStore(directory, options);
  openStores.push(store);
  return store;
}

async function newStore(options: RelayStoreOptions = {}): Promise<RelayStore> {
  return open(await newDirectory(), options);
}

async function storeWithPair(options: RelayStoreOptions = {}): Promise<RelayStore> {
  const store = await newStore(options);
  for (const slug of ['sender', 'receiver']) {
    await store.registerAgent({ slug, displayName: slug, modelSlug: `${slug}-model`, capabilities: ['text-output'] });
  }
  return store;
}

function post(store: RelayStore, title: string, priority: 1 | 2 | 3 = 2) {
  return store.postTask({
    senderSlug: 'sender',
    recipientSlug: 'receiver',
    title,
    instructions: `Do ${title}.`,
    requiredCapabilities: [],
    priority,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  // SQLite files cannot be deleted on Windows while they are open.
  await Promise.all(openStores.splice(0).map((store) => store.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('RelayStore', () => {
  it('claims a task once and delivers only material state changes to its sender', async () => {
    const store = await newStore();
    await store.registerAgent({
      slug: 'codex',
      displayName: 'Codex',
      modelSlug: 'gpt-6-codex',
      capabilities: ['text-input', 'text-output', 'code-execution'],
    });
    await store.registerAgent({
      slug: 'claude',
      displayName: 'Claude',
      modelSlug: 'claude-sonnet',
      capabilities: ['text-input', 'text-output'],
    });

    const queued = await store.postTask({
      senderSlug: 'codex',
      recipientSlug: 'claude',
      title: 'Summarize the proposal',
      instructions: 'Return a concise risk summary.',
      requiredCapabilities: ['text-output'],
      priority: 2,
    });

    const claimed = await store.claimNextTask('claude', 300);
    expect(claimed?.id).toBe(queued.id);
    expect(await store.claimNextTask('claude', 300)).toBeUndefined();

    const claimUpdate = await store.readUpdates('codex', 10);
    expect(claimUpdate.updates).toHaveLength(1);
    expect(claimUpdate.updates[0]?.type).toBe('task-claimed');

    await store.reportTask({
      reporterSlug: 'claude',
      taskId: queued.id,
      kind: 'completed',
      message: 'Risk summary is ready.',
      result: 'Primary risk: missing authentication boundary.',
    });
    const completionUpdate = await store.readUpdates('codex', 10);
    expect(completionUpdate.updates).toHaveLength(1);
    expect(completionUpdate.updates[0]?.type).toBe('task-completed');

    const restored = open(temporaryDirectories[0]!);
    const persistedTask = await restored.getTask('codex', queued.id);
    expect(persistedTask.status).toBe('completed');
    expect(persistedTask.reports[0]?.result).toContain('authentication boundary');
  });

  it('rejects assignments the receiving agent cannot perform', async () => {
    const store = await storeWithPair();
    await expect(
      store.postTask({
        senderSlug: 'sender',
        recipientSlug: 'receiver',
        title: 'Generate an image',
        instructions: 'Create a diagram.',
        requiredCapabilities: ['image-output'],
        priority: 2,
      }),
    ).rejects.toMatchObject<Partial<RelayError>>({ code: 'recipient_lacks_capability' });
  });

  it('claims the most urgent task first, then the oldest', async () => {
    const store = await storeWithPair();
    await post(store, 'Normal, older', 2);
    await post(store, 'Urgent', 3);
    await post(store, 'Normal, newer', 2);

    const order = [];
    for (let index = 0; index < 3; index += 1) order.push((await store.claimNextTask('receiver', 300))?.title);
    expect(order).toEqual(['Urgent', 'Normal, older', 'Normal, newer']);
  });

  it('wakes a long-polling recipient when a new task arrives', async () => {
    const store = await storeWithPair();
    const waiting = store.waitForTask('receiver', 500, 300);
    await sleep(20);
    await post(store, 'Wake the listener');

    await expect(waiting).resolves.toMatchObject({ title: 'Wake the listener', status: 'claimed' });
  });

  it('does not miss a task posted while the first claim attempt is in progress', async () => {
    const store = await storeWithPair();
    const started = Date.now();
    const waiting = store.waitForTask('receiver', 5_000, 300);
    await post(store, 'Racing task');

    await expect(waiting).resolves.toMatchObject({ title: 'Racing task', status: 'claimed' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('keeps waiting for the remaining time after a wake-up that yields no task', async () => {
    const store = await storeWithPair();
    const first = store.waitForTask('receiver', 3_000, 300);
    const second = store.waitForTask('receiver', 3_000, 300);
    await sleep(20);
    await post(store, 'Task A');
    await sleep(100);
    await post(store, 'Task B');

    const titles = (await Promise.all([first, second])).map((task) => task?.title).sort();
    expect(titles).toEqual(['Task A', 'Task B']);
  });

  it('requeues an expired lease during maintenance even if the recipient never polls again', async () => {
    const store = await storeWithPair();
    const task = await post(store, 'Abandoned work');
    await store.claimNextTask('receiver', 0.05);
    await sleep(80);

    expect(await store.runMaintenance()).toMatchObject({ requeued: 1 });
    expect((await store.getTask('sender', task.id)).status).toBe('queued');
    const { updates } = await store.readUpdates('sender', 10);
    expect(updates.map((update) => update.type)).toEqual(['task-claimed', 'task-requeued']);
  });

  it('lets the sender requeue a blocked task', async () => {
    const store = await storeWithPair();
    const task = await post(store, 'Needs a key');
    await store.claimNextTask('receiver', 300);
    await store.reportTask({ reporterSlug: 'receiver', taskId: task.id, kind: 'blocked', message: 'Missing API key.' });

    await expect(store.requeueTask('receiver', task.id, 'Not mine')).rejects.toMatchObject({ code: 'task_requeue_denied' });
    const requeued = await store.requeueTask('sender', task.id, 'Key added to the vault.');
    expect(requeued.status).toBe('queued');
    expect((await store.readUpdates('receiver', 10)).updates.at(-1)?.type).toBe('task-requeued');
    expect((await store.claimNextTask('receiver', 300))?.id).toBe(task.id);
    await expect(store.requeueTask('sender', task.id, 'Again')).rejects.toMatchObject({ code: 'invalid_task_state' });
  });

  it('prunes finished tasks past the retention window but keeps open ones', async () => {
    const store = await storeWithPair({ taskRetentionMs: 0 });
    const done = await post(store, 'Finished');
    const open = await post(store, 'Still open');
    await store.claimNextTask('receiver', 300);
    await store.reportTask({ reporterSlug: 'receiver', taskId: done.id, kind: 'completed', message: 'Done.' });

    expect(await store.runMaintenance()).toMatchObject({ pruned: 1 });
    await expect(store.getTask('sender', done.id)).rejects.toMatchObject({ code: 'unknown_task' });
    expect((await store.getTask('sender', open.id)).status).toBe('queued');
  });

  it('numbers the steps of worker runs in order and removes them with their task', async () => {
    const store = await storeWithPair({ taskRetentionMs: 0 });
    const task = await post(store, 'Run me');
    const at = new Date().toISOString();
    await store.appendActivity(task.id, [
      { at, kind: 'start', text: 'Started' },
      { at, kind: 'command', text: 'npm test', status: 'running', ref: 'r:1' },
    ]);
    const [update] = await store.appendActivity(task.id, [{ at, kind: 'command', text: 'npm test', status: 'ok', ref: 'r:1', detail: 'passed' }]);
    expect(update!.seq).toBe(3);
    expect((await store.listActivity(task.id)).map((entry) => [entry.seq, entry.kind, entry.status ?? null])).toEqual([
      [1, 'start', null],
      [2, 'command', 'running'],
      [3, 'command', 'ok'],
    ]);

    await store.claimNextTask('receiver', 300);
    await store.reportTask({ reporterSlug: 'receiver', taskId: task.id, kind: 'completed', message: 'Done.' });
    await store.runMaintenance();
    expect(await store.listActivity(task.id)).toEqual([]);
  });

  it('persists every concurrent mutation', async () => {
    const store = await newStore();
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.registerAgent({ slug: `agent-${index}`, displayName: `Agent ${index}`, modelSlug: 'model', capabilities: ['text-output'] }),
      ),
    );

    const restored = open(temporaryDirectories[0]!);
    expect(await restored.listAgents(true)).toHaveLength(25);
  });

  it('flags readers whose cursor fell behind the trimmed event journal', async () => {
    const store = await storeWithPair({ maxEvents: 2 });
    for (const title of ['One', 'Two', 'Three']) {
      const task = await post(store, title);
      await store.claimNextTask('receiver', 300);
      await store.reportTask({ reporterSlug: 'receiver', taskId: task.id, kind: 'completed', message: `${title} done.` });
    }

    const first = await store.readUpdates('sender', 10);
    expect(first.mayHaveMissedUpdates).toBe(true);
    expect(first.updates).toHaveLength(2);
    expect((await store.readUpdates('sender', 10)).mayHaveMissedUpdates).toBeUndefined();
  });

  it('returns a waiting long-poll promptly when the store closes', async () => {
    const store = await storeWithPair();
    const started = Date.now();
    const waiting = store.waitForTask('receiver', 10_000, 300);
    await sleep(20);
    await store.close();

    await expect(waiting).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('issues, rotates, and revokes per-agent tokens without storing them', async () => {
    const store = await newStore();
    const { agent, token } = await store.createAgent({ slug: 'worker', displayName: 'Worker', modelSlug: 'm', capabilities: ['text-output'] });
    expect(agent.hasToken).toBe(true);
    expect(token).toMatch(/^cca_/);
    expect(store.authenticateAgentToken(token!)).toBe('worker');
    expect(store.authenticateAgentToken('cca_wrong')).toBeUndefined();

    const rotated = await store.issueToken('worker');
    expect(store.authenticateAgentToken(token!)).toBeUndefined();
    expect(store.authenticateAgentToken(rotated)).toBe('worker');

    await store.revokeToken('worker');
    expect(store.authenticateAgentToken(rotated)).toBeUndefined();
    expect((await store.getAgent('worker')).hasToken).toBe(false);
    await expect(store.createAgent({ slug: 'worker', displayName: 'W', modelSlug: 'm', capabilities: ['x'] })).rejects.toMatchObject({
      code: 'agent_exists',
    });
  });

  it('creates the human operator once and never gives it a token', async () => {
    const store = await newStore();
    await store.ensureOperator('operator');
    await store.ensureOperator('operator');
    const operator = await store.getAgent('operator');
    expect(operator).toMatchObject({ kind: 'human', hasToken: false });
    await expect(store.issueToken('operator')).rejects.toMatchObject({ code: 'invalid_agent_kind' });
  });

  it('refuses to delete an agent with open tasks', async () => {
    const store = await storeWithPair();
    const task = await post(store, 'Open work');
    await expect(store.deleteAgent('receiver')).rejects.toMatchObject({ code: 'agent_has_open_tasks' });
    await store.cancelTask('sender', task.id, 'Not needed.');
    await store.deleteAgent('receiver');
    await expect(store.getAgent('receiver')).rejects.toMatchObject({ code: 'unknown_agent' });
  });

  it('lists tasks by status, agent, and title, and reports stats', async () => {
    const store = await storeWithPair();
    await post(store, 'Write the release notes');
    const stillQueued = await post(store, 'Fix the flaky test');
    // Claims the older task, the release notes.
    await store.claimNextTask('receiver', 300);

    expect((await store.listTasks({ statuses: ['queued'] })).map((task) => task.title)).toEqual(['Fix the flaky test']);
    expect((await store.listTasks({ search: 'FLAKY' })).map((task) => task.id)).toEqual([stillQueued.id]);
    expect(await store.listTasks({ agentSlug: 'nobody' })).toEqual([]);
    expect((await store.stats()).tasks).toMatchObject({ queued: 1, claimed: 1, completed: 0 });
    expect((await store.listEvents({ limit: 10 }))[0]?.type).toBe('task-claimed');
  });

  it('summarizes each task with its latest report, shortened', async () => {
    const store = await storeWithPair();
    const task = await post(store, 'Long running');
    await store.claimNextTask('receiver', 300);
    const changes: RelayChange[] = [];
    store.subscribe((change) => changes.push(change));
    await store.reportTask({ reporterSlug: 'receiver', taskId: task.id, kind: 'progress', message: 'First step done.' });
    await store.reportTask({ reporterSlug: 'receiver', taskId: task.id, kind: 'progress', message: `Second\n\nstep ${'x'.repeat(400)}` });

    const [summary] = await store.listTasks({ statuses: ['claimed'] });
    expect(summary?.reportCount).toBe(2);
    expect(summary?.latestReport).toMatchObject({ kind: 'progress' });
    expect(summary?.latestReport?.message.startsWith('Second step x')).toBe(true);
    expect(summary?.latestReport?.message.length).toBe(280);

    const streamed = changes.filter((change) => change.type === 'task').at(-1);
    expect(streamed).toMatchObject({ type: 'task', task: { latestReport: { message: summary?.latestReport?.message } } });
    expect((await store.getTaskById(task.id)) as object).not.toHaveProperty('latestReport');
  });

  it('notifies subscribers only after a change commits', async () => {
    const store = await storeWithPair();
    const changes: RelayChange[] = [];
    store.subscribe((change) => changes.push(change));

    await expect(store.cancelTask('sender', '00000000-0000-4000-8000-000000000000', 'x')).rejects.toBeInstanceOf(RelayError);
    expect(changes).toEqual([]);

    const task = await post(store, 'Visible change');
    expect(changes).toContainEqual(expect.objectContaining({ type: 'task', task: expect.objectContaining({ id: task.id, status: 'queued' }) }));
  });

  it('lets an agent enroll itself with an invite, within its limits', async () => {
    const store = await newStore();
    const profile = { displayName: 'Worker', modelSlug: 'm', capabilities: ['text-output'] };
    const { invite, code } = await store.createInvite({ label: 'Laptop', expiresInMs: 60_000, maxUses: 2 });
    expect(code).toMatch(/^cci_/);
    expect(invite).toMatchObject({ label: 'Laptop', uses: 0, maxUses: 2, active: true, agents: [] });

    const { agent, token } = await store.enroll(code, { ...profile, slug: 'worker-one' });
    expect(agent).toMatchObject({ slug: 'worker-one', hasToken: true });
    expect(store.authenticateAgentToken(token)).toBe('worker-one');

    // A taken slug fails without using up the invite.
    await expect(store.enroll(code, { ...profile, slug: 'worker-one' })).rejects.toMatchObject({ code: 'agent_exists' });
    await store.enroll(code, { ...profile, slug: 'worker-two' });

    const [used] = await store.listInvites();
    expect(used).toMatchObject({ uses: 2, active: false, agents: ['worker-one', 'worker-two'] });
    await expect(store.enroll(code, { ...profile, slug: 'worker-three' })).rejects.toMatchObject({ code: 'invalid_invite' });
    await expect(store.enroll('cci_wrong', { ...profile, slug: 'worker-four' })).rejects.toMatchObject({ code: 'invalid_invite' });
  });

  it('applies the name, role, and first task chosen on the invite', async () => {
    const store = await newStore();
    await store.ensureOperator('operator');
    const { code } = await store.createInvite({
      expiresInMs: 60_000,
      maxUses: 2,
      displayName: 'Backend reviewer',
      role: 'Reviews backend pull requests for correctness and security.',
      firstTask: { title: 'Review PR #12', instructions: 'Check the retry logic.', priority: 3 },
    });
    const profile = { displayName: 'Whatever I like', modelSlug: 'm', capabilities: ['text-output'], details: 'I do everything.' };

    const first = await store.enroll(code, { ...profile, slug: 'reviewer-a' }, 'operator');
    expect(first.agent).toMatchObject({
      displayName: 'Backend reviewer',
      details: 'Reviews backend pull requests for correctness and security.',
      ownerSet: { displayName: true, details: true },
    });
    expect(first.assignedTask).toMatchObject({ title: 'Review PR #12', senderSlug: 'operator', recipientSlug: 'reviewer-a', priority: 3, status: 'queued' });

    // Each agent that joins gets its own copy of the first task.
    const second = await store.enroll(code, { ...profile, slug: 'reviewer-b' }, 'operator');
    expect(second.assignedTask?.id).not.toBe(first.assignedTask?.id);
    expect((await store.claimNextTask('reviewer-b', 300))?.title).toBe('Review PR #12');

    // Re-registering keeps what the owner chose but updates everything else.
    const refreshed = await store.registerAgent({ ...profile, slug: 'reviewer-a', modelSlug: 'new-model' });
    expect(refreshed).toMatchObject({ displayName: 'Backend reviewer', details: 'Reviews backend pull requests for correctness and security.', modelSlug: 'new-model' });

    expect((await store.listInvites())[0]).toMatchObject({ displayName: 'Backend reviewer', firstTask: { title: 'Review PR #12' } });
  });

  it('lets the owner rename an agent and set its role, and keeps them on re-registration', async () => {
    const store = await storeWithPair();
    const updated = await store.updateAgentProfile('receiver', { displayName: 'Data wrangler', details: 'Cleans and joins CSV exports.' });
    expect(updated).toMatchObject({ displayName: 'Data wrangler', ownerSet: { displayName: true, details: true } });

    await store.registerAgent({ slug: 'receiver', displayName: 'receiver', modelSlug: 'm', capabilities: ['text-output'], details: 'Self description' });
    expect(await store.getAgent('receiver')).toMatchObject({ displayName: 'Data wrangler', details: 'Cleans and joins CSV exports.' });

    // Clearing the role hands it back to the agent.
    await store.updateAgentProfile('receiver', { details: null });
    await store.registerAgent({ slug: 'receiver', displayName: 'receiver', modelSlug: 'm', capabilities: ['text-output'], details: 'Self description' });
    expect(await store.getAgent('receiver')).toMatchObject({ displayName: 'Data wrangler', details: 'Self description', ownerSet: { displayName: true, details: false } });
  });

  it('rejects expired and revoked invites', async () => {
    const store = await newStore();
    const profile = { displayName: 'Worker', modelSlug: 'm', capabilities: ['text-output'] };
    const expired = await store.createInvite({ expiresInMs: 20 });
    await sleep(40);
    await expect(store.enroll(expired.code, { ...profile, slug: 'late' })).rejects.toMatchObject({ code: 'invalid_invite' });

    const revoked = await store.createInvite({ expiresInMs: 60_000 });
    expect((await store.revokeInvite(revoked.invite.id)).active).toBe(false);
    await expect(store.enroll(revoked.code, { ...profile, slug: 'nope' })).rejects.toMatchObject({ code: 'invalid_invite' });
    await expect(store.getAgent('nope')).rejects.toMatchObject({ code: 'unknown_agent' });
  });

  it('upgrades a version 1 database in place', async () => {
    const directory = await newDirectory();
    const { DatabaseSync } = await import('node:sqlite');
    const legacy = new DatabaseSync(join(directory, 'relay.db'));
    legacy.exec(`
      CREATE TABLE agents (slug TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'agent', display_name TEXT NOT NULL, model_slug TEXT NOT NULL,
        capabilities TEXT NOT NULL, details TEXT, registered_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        last_read_sequence INTEGER NOT NULL DEFAULT 0, token_hash TEXT UNIQUE);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, sender_slug TEXT NOT NULL, recipient_slug TEXT NOT NULL, title TEXT NOT NULL,
        instructions TEXT NOT NULL, required_capabilities TEXT NOT NULL, priority INTEGER NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, claimed_at TEXT, lease_expires_at TEXT);
      CREATE TABLE reports (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE, kind TEXT NOT NULL,
        message TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL);
      CREATE TABLE events (sequence INTEGER PRIMARY KEY, recipient_slug TEXT NOT NULL, type TEXT NOT NULL, task_id TEXT NOT NULL,
        summary TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO agents (slug, display_name, model_slug, capabilities, registered_at, last_seen_at)
        VALUES ('veteran', 'Veteran', 'm', '["text-output"]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const store = open(directory);
    expect((await store.getAgent('veteran')).displayName).toBe('Veteran');
    const { code } = await store.createInvite({ expiresInMs: 60_000 });
    await store.enroll(code, { slug: 'newcomer', displayName: 'Newcomer', modelSlug: 'm', capabilities: ['text-output'] });
    expect((await store.listInvites())[0]?.agents).toEqual(['newcomer']);
  });

  it('imports the JSON ledger written by earlier versions', async () => {
    const directory = await newDirectory();
    const time = '2026-09-01T00:00:00.000Z';
    await writeFile(
      join(directory, 'relay-state.json'),
      JSON.stringify({
        version: 1,
        agents: {
          old: { slug: 'old', displayName: 'Old', modelSlug: 'm', capabilities: ['text-output'], registeredAt: time, lastSeenAt: time, lastReadSequence: 0 },
        },
        tasks: {
          '11111111-1111-4111-8111-111111111111': {
            id: '11111111-1111-4111-8111-111111111111',
            senderSlug: 'old',
            recipientSlug: 'old',
            title: 'Legacy task',
            instructions: 'Carry me over.',
            requiredCapabilities: [],
            priority: 2,
            status: 'completed',
            createdAt: time,
            updatedAt: time,
            reports: [{ id: 'r1', kind: 'completed', message: 'Done.', result: 'All good.', createdAt: time }],
          },
        },
        events: [{ sequence: 7, recipientSlug: 'old', type: 'task-completed', taskId: '11111111-1111-4111-8111-111111111111', summary: 'old: Done.', createdAt: time }],
        nextSequence: 8,
      }),
    );

    const store = open(directory);
    const task = await store.getTask('old', '11111111-1111-4111-8111-111111111111');
    expect(task).toMatchObject({ title: 'Legacy task', status: 'completed' });
    expect(task.reports[0]?.result).toBe('All good.');
    expect((await store.readUpdates('old', 10)).updates.map((update) => update.sequence)).toEqual([7]);
    expect(existsSync(join(directory, 'relay-state.json'))).toBe(false);
    expect(existsSync(join(directory, 'relay-state.json.migrated'))).toBe(true);
  });
});
