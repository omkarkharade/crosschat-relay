import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { ActivityRecorder, createParser, type ChangedFile, type OutputParser } from './activity.js';
import { CUSTOM_HARNESS, findPreset, resolveInvocation, RUN_SERVER, type RunContext, type RunSpec } from './harnesses.js';
import { changes, snapshot } from './snapshot.js';
import type { RelayStore, Task, WorkerConfig, WorkerStatus } from './store.js';

/**
 * Workers make agents on this computer work unattended. For each agent with a
 * worker, the relay waits for tasks from allowed senders, runs the agent's
 * harness headless in its working folder, keeps the task's lease alive, and
 * reports the result (or a blocker) itself, so no task is left claimed and
 * silent. Any command-line harness works: presets supply the right flags, and
 * a custom command covers the rest.
 */

const LEASE_SECONDS = 15 * 60;
const RENEW_EVERY_MS = 5 * 60 * 1000;
const CANCEL_CHECK_MS = 10 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_RESULT_CHARS = 39_000;
const PAUSED_KEY = 'workers.paused';
const HOUR_MS = 60 * 60 * 1000;
const execFileAsync = promisify(execFile);

export interface WorkerManagerOptions {
  /** The relay's MCP endpoint as seen from this computer. */
  mcpUrl: string;
  /** Where per-run files go (prompt, result, MCP config). */
  runDirectory?: string;
}

export class WorkerManager {
  private readonly loops = new Map<string, WorkerLoop>();
  private paused = false;
  private stopped = false;

  constructor(
    private readonly store: RelayStore,
    private readonly options: WorkerManagerOptions,
  ) {}

  async start(): Promise<void> {
    this.paused = (await this.store.getSetting(PAUSED_KEY)) === 'true';
    await this.recoverInterruptedRuns();
    for (const config of await this.store.listWorkerConfigs()) this.startLoop(config);
  }

  /**
   * Clean up after runs the relay didn't see finish (it crashed, or was stopped
   * or updated mid-run). A harness left running can't report back, so it is
   * stopped, and its task goes back to the queue to run again, instead of
   * sitting claimed until the lease expires while a second copy starts.
   */
  private async recoverInterruptedRuns(): Promise<void> {
    const root = runRoot(this.options);
    for (const taskId of await readdir(root).catch(() => [] as string[])) {
      const directory = join(root, taskId);
      const [pid, image] = (await readFile(join(directory, 'process'), 'utf8').catch(() => '')).split('\n');
      if (pid && image) await stopLeftover(Number(pid), image);
      const task = await this.store.getTaskById(taskId).catch(() => undefined);
      if (task?.status === 'claimed' && task.claimedVia === 'worker') {
        await this.store
          .releaseTask(task.recipientSlug, task.id, 'The relay restarted while its worker was running this task, so it will run again.')
          .catch(() => undefined);
      }
      await this.store.revokeRunTokens(taskId).catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }


  /** Stop every loop and any harness that is running. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.loops.values()].map((loop) => loop.stop()));
    this.loops.clear();
  }

  isPaused(): boolean {
    return this.paused;
  }

  async setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
    await this.store.setSetting(PAUSED_KEY, String(paused));
    this.store.publish({ type: 'workers-paused', paused });
    for (const loop of this.loops.values()) loop.wake();
  }

  statuses(): WorkerStatus[] {
    return [...this.loops.values()].map((loop) => loop.status()).sort((a, b) => a.agentSlug.localeCompare(b.agentSlug));
  }

  status(agentSlug: string): WorkerStatus | undefined {
    return this.loops.get(agentSlug)?.status();
  }

  /** Apply a saved (or deleted) configuration: restart that agent's loop. */
  async reload(agentSlug: string): Promise<void> {
    await this.loops.get(agentSlug)?.stop();
    this.loops.delete(agentSlug);
    const config = await this.store.getWorkerConfig(agentSlug);
    if (config) this.startLoop(config);
    else this.store.publish({ type: 'worker', worker: removedStatus(agentSlug) });
  }

  private startLoop(config: WorkerConfig): void {
    if (this.stopped) return;
    const loop = new WorkerLoop(config, this.store, this.options, () => this.paused);
    this.loops.set(config.agentSlug, loop);
    loop.start();
  }
}

class WorkerLoop {
  private running = false;
  private child?: ChildProcess;
  private current?: WorkerStatus['currentTask'];
  private lastRun?: WorkerStatus['lastRun'];
  private error?: string;
  private wakeUp?: () => void;
  private done?: Promise<void>;
  private readonly aborter = new AbortController();
  /** Cancels the current wait for a task, so pausing takes effect at once. */
  private waitAborter?: AbortController;
  /** When recent runs started, for the hourly limit. */
  private runStarts: number[] = [];
  /** Set while the hourly limit holds the worker back. */
  private limitedUntil?: number;

