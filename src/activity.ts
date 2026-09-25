import { randomUUID } from 'node:crypto';

/**
 * The live view of a worker run: harness output turned into readable steps
 * (messages, commands, tool calls, file changes). Harnesses that stream
 * structured events get a parser for them; any other harness still shows its
 * output lines as they arrive.
 */

export type ActivityKind = 'start' | 'message' | 'thinking' | 'plan' | 'command' | 'tool' | 'file' | 'files' | 'output' | 'error' | 'end';

/** A file a run added, changed, or deleted. */
export interface ChangedFile {
  path: string;
  change: 'added' | 'changed' | 'deleted';
  size?: number;
}

/** One step of a worker run. */
export interface ActivityEntry {
  seq: number;
  at: string;
  kind: ActivityKind;
  text: string;
  /** Longer content, such as a command's output. */
  detail?: string;
  status?: 'running' | 'ok' | 'failed';
  /** Entries with the same ref describe the same step; the latest one wins. */
  ref?: string;
  /** For the 'files' step at the end of a run: what the run changed. */
  files?: ChangedFile[];
}

export type ActivityStep = Omit<ActivityEntry, 'seq' | 'at'>;
export type NewActivity = Omit<ActivityEntry, 'seq'>;

/** Structured event streams the worker understands. */
export type EventFormat = 'claude-stream' | 'codex-json';

export interface OutputParser {
  /** Turn one line of the harness's standard output into steps. */
  line(line: string): ActivityStep[];
  /** The final answer, when the stream carries one. */
  answer(): string | undefined;
}

const MAX_TEXT = 2000;
const MAX_DETAIL = 4000;
const MAX_ENTRIES = 1500;
const FLUSH_MS = 750;

export function createParser(format: EventFormat | undefined): OutputParser {
  if (format === 'claude-stream') return claudeParser();
  if (format === 'codex-json') return codexParser();
  return { line: (line) => (line.trim() ? [{ kind: 'output', text: line }] : []), answer: () => undefined };
}

// Claude Code: --output-format stream-json --verbose
function claudeParser(): OutputParser {
  const tools = new Map<string, ActivityStep>();
  let answer: string | undefined;
  return {
    answer: () => answer,
    line(line) {
      const event = parseJson(line);
      if (!event) return line.trim() ? [{ kind: 'output', text: line }] : [];
      const steps: ActivityStep[] = [];
      if (event.type === 'assistant') {
        for (const block of blocks(event.message)) {
          if (block.type === 'text' && str(block.text).trim()) steps.push({ kind: 'message', text: str(block.text) });
          else if (block.type === 'thinking' && str(block.thinking).trim()) steps.push({ kind: 'thinking', text: str(block.thinking) });
          else if (block.type === 'tool_use') {
            const step = claudeTool(str(block.name), record(block.input), str(block.id));
            tools.set(str(block.id), step);
            steps.push(step);
          }
        }
      } else if (event.type === 'user') {
        for (const block of blocks(event.message)) {
          if (block.type !== 'tool_result') continue;
          const started = tools.get(str(block.tool_use_id));
          if (!started) continue;
          steps.push({ ...started, status: block.is_error ? 'failed' : 'ok', ...detail(resultText(block.content)) });
        }
      } else if (event.type === 'result') {
        if (typeof event.result === 'string') answer = event.result;
        const denials = Array.isArray(event.permission_denials) ? event.permission_denials.length : 0;
        if (denials > 0) steps.push({ kind: 'error', text: `${denials} tool ${denials === 1 ? 'call was' : 'calls were'} refused: this run isn't allowed to use ${denials === 1 ? 'that tool' : 'those tools'}.` });
        if (event.is_error || (event.subtype && event.subtype !== 'success')) steps.push({ kind: 'error', text: `Claude Code stopped: ${str(event.subtype) || 'error'}.` });
      }
      return steps;
    },
  };
}

const CLAUDE_FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const CLAUDE_SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

