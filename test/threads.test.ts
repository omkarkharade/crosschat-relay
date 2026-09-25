import '../src/quiet-sqlite-warning.js';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { changes, snapshot } from '../src/snapshot.js';
import { RelayStore } from '../src/store.js';

const directories: string[] = [];
const stores: RelayStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'crosschat-threads-'));
  directories.push(path);
  return path;
}

async function relay(): Promise<RelayStore> {
  const store = new RelayStore(await directory());
  stores.push(store);
  await store.init();
  for (const slug of ['alice', 'bob', 'carol']) await store.registerAgent({ slug, displayName: slug, modelSlug: 'm', capabilities: ['text-output'] });
  return store;
}

const task = (from: string, to: string, title: string, extra: { parentTaskId?: string; enforceChainLimit?: boolean } = {}) => ({
  senderSlug: from,
  recipientSlug: to,
  title,
  instructions: title,
  requiredCapabilities: [],
  priority: 2 as const,
  ...extra,
});

describe('hand-offs between agents', () => {
  it('links a task to the task it was handed off from and counts how deep the chain goes', async () => {
    const store = await relay();
    const first = await store.postTask(task('alice', 'bob', 'Build the level'));
    const second = await store.postTask(task('bob', 'carol', 'Draw the tiles', { parentTaskId: first.id, enforceChainLimit: true }));
    expect(first.depth).toBe(0);
    expect(second).toMatchObject({ parentTaskId: first.id, depth: 1 });
    const related = await store.relatedTasks(first.id);
    expect(related.children.map((child) => child.title)).toEqual(['Draw the tiles']);
    expect((await store.relatedTasks(second.id)).parent?.title).toBe('Build the level');
  });

  it('refuses a worker hand-off past the limit, but not a link someone makes by hand', async () => {
    const store = await relay();
    await store.setChainLimit(1);
    const first = await store.postTask(task('alice', 'bob', 'One'));
    const second = await store.postTask(task('bob', 'carol', 'Two', { parentTaskId: first.id, enforceChainLimit: true }));
    await expect(store.postTask(task('carol', 'bob', 'Three', { parentTaskId: second.id, enforceChainLimit: true }))).rejects.toMatchObject({ code: 'chain_limit' });
    expect((await store.postTask(task('carol', 'bob', 'Three', { parentTaskId: second.id }))).depth).toBe(2);
    expect(store.chainLimit()).toBe(1);
  });

  it('only links tasks the sender took part in', async () => {
    const store = await relay();
    const private_ = await store.postTask(task('alice', 'bob', 'Private'));
    await expect(store.postTask(task('carol', 'alice', 'Sneaky', { parentTaskId: private_.id }))).rejects.toMatchObject({ code: 'task_access_denied' });
  });

  it('knows the task a worker run token is working on', async () => {
    const store = await relay();
    const first = await store.postTask(task('alice', 'bob', 'Run me'));
    const token = await store.issueRunToken('bob', first.id, 60_000);
    expect(store.resolveAgentToken(token)).toEqual({ slug: 'bob', runTaskId: first.id });
    expect(store.authenticateAgentToken(token)).toBe('bob');
  });
});

describe('asking for changes', () => {
  it('reopens a finished task with its history, for its sender only', async () => {
    const store = await relay();
    const posted = await store.postTask(task('alice', 'bob', 'Draw a fan'));
    await store.claimNextTask('bob', 300);
    await store.reportTask({ reporterSlug: 'bob', taskId: posted.id, kind: 'completed', message: 'Done.', result: 'fan.png' });

    await expect(store.requestChanges('bob', posted.id, 'Nope')).rejects.toMatchObject({ code: 'task_changes_denied' });
    const reopened = await store.requestChanges('alice', posted.id, 'Make the blades blur.');
    expect(reopened.status).toBe('queued');
    expect(reopened.reports.map((report) => report.kind)).toEqual(['completed', 'changes']);
    await expect(store.requestChanges('alice', posted.id, 'Again')).rejects.toMatchObject({ code: 'invalid_task_state' });
    expect((await store.claimNextTask('bob', 300))?.id).toBe(posted.id);
  });
});

describe('who picks up a task', () => {
  it('records whether a worker or a chat claimed it, and clears it when the task goes back', async () => {
    const store = await relay();
    const posted = await store.postTask(task('alice', 'bob', 'Anything'));
    expect((await store.claimNextTask('bob', 300, undefined, 'worker'))?.claimedVia).toBe('worker');
    expect((await store.releaseTask('bob', posted.id, 'Later')).claimedVia).toBeUndefined();
    expect((await store.claimNextTask('bob', 300))?.claimedVia).toBe('chat');
  });

  it('sends an agent\'s tasks only to its worker when the worker is on and set to', async () => {
    const store = await relay();
    const worker = { agentSlug: 'bob', harness: 'custom', command: 'x', args: [], promptMode: 'stdin' as const, workdir: '.', allowedSenders: ['alice'], timeoutMinutes: 5, enabled: true, extraDirs: [], maxRunsPerHour: 20, exclusive: false };
    await store.saveWorkerConfig(worker);
    expect(store.workerOnly('bob')).toBe(false);
    await store.saveWorkerConfig({ ...worker, exclusive: true });
    expect(store.workerOnly('bob')).toBe(true);
    await store.saveWorkerConfig({ ...worker, exclusive: true, enabled: false });
    expect(store.workerOnly('bob')).toBe(false);
    expect(store.workerOnly('carol')).toBe(false);
  });
});

describe('files a run changed', () => {
  it('finds added, changed, and deleted files, and skips folders like node_modules', async () => {
    const root = await directory();
    await writeFile(join(root, 'keep.txt'), 'a');
    await writeFile(join(root, 'edit.txt'), 'a');
    await writeFile(join(root, 'gone.txt'), 'a');
    await mkdir(join(root, 'node_modules'));
    const before = await snapshot([root]);

    await writeFile(join(root, 'edit.txt'), 'a longer text');
    await rm(join(root, 'gone.txt'));
    await mkdir(join(root, 'art'));
    await writeFile(join(root, 'art', 'new.png'), 'png');
    await writeFile(join(root, 'node_modules', 'ignored.js'), 'x');
    const after = await snapshot([root]);

    expect(after.complete).toBe(true);
    const found = changes(before, after).map((file) => `${file.change}:${file.path.slice(root.length + 1)}`);
    expect(found.sort()).toEqual(['added:' + join('art', 'new.png'), 'changed:edit.txt', 'deleted:gone.txt']);
  });

  it('records the files with the run and can tell which files a task changed', async () => {
    const store = await relay();
    const posted = await store.postTask(task('alice', 'bob', 'Draw'));
    await store.appendActivity(posted.id, [{ at: new Date().toISOString(), kind: 'files', text: 'Files: 1 added', files: [{ path: '/art/fan.png', change: 'added', size: 3 }] }]);
    expect((await store.listActivity(posted.id))[0]?.files).toEqual([{ path: '/art/fan.png', change: 'added', size: 3 }]);
    expect(await store.taskChangedFile(posted.id, '/art/fan.png')).toBe(true);
    expect(await store.taskChangedFile(posted.id, '/etc/passwd')).toBe(false);
  });
});