  constructor(
    private readonly config: WorkerConfig,
    private readonly store: RelayStore,
    private readonly options: WorkerManagerOptions,
    private readonly isPaused: () => boolean,
  ) {}

  start(): void {
    this.running = true;
    this.done = this.loop();
    this.publish();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.aborter.abort();
    this.wake();
    if (this.child) killTree(this.child);
    await this.done;
  }

  wake(): void {
    this.waitAborter?.abort();
    this.wakeUp?.();
  }

  status(): WorkerStatus {
    const state: WorkerStatus['state'] = !this.config.enabled
      ? 'disabled'
      : this.current
        ? 'running'
        : this.isPaused()
          ? 'paused'
          : this.limitedUntil
            ? 'limited'
            : this.error
              ? 'error'
              : 'idle';
    return {
      ...this.config,
      state,
      ...(this.limitedUntil ? { resumesAt: new Date(this.limitedUntil).toISOString() } : {}),
      ...(this.current ? { currentTask: this.current } : {}),
      ...(this.lastRun ? { lastRun: this.lastRun } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private publish(): void {
    this.store.publish({ type: 'worker', worker: this.status() });
  }

  private async loop(): Promise<void> {
    let lastHeartbeat = 0;
    while (this.running) {
      if (!this.config.enabled || this.isPaused()) {
        this.publish();
        await this.sleep(60_000);
        continue;
      }
      try {
        // Keep the agent visibly online while its worker is listening.
        if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
          await this.store.heartbeat(this.config.agentSlug);
          lastHeartbeat = Date.now();
        }
        // At the hourly limit, tasks wait in the queue until the oldest run is an hour old.
        const hourAgo = Date.now() - HOUR_MS;
        this.runStarts = this.runStarts.filter((time) => time > hourAgo);
        if (this.runStarts.length >= this.config.maxRunsPerHour) {
          this.limitedUntil = this.runStarts[0]! + HOUR_MS;
          this.publish();
          await this.sleep(Math.max(this.limitedUntil - Date.now(), 1_000));
          continue;
        }
        if (this.limitedUntil) {
          this.limitedUntil = undefined;
          this.publish();
        }
        // Short waits: in-process polling is free, and settings changes apply quickly.
        this.waitAborter = new AbortController();
        const signal = AbortSignal.any([this.aborter.signal, this.waitAborter.signal]);
        const task = await this.store.waitForTask(this.config.agentSlug, 5_000, LEASE_SECONDS, this.config.allowedSenders, signal, 'worker');
        if (this.error) {
          this.error = undefined;
          this.publish();
        }
        if (task && this.running) await this.runTask(task);
      } catch (error: unknown) {
        if (!this.running) break;
        this.error = messageOf(error);
        this.publish();
        await this.sleep(15_000);
      }
    }
  }

  private async runTask(task: Task): Promise<void> {
    const slug = this.config.agentSlug;
    const startedAt = new Date().toISOString();
    this.runStarts.push(Date.now());
    this.current = { id: task.id, title: task.title, startedAt };
    this.publish();

    const timeoutMs = this.config.timeoutMinutes * 60 * 1000;
    const directory = join(runRoot(this.options), task.id);
    let outcome: { kind: 'completed' | 'blocked'; message: string; result?: string } | undefined;
    const token = await this.store.issueRunToken(slug, task.id, timeoutMs + 10 * 60 * 1000);
    const activity = new ActivityRecorder((entries) => this.store.appendActivity(task.id, entries), [token]);
    activity.add({ kind: 'start', text: `${this.harnessName()} started in ${this.config.workdir}` });
    const extraDirs = this.config.extraDirs.filter((dir) => existsSync(dir));
    for (const missing of this.config.extraDirs.filter((dir) => !extraDirs.includes(dir))) {
      activity.add({ kind: 'error', text: `The extra folder ${missing} doesn't exist, so this run can't use it.` });
    }
    // List the folders first, so the files this run changes can be shown afterwards.
    const watched = [this.config.workdir, ...extraDirs];
    const before = await snapshot(watched);

    const renew = setInterval(() => void this.store.renewLease(slug, task.id, LEASE_SECONDS).catch(() => undefined), RENEW_EVERY_MS);
    let cancelled = false;
    const watchCancel = setInterval(() => {
      void this.store.getTaskById(task.id).then((current) => {
        if (current.status === 'cancelled' && this.child) {
          cancelled = true;
          killTree(this.child);
        }
      }, () => undefined);
    }, CANCEL_CHECK_MS);

    try {
      await mkdir(directory, { recursive: true });
      const context: RunContext = {
        workdir: this.config.workdir,
        promptFile: join(directory, 'task.md'),
        resultFile: join(directory, 'result.md'),
        mcpConfigFile: join(directory, 'mcp.json'),
        mcpUrl: this.options.mcpUrl,
        extraDirs,
      };
      const preset = findPreset(this.config.harness);
      const spec = this.buildSpec(context);
      const parser = createParser(spec.events);
      const agent = await this.store.getAgent(slug);
      const sender = await this.store.getAgent(task.senderSlug).catch(() => undefined);
      const parent = task.parentTaskId ? await this.store.getTaskById(task.parentTaskId).catch(() => undefined) : undefined;
      const prompt = buildTaskPrompt(task, agent, sender?.displayName ?? task.senderSlug, {
        ...(spec.relayTools ? { relayServer: spec.relayServer ?? RUN_SERVER } : {}),
        extraDirs: preset?.extraDirs || this.config.harness === CUSTOM_HARNESS ? extraDirs : [],
        handOffsLeft: this.store.chainLimit() - task.depth,
        ...(parent ? { parentTitle: parent.title } : {}),
      });
      await writeFile(context.promptFile, prompt);
      await writeFile(
        context.mcpConfigFile,
        JSON.stringify({ mcpServers: { [RUN_SERVER]: { type: 'http', url: this.options.mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }),
      );
      for (const [path, content] of Object.entries(spec.files ?? {})) await writeFile(path, content);

      if (!existsSync(this.config.workdir)) throw new Error(`The working folder ${this.config.workdir} doesn't exist.`);
      const result = await this.spawnHarness(spec, prompt, context, token, timeoutMs, parser, activity);

      if (cancelled) return;
      // A structured stream's raw output is not an answer.
      const answer = (spec.resultInFile && (await readText(context.resultFile))) || parser.answer()?.trim() || (spec.events ? '' : result.stdout.trim());
      if (result.timedOut) {
        outcome = { kind: 'blocked', message: `The ${this.harnessName()} worker stopped this task after ${this.config.timeoutMinutes} minutes without finishing.${tail(answer || result.stderr)}` };
      } else if (result.exitCode !== 0) {
        outcome = { kind: 'blocked', message: `${this.harnessName()} exited with code ${result.exitCode} before finishing.${tail(result.stderr || answer)}` };
      } else if (!answer) {
        outcome = { kind: 'blocked', message: `${this.harnessName()} finished but gave no answer.${tail(result.stderr)}` };
      } else if (/^\s*BLOCKED:/i.test(answer)) {
        outcome = { kind: 'blocked', message: answer.replace(/^\s*BLOCKED:\s*/i, '').slice(0, MAX_RESULT_CHARS) || 'The agent is blocked.' };
      } else {
        outcome = { kind: 'completed', message: firstLine(answer), result: truncate(answer) };
      }
    } catch (error: unknown) {
      outcome = { kind: 'blocked', message: `The ${this.harnessName()} worker couldn't run this task: ${messageOf(error)}` };
    } finally {
      clearInterval(renew);
      clearInterval(watchCancel);
      this.child = undefined;
      const after = await snapshot(watched);
      const changed = changes(before, after);
      // A folder too big to list completely: add what the harness itself reported.
      if (!after.complete || !before.complete) {
        for (const file of activity.reportedFiles()) if (!changed.some((known) => known.path === file.path)) changed.push({ ...file, path: resolve(this.config.workdir, file.path) });
      }
      if (changed.length > 0) activity.add({ kind: 'files', text: describeChanges(changed), files: changed }, true);
      await activity.close(
        cancelled
          ? { kind: 'end', text: 'Stopped: the task was cancelled.', status: 'failed' }
          : outcome?.kind === 'completed'
            ? { kind: 'end', text: 'Finished. The result was sent to the sender.', status: 'ok' }
            : { kind: 'end', text: `Stopped: ${outcome ? firstLine(outcome.message) : 'the run ended unexpectedly.'}`, status: 'failed' },
      );
      await this.store.revokeRunTokens(task.id).catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }

    // If the harness reported through the relay itself, or the task was cancelled, there is nothing to add.
    const current = await this.store.getTaskById(task.id).catch(() => undefined);
    if (outcome && current?.status === 'claimed') {
      await this.store
        .reportTask({ reporterSlug: slug, taskId: task.id, kind: outcome.kind, message: outcome.message, ...(outcome.result ? { result: outcome.result } : {}) })
        .catch((error: unknown) => console.error('[worker] could not report', task.id, messageOf(error)));
    }
    const finished = await this.store.getTaskById(task.id).catch(() => undefined);
    this.lastRun = {
      taskId: task.id,
      title: task.title,
      outcome: finished?.status === 'completed' ? 'completed' : 'blocked',
      finishedAt: new Date().toISOString(),
      summary: finished?.reports.at(-1)?.message.slice(0, 200) ?? (cancelled ? 'Cancelled by the sender.' : ''),
    };
    this.current = undefined;
    this.publish();
  }

  private buildSpec(context: RunContext): RunSpec {
    const preset = this.config.harness === CUSTOM_HARNESS ? undefined : findPreset(this.config.harness);
    if (preset?.run) return preset.run(context);
    // A custom command: fill placeholders in the argument template.
    const fill = (value: string) =>
      value
        .replaceAll('{prompt_file}', context.promptFile)
        .replaceAll('{result_file}', context.resultFile)
        .replaceAll('{mcp_config}', context.mcpConfigFile)
        .replaceAll('{mcp_url}', context.mcpUrl)
        .replaceAll('{workdir}', context.workdir);
    return {
      args: this.config.args.map(fill),
      promptOnStdin: this.config.promptMode === 'stdin',
      resultInFile: this.config.args.some((arg) => arg.includes('{result_file}')),
      relayTools: this.config.args.some((arg) => arg.includes('{mcp_config}')),
    };
  }

  private spawnHarness(spec: RunSpec, prompt: string, context: RunContext, token: string, timeoutMs: number, parser: OutputParser, activity: ActivityRecorder) {
    const invocation = resolveInvocation(this.config.command, spec.args);
    // The prompt argument form is only for custom commands, and never through a shell.
    const args = this.config.promptMode === 'argument' && this.config.harness === CUSTOM_HARNESS ? [...invocation.args, prompt] : invocation.args;
    const { ELECTRON_RUN_AS_NODE: _electron, ...inherited } = process.env;
    const env = {
      ...inherited,
      ...invocation.env,
      ...spec.env,
      CROSSCHAT_MCP_URL: context.mcpUrl,
      CROSSCHAT_TOKEN: token,
      CROSSCHAT_AGENT: this.config.agentSlug,
      CROSSCHAT_TASK_FILE: context.promptFile,
      CROSSCHAT_RESULT_FILE: context.resultFile,
      CROSSCHAT_EXTRA_DIRS: context.extraDirs.join(delimiter),
    };

    return new Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolvePromise, reject) => {
      const child = spawn(invocation.file, args, { cwd: this.config.workdir, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      // So a relay that restarts mid-run can stop this harness (see recoverInterruptedRuns).
      if (child.pid) void writeFile(join(dirname(context.promptFile), 'process'), `${child.pid}\n${basename(invocation.file)}`).catch(() => undefined);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      // Every output line becomes steps of the live view; a structured stream's other output is only diagnostics.
      const stdoutLines = lineSplitter((line) => parser.line(line).forEach((step) => activity.add(step)));
      const stderrLines = lineSplitter((line) => !spec.events && line.trim() && activity.add({ kind: 'output', text: line }));
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += text;
        stdoutLines.push(text);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += text;
        stderrLines.push(text);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        stdoutLines.end();
        stderrLines.end();
        resolvePromise({ exitCode, stdout, stderr, timedOut });
      });
      child.stdin.on('error', () => undefined);
      if (spec.promptOnStdin) child.stdin.end(prompt);
      else child.stdin.end();
    });
  }

  private harnessName(): string {
    return findPreset(this.config.harness)?.name ?? 'harness';
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolvePromise) => {
      const timer = setTimeout(done, ms);
      this.wakeUp = done;
      function done() {
        clearTimeout(timer);
        resolvePromise();
      }
    });
  }
}

/** The instructions a harness gets for one task. */
export interface PromptOptions {
  /** The MCP server the relay's tools come from in this run, if any. */
  relayServer?: string;
  /** Folders besides the working folder that this run may use. */
  extraDirs?: string[];
  /** How many more hand-offs to other agents this task may start. */
  handOffsLeft?: number;
  /** The task this one was delegated from. */
  parentTitle?: string;
}

export function buildTaskPrompt(
  task: Pick<Task, 'id' | 'title' | 'instructions' | 'priority' | 'senderSlug'> & Partial<Pick<Task, 'reports'>>,
  agent: { slug: string; displayName: string; details?: string },
  senderName: string,
  options: PromptOptions = {},
): string {
  const priority = task.priority === 3 ? 'urgent' : task.priority === 1 ? 'low' : 'normal';
  const history = taskHistory(task.reports ?? []);
  const changesRequested = task.reports?.at(-1)?.kind === 'changes';
  const canDelegate = options.relayServer && (options.handOffsLeft ?? 1) > 0;
  return [
    `You are ${agent.displayName} ("${agent.slug}"), an agent connected to a Crosschat relay. ${senderName} ("${task.senderSlug}") assigned you this task (priority: ${priority}).`,
    agent.details ? `Your role: ${agent.details}` : '',
    options.parentTitle ? `This task is part of "${options.parentTitle}", which ${senderName} is working on.` : '',
    `## Task: ${task.title}`,
    task.instructions,
    history ? `## Earlier rounds of this task\n\n${history}` : '',
    changesRequested ? 'The sender asked for changes to your earlier result (see above). Make them; your final answer replaces the earlier result.' : '',
    '## How to finish',
    [
      'Work in the current folder. Do the task fully, then end with your final answer: what you did, where any outputs are, and anything the sender needs to know. That final answer is sent back to the sender as the result.',
      options.extraDirs && options.extraDirs.length > 0 ? `Besides the current folder, you may read and change files in: ${options.extraDirs.join('; ')}.` : '',
      'If you cannot finish because you need something from a person or another agent, make your final answer start with "BLOCKED:" followed by exactly what you need.',
      options.relayServer
        ? `The Crosschat relay's tools are available from the MCP server named "${options.relayServer}" (tool names start with mcp__${options.relayServer}__). Use that server: other Crosschat entries you may see point to the same relay but are not approved in this run. ${
            canDelegate
              ? 'Use them if part of the work belongs to another agent (list_agents, then post_task).'
              : 'This task is already as many hand-offs deep as the relay allows, so do not post tasks to other agents: do the work yourself or answer BLOCKED:.'
          } If a task you posted earlier needs fixes, use request_changes on it instead of posting a new task. Do not call claim_next_task or report_task for this task; it is reported for you.`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Earlier results, blockers, and notes on a task that has come back, so the harness picks up where it stopped. */
function taskHistory(reports: Task['reports']): string {
  const lines = reports.flatMap((report) => {
    if (report.kind === 'completed') return [`- Your earlier result: ${clipText(report.result ?? report.message, 4000)}`];
    if (report.kind === 'changes') return [`- Changes requested: ${report.message}`];
    if (report.kind === 'blocked') return [`- You reported a blocker: ${report.message}`];
    if (/^Requeued by /.test(report.message)) return [`- ${report.message}`];
    return [];
  });
  return lines.join('\n');
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function describeChanges(files: ChangedFile[]): string {
  const count = (change: ChangedFile['change']) => files.filter((file) => file.change === change).length;
  const parts = [
    count('added') && `${count('added')} added`,
    count('changed') && `${count('changed')} changed`,
    count('deleted') && `${count('deleted')} deleted`,
  ].filter(Boolean);
  return `Files: ${parts.join(', ')}`;
}

function removedStatus(agentSlug: string): WorkerStatus {
  const time = new Date().toISOString();
  return {
    agentSlug,
    harness: '',
    command: '',
    args: [],
    promptMode: 'stdin',
    workdir: '',
    allowedSenders: [],
    timeoutMinutes: 0,
    enabled: false,
    extraDirs: [],
    maxRunsPerHour: 0,
    exclusive: false,
    createdAt: time,
    updatedAt: time,
    state: 'disabled',
  };
}

function runRoot(options: WorkerManagerOptions): string {
  return options.runDirectory ?? join(tmpdir(), 'crosschat-runs');
}

/** Stop a harness process left from an earlier relay, if that process ID still belongs to the same program. */
async function stopLeftover(pid: number, image: string): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true });
      // Process IDs are reused: only stop it if it is still the program the worker started.
      if (!stdout.toLowerCase().includes(`"${image.toLowerCase()}"`)) return;
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      // The full command line: Node.js names its main thread 'MainThread', so the short process name doesn't say which program it is.
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'args=']);
      if (!stdout.split(/\s+/).some((part) => basename(part) === image)) return;
      process.kill(pid, 'SIGTERM');
    }
  } catch {
    // Already gone.
  }
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    // Harnesses start their own child processes; end the whole tree.
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
  } else {
    child.kill('SIGTERM');
    setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5000).unref();
  }
}

/** Calls `onLine` for each complete line of a stream that arrives in chunks. */
function lineSplitter(onLine: (line: string) => unknown): { push: (text: string) => void; end: () => void } {
  let partial = '';
  return {
    push(text) {
      const lines = (partial + text).split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    },
    end() {
      if (partial) onLine(partial);
      partial = '';
    },
  };
}

async function readText(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return '';
  }
}

function truncate(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Output shortened by the worker.]` : text;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim()) ?? text;
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed ? `\n\nLast output:\n${trimmed.slice(-1500)}` : '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