function claudeTool(name: string, input: Record<string, unknown>, id: string): ActivityStep {
  const base = { status: 'running' as const, ref: id };
  if (CLAUDE_SHELL_TOOLS.has(name)) return { ...base, kind: 'command', text: str(input.command) || name };
  if (CLAUDE_FILE_TOOLS.has(name)) return { ...base, kind: 'file', text: `${name === 'Write' ? 'Write' : 'Edit'} ${str(input.file_path ?? input.notebook_path)}` };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  const subject = str(input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.title ?? input.description ?? input.taskId);
  const label = mcp ? `${mcp[1]} › ${mcp[2]}` : name;
  return { ...base, kind: 'tool', text: subject ? `${label}: ${subject}` : label };
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (part && typeof part === 'object' && 'text' in part ? str(part.text) : '')).filter(Boolean).join('\n');
  return '';
}

// Codex: exec --json
function codexParser(): OutputParser {
  let answer: string | undefined;
  return {
    answer: () => answer,
    line(line) {
      const event = parseJson(line);
      if (!event) return line.trim() ? [{ kind: 'output', text: line }] : [];
      if (event.type === 'turn.failed') return [{ kind: 'error', text: str(record(event.error).message) || 'The turn failed.' }];
      if (event.type === 'error') return [{ kind: 'error', text: str(event.message) || 'Codex reported an error.' }];
      if (!/^item\.(started|updated|completed)$/.test(str(event.type))) return [];
      const item = record(event.item);
      const done = event.type === 'item.completed';
      const ref = str(item.id) || undefined;
      const status = codexStatus(str(item.status), done, item.exit_code);
      switch (item.type) {
        case 'agent_message':
          if (!done) return [];
          answer = str(item.text);
          return [{ kind: 'message', text: str(item.text) }];
        case 'reasoning':
          return done && str(item.text).trim() ? [{ kind: 'thinking', text: str(item.text) }] : [];
        case 'command_execution':
          return [{ kind: 'command', text: unwrapShell(str(item.command)), status, ref, ...detail(str(item.aggregated_output)) }];
        case 'file_change': {
          const changes = Array.isArray(item.changes) ? item.changes.map(record) : [];
          const text = changes.map((change) => `${changeVerb(str(change.kind))} ${str(change.path)}`).join('\n') || 'Changed files';
          return [{ kind: 'file', text, status, ref }];
        }
        case 'mcp_tool_call': {
          const error = str(record(item.error).message);
          return [{ kind: 'tool', text: `${str(item.server)} › ${str(item.tool)}`, status, ref, ...detail(error || resultText(record(item.result).content)) }];
        }
        case 'web_search':
          return [{ kind: 'tool', text: `Web search: ${str(item.query)}`, status, ref }];
        case 'todo_list': {
          const items = Array.isArray(item.items) ? item.items.map(record) : [];
          return [{ kind: 'plan', text: items.map((entry) => `${entry.completed ? '☑' : '☐'} ${str(entry.text)}`).join('\n'), ref }];
        }
        case 'error':
          return [{ kind: 'error', text: str(item.message) }];
        default:
          return [];
      }
    },
  };
}

function codexStatus(status: string, done: boolean, exitCode: unknown): ActivityStep['status'] {
  if (status === 'failed' || status === 'declined' || (typeof exitCode === 'number' && exitCode !== 0)) return 'failed';
  return done || status === 'completed' ? 'ok' : 'running';
}

function changeVerb(kind: string): string {
  return kind === 'add' ? 'Added' : kind === 'delete' ? 'Deleted' : 'Updated';
}

/** Show the command a shell wrapper runs, not the wrapper. */
export function unwrapShell(command: string): string {
  const match = /^"?[^"\s]*?(?:powershell|pwsh|bash|zsh|sh|cmd)(?:\.exe)?"?\s+(?:-NoProfile\s+)?(?:-Command|-lc|-c|\/c)\s+([\s\S]+)$/i.exec(command.trim());
  if (!match) return command;
  const inner = match[1]!.trim();
  const quote = inner[0];
  return (quote === "'" || quote === '"') && inner.endsWith(quote) ? inner.slice(1, -1) : inner;
}

