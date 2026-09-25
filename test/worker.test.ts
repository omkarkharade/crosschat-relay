import '../src/quiet-sqlite-warning.js';

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { buildTaskPrompt, WorkerManager } from '../src/worker.js';
import { RelayStore, type Task, type WorkerConfig } from '../src/store.js';

const FAKE_HARNESS = fileURLToPath(new URL('./fixtures/fake-harness.mjs', import.meta.url));
const cleanups: Array<() => Promise<void>> = [];

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Setup {
  store: RelayStore;
  workers: WorkerManager;
  workdir: string;
  post: (title: string, mode?: string, sender?: string) => Promise<Task>;
}

async function setup(overrides: Partial<WorkerConfig> = {}): Promise<Setup> {
  const directory = await mkdtemp(join(tmpdir(), 'crosschat-worker-'));
  const store = new RelayStore(join(directory, 'data'));
  await store.init();
  await store.ensureOperator('operator');
  for (const slug of ['builder', 'stranger']) {
    await store.createAgent({ slug, displayName: slug === 'builder' ? 'Builder' : 'Stranger', modelSlug: 'm', capabilities: ['text-output'] });
  }
  await store.saveWorkerConfig({
    agentSlug: 'builder',
    harness: 'custom',
    command: process.execPath,
    args: [FAKE_HARNESS],
    promptMode: 'stdin',
    workdir: directory,
    allowedSenders: ['operator'],
    timeoutMinutes: 1,
    enabled: true,
    extraDirs: [],
    maxRunsPerHour: 20,
    exclusive: false,
    ...overrides,
  });
  const workers = new WorkerManager(store, { mcpUrl: 'http://localhost:1/mcp', runDirectory: join(directory, 'runs') });
  await workers.start();
  cleanups.push(async () => {
    await workers.stop();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const post = (title: string, mode = 'done', sender = 'operator') =>
    store.postTask({ senderSlug: sender, recipientSlug: 'builder', title, instructions: `Please do it. MODE:${mode}`, requiredCapabilities: [], priority: 2 });
  return { store, workers, workdir: directory, post };
}

/** Wait until the task leaves the queue and its worker run finishes. */
async function settled(store: RelayStore, id: string, timeoutMs = 15_000): Promise<Task> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const task = await store.getTaskById(id);
    if (task.status === 'completed' || task.status === 'blocked' || task.status === 'cancelled') return task;
    if (Date.now() > deadline) throw new Error(`Task stayed ${task.status}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('workers', () => {
  it('runs a task with the harness and reports its answer as the result', async () => {
    const { store, post, workdir } = await setup();
    const task = await settled(store, (await post('Build the thing')).id);
    expect(task.status).toBe('completed');
    const result = task.reports.at(-1)?.result ?? '';
    expect(result).toContain('Done by builder in');
    expect(result).toContain(workdir.split(/[\\/]/).at(-1));
    // The harness got a short-lived run token and the full task prompt.
    expect(result).toContain('token:run');
    expect(result).toContain('prompt-has-title:true');
    // Run tokens are revoked when the run ends.
    expect(store.authenticateAgentToken('ccr_anything')).toBeUndefined();
  });

  it('turns a BLOCKED: answer into a blocker', async () => {
    const { store, post } = await setup();
    const task = await settled(store, (await post('Needs a key', 'block')).id);
    expect(task.status).toBe('blocked');
    expect(task.reports.at(-1)?.message).toBe('I need the API key for the image service.');
  });

  it('reports a crash as a blocker with the end of the output', async () => {
    const { store, post } = await setup();
    const task = await settled(store, (await post('Crashes', 'fail')).id);
    expect(task.status).toBe('blocked');
    expect(task.reports.at(-1)?.message).toContain('exited with code 3');
    expect(task.reports.at(-1)?.message).toContain('out of memory');
  });

  it('stops a harness that runs past its time limit', async () => {
    const { store, post } = await setup({ timeoutMinutes: 0.02 });
    const task = await settled(store, (await post('Takes forever', 'sleep')).id, 20_000);
    expect(task.status).toBe('blocked');
    expect(task.reports.at(-1)?.message).toContain('without finishing');
  });

  it('reads the answer from the result file when the command uses one', async () => {
    const { store, workers, post } = await setup();
    await store.saveWorkerConfig({
      ...(await store.getWorkerConfig('builder'))!,
      args: [FAKE_HARNESS, '{prompt_file}', '--out', '{result_file}'],
      promptMode: 'file',
    });
    // Apply the new configuration, as the dashboard does on save.
    await workers.reload('builder');
    const task = await settled(store, (await post('Write a file', 'file')).id);
    expect(task.reports.at(-1)?.result).toBe('Answer written to the result file.');
  });

  it('leaves tasks from senders that are not allowed in the queue', async () => {
    const { store, post } = await setup();
    const fromStranger = await post('From someone else', 'done', 'stranger');
    const fromOperator = await post('From the operator');
    await settled(store, fromOperator.id);
    expect((await store.getTaskById(fromStranger.id)).status).toBe('queued');
  });

  it('pauses and resumes', async () => {
    const { store, workers, post } = await setup();
    await workers.setPaused(true);
    expect(workers.status('builder')?.state).toBe('paused');
    const task = await post('Wait for me');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect((await store.getTaskById(task.id)).status).toBe('queued');
    await workers.setPaused(false);
    expect((await settled(store, task.id)).status).toBe('completed');
  });

  it('stops the harness when the sender cancels the task', async () => {
    const { store, post } = await setup({ timeoutMinutes: 5 });
    const task = await post('Cancel me', 'sleep');
    const deadline = Date.now() + 10_000;
    while ((await store.getTaskById(task.id)).status !== 'claimed' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    await store.cancelTask('operator', task.id, 'Changed my mind.');
    expect((await settled(store, task.id)).status).toBe('cancelled');
  }, 30_000);

  it('records the run as steps for the live view, without the run token', async () => {
    const { store, post } = await setup();
    const changes: string[] = [];
    store.subscribe((change) => change.type === 'activity' && changes.push(change.taskId));
    const task = await settled(store, (await post('Talk a lot', 'chatty')).id);
    expect(task.status).toBe('completed');
    const entries = await store.listActivity(task.id);
    expect(entries[0]).toMatchObject({ seq: 1, kind: 'start' });
    expect(entries.at(-1)).toMatchObject({ kind: 'end', status: 'ok' });
    const output = entries.filter((entry) => entry.kind === 'output').map((entry) => entry.text).join('\n');
    expect(output).toContain('step one');
    expect(output).toContain('warning: token [hidden]');
    expect(output).not.toContain('ccr_');
    expect(changes).toContain(task.id);
  });

  it('shows the files a run wrote, in the working folder and its extra folders', async () => {
    // Folders of their own: the default working folder also holds this test relay's database.
    const workdir = await mkdtemp(join(tmpdir(), 'crosschat-work-'));
    const extra = await mkdtemp(join(tmpdir(), 'crosschat-extra-'));
    cleanups.push(() => Promise.all([workdir, extra].map((dir) => rm(dir, { recursive: true, force: true }))).then(() => undefined));
    const { store, post } = await setup({ workdir, extraDirs: [extra] });
    const task = await settled(store, (await post('Deliver files', 'write')).id);
    expect(task.status).toBe('completed');
    const step = (await store.listActivity(task.id)).find((entry) => entry.kind === 'files');
    expect(step?.files?.map((file) => `${file.change}:${file.path}`).sort()).toEqual([`added:${join(extra, 'delivered.png')}`, `added:${join(workdir, 'made-by-run.txt')}`]);
    expect(await store.taskChangedFile(task.id, join(extra, 'delivered.png'))).toBe(true);
  });

  it('after a restart, stops a harness left running and puts its task back in the queue', async () => {
    const { store, workers, post, workdir } = await setup({ timeoutMinutes: 5 });
    const task = await post('Interrupted', 'sleep');
    const deadline = Date.now() + 10_000;
    while ((await store.getTaskById(task.id)).status !== 'claimed' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const runFolder = join(workdir, 'runs', task.id);
    while (!existsSync(join(runFolder, 'process')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const [pid] = readFileSync(join(runFolder, 'process'), 'utf8').split('\n');

    // A relay that dies mid-run leaves its run folder and harness behind; a new one starts up.
    await workers.setPaused(true);
    const restarted = new WorkerManager(store, { mcpUrl: 'http://localhost:1/mcp', runDirectory: join(workdir, 'runs') });
    await restarted.start();
    cleanups.push(() => restarted.stop());

    const recovered = await store.getTaskById(task.id);
    expect(recovered.status).toBe('queued');
    expect(recovered.reports.at(-1)?.message).toContain('relay restarted');
    expect(existsSync(runFolder)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(isRunning(Number(pid))).toBe(false);
  }, 30_000);

  it('holds tasks in the queue once a worker reaches its hourly limit', async () => {
    const { store, workers, post } = await setup({ maxRunsPerHour: 1 });
    await settled(store, (await post('First')).id);
    const second = await post('Second');
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect((await store.getTaskById(second.id)).status).toBe('queued');
    expect(workers.status('builder')).toMatchObject({ state: 'limited' });
    expect(Date.parse(workers.status('builder')!.resumesAt!)).toBeGreaterThan(Date.now() + 55 * 60 * 1000);
  });

  it('gives a reopened task its earlier result and the changes asked for, and the hand-offs left', () => {
    const prompt = buildTaskPrompt(
      {
        id: 't',
        title: 'Draw a fan',
        instructions: 'Top-down.',
        priority: 2,
        senderSlug: 'operator',
        reports: [
          { id: '1', kind: 'completed', message: 'Done.', result: 'Saved fan.png', createdAt: '' },
          { id: '2', kind: 'changes', message: 'Blur the blades.', createdAt: '' },
        ],
      },
      { slug: 'artist', displayName: 'Artist' },
      'Operator',
      { relayServer: 'crosschat-run', handOffsLeft: 0, extraDirs: ['/game/assets'], parentTitle: 'Build the house' },
    );
    expect(prompt).toContain('Your earlier result: Saved fan.png');
    expect(prompt).toContain('Changes requested: Blur the blades.');
    expect(prompt).toContain('your final answer replaces the earlier result');
    expect(prompt).toContain('/game/assets');
    expect(prompt).toContain('part of "Build the house"');
    expect(prompt).toContain('do not post tasks to other agents');
    expect(prompt).toContain('request_changes');
  });

  it('writes a prompt that tells the harness how to finish or report a blocker', () => {
    const prompt = buildTaskPrompt(
      { id: 't', title: 'Draw a map', instructions: 'Top-down, 64 px tiles.', priority: 3, senderSlug: 'operator' },
      { slug: 'artist', displayName: 'Artist', details: 'Makes game art.' },
      'Operator',
      { relayServer: 'crosschat-run' },
    );
    expect(prompt).toContain('## Task: Draw a map');
    expect(prompt).toContain('priority: urgent');
    expect(prompt).toContain('Your role: Makes game art.');
    expect(prompt).toContain('BLOCKED:');
    expect(prompt).toContain('post_task');
    expect(prompt).toContain('MCP server named "crosschat-run"');
  });
});