/**
 * Collects steps and writes them in small batches, so a chatty harness costs
 * one database write per second at most. Secrets (the run's token) are
 * removed before anything is stored.
 */
export class ActivityRecorder {
  private pending: NewActivity[] = [];
  private written = 0;
  private full = false;
  private readonly timer: NodeJS.Timeout;
  /** Harnesses number their steps per run (Codex's item_0, item_1, ...); refs must stay unique across runs of a task. */
  private readonly run = randomUUID().slice(0, 8);
  /** Files the harness itself said it changed, by path. */
  private readonly reported = new Map<string, ChangedFile['change']>();

  constructor(
    private readonly write: (entries: NewActivity[]) => Promise<unknown>,
    private readonly secrets: string[],
  ) {
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  add(step: ActivityStep, always = false): void {
    if (step.kind === 'file' && step.status !== 'failed') this.noteFiles(step.text);
    if (this.full && !always) return;
    const entry: NewActivity = { ...step, at: new Date().toISOString(), text: clip(this.redact(step.text), MAX_TEXT) };
    if (step.ref) entry.ref = `${this.run}:${step.ref}`;
    if (step.detail) entry.detail = clipMiddle(this.redact(step.detail), MAX_DETAIL);
    // A step that is still waiting to be written is replaced by its update.
    const earlier = entry.ref ? this.pending.findIndex((pending) => pending.ref === entry.ref) : -1;
    if (earlier >= 0) {
      this.pending[earlier] = entry;
      return;
    }
    // Plain output lines arriving together become one step.
    const last = this.pending.at(-1);
    if (entry.kind === 'output' && last?.kind === 'output' && last.text.length + entry.text.length < MAX_DETAIL) {
      last.text = `${last.text}\n${entry.text}`;
      return;
    }
    if (!always && this.written + this.pending.length >= MAX_ENTRIES - 1) {
      this.full = true;
      this.pending.push({ at: entry.at, kind: 'error', text: 'Later steps of this run are not shown: it reached the limit of steps kept per run.' });
      return;
    }
    this.pending.push(entry);
  }

  /** Files the harness reported changing (Codex file changes, Claude Code edits), for when a folder is too big to compare. */
  reportedFiles(): ChangedFile[] {
    return [...this.reported].map(([path, change]) => ({ path, change }));
  }

  private noteFiles(text: string): void {
    for (const line of text.split('\n')) {
      const match = /^(Added|Updated|Deleted|Write|Edit) (.+)$/.exec(line.trim());
      if (match) this.reported.set(match[2]!, match[1] === 'Added' ? 'added' : match[1] === 'Deleted' ? 'deleted' : 'changed');
    }
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.written += batch.length;
    await this.write(batch).catch((error: unknown) => console.error('[worker] could not save run activity:', error instanceof Error ? error.message : error));
  }

  /** Write what is left and stop. */
  async close(final?: ActivityStep): Promise<void> {
    clearInterval(this.timer);
    if (final) this.add(final, true);
    await this.flush();
  }

  private redact(text: string): string {
    return this.secrets.reduce((current, secret) => (secret ? current.replaceAll(secret, '[hidden]') : current), text);
  }
}

function detail(text: string): { detail?: string } {
  return text.trim() ? { detail: text.replace(/\s+$/, '') } : {};
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.4);
  return `${text.slice(0, head)}\n… (${text.length - max} characters not shown) …\n${text.slice(-(max - head))}`;
}

function parseJson(line: string): Record<string, unknown> | undefined {
  if (!line.trimStart().startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function blocks(message: unknown): Record<string, unknown>[] {
  const content = record(message).content;
  return Array.isArray(content) ? content.map(record) : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}
