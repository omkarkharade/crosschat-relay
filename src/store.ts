import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue, StatementSync } from 'node:sqlite';

import type { ActivityEntry, ChangedFile, NewActivity } from './activity.js';

// Loaded with require rather than a static import: static imports of built-ins
// are loaded before any module code runs, which would print node:sqlite's
// ExperimentalWarning before src/quiet-sqlite-warning.ts can filter it.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncType;

export const DEFAULT_CAPABILITIES = [
  'text-input',
  'text-output',
  'image-input',
  'image-output',
  'code-execution',
  'web-search',
  'file-system',
] as const;

export type TaskStatus = 'queued' | 'claimed' | 'completed' | 'blocked' | 'cancelled';
/** 'changes' is the sender asking for changes to a finished task, which reopens it. */
export type ReportKind = 'progress' | 'completed' | 'blocked' | 'changes';
export type AgentKind = 'agent' | 'human';

export interface Agent {
  slug: string;
  kind: AgentKind;
  displayName: string;
  modelSlug: string;
  capabilities: string[];
  details?: string;
  registeredAt: string;
  lastSeenAt: string;
  /** Whether a per-agent token has been issued. The token itself is never stored. */
  hasToken: boolean;
  /**
   * Fields the relay owner set (through an invite or the dashboard). The
   * agent's own register_agent calls keep these instead of overwriting them.
   */
  ownerSet: { displayName: boolean; details: boolean };
}

export type AgentWithAvailability = Agent & { availability: 'online' | 'offline' };

export interface TaskReport {
  id: string;
  kind: ReportKind;
  message: string;
  result?: string;
  createdAt: string;
}

export interface TaskSummary {
  id: string;
  senderSlug: string;
  recipientSlug: string;
  title: string;
  requiredCapabilities: string[];
  priority: 1 | 2 | 3;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
  /** The task this one was delegated from (posted while the parent was being worked on). */
  parentTaskId?: string;
  /** How many agent-to-agent hand-offs led here: 0 for a task a person or chat posted. */
  depth: number;
  /** Who took the task: an automatic worker run or a chat session. */
  claimedVia?: 'worker' | 'chat';
  reportCount: number;
  /** The most recent report, with its message shortened, so lists can show progress at a glance. */
  latestReport?: { kind: ReportKind; message: string; createdAt: string };
}

export interface Task extends Omit<TaskSummary, 'reportCount' | 'latestReport'> {
  instructions: string;
  reports: TaskReport[];
}

export interface RelayEvent {
  sequence: number;
  recipientSlug: string;
  type: 'task-claimed' | 'task-progress' | 'task-completed' | 'task-blocked' | 'task-cancelled' | 'task-requeued';
  taskId: string;
  summary: string;
  createdAt: string;
}

/** A change pushed to live subscribers (the dashboard stream) after it commits. */
export type RelayChange =
  | { type: 'task'; task: TaskSummary }
  | { type: 'tasks-removed'; ids: string[] }
  | { type: 'agent'; agent: AgentWithAvailability }
  | { type: 'agent-removed'; slug: string }
  | { type: 'event'; event: RelayEvent }
  | { type: 'invite'; invite: Invite }
  | { type: 'worker'; worker: WorkerStatus }
  | { type: 'workers-paused'; paused: boolean }
  | { type: 'activity'; taskId: string; entries: ActivityEntry[] };

/** How a worker runs tasks for one agent on this computer. */
export interface WorkerConfig {
  agentSlug: string;
  /** A harness preset id ("claude-code", "codex", ...) or "custom". */
  harness: string;
  /** The executable to run (absolute path), with the argument template for custom harnesses. */
  command: string;
  /** Argument template for custom harnesses; placeholders like {prompt_file} are filled per task. */
  args: string[];
  /** How a custom harness receives the prompt. */
  promptMode: 'stdin' | 'file' | 'argument';
  workdir: string;
  /** Only tasks from these senders run automatically. */
  allowedSenders: string[];
  timeoutMinutes: number;
  enabled: boolean;
  /** More folders the harness may read and change, besides the working folder. */
  extraDirs: string[];
  /** At most this many runs in any hour, so agents handing work to each other can't run away. */
  maxRunsPerHour: number;
  /** Only the worker takes this agent's tasks; its chat sessions get none while the worker is on. */
  exclusive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A worker's configuration plus what it is doing right now. */
export interface WorkerStatus extends WorkerConfig {
  state: 'idle' | 'running' | 'paused' | 'disabled' | 'error' | 'limited';
  /** When a worker at its hourly limit starts taking tasks again. */
  resumesAt?: string;
  currentTask?: { id: string; title: string; startedAt: string };
  lastRun?: { taskId: string; title: string; outcome: 'completed' | 'blocked'; finishedAt: string; summary: string };
  error?: string;
}

/** A code that lets an agent enroll itself and receive its own token. The code is shown once; only its hash is stored. */
export interface Invite {
  id: string;
  label?: string;
  createdAt: string;
  expiresAt: string;
  /** Undefined means unlimited. */
  maxUses?: number;
  uses: number;
  revoked: boolean;
  /** Whether the invite can still be used. */
  active: boolean;
  /** Slugs of the agents that enrolled with it. */
  agents: string[];
  /** The name every agent enrolling with this invite gets, instead of choosing its own. */
  displayName?: string;
  /** What the agent works on and which tasks it should expect; others see it in list_agents. */
  role?: string;
  /** A task sent from the operator to each agent as soon as it enrolls. */
  firstTask?: FirstTask;
}

export interface FirstTask {
  title: string;
  instructions: string;
  priority: 1 | 2 | 3;
}

export interface CreateInviteInput {
  label?: string;
  expiresInMs: number;
  maxUses?: number;
  displayName?: string;
  role?: string;
  firstTask?: FirstTask;
}

export interface EnrollResult {
  agent: AgentWithAvailability;
  token: string;
  /** The invite's first task, already queued for the new agent. */
  assignedTask?: Task;
}

export interface RegisterAgentInput {
  slug: string;
  displayName: string;
  modelSlug: string;
  capabilities: string[];
  details?: string;
}

export interface CreateAgentInput extends RegisterAgentInput {
  kind?: AgentKind;
}

export interface PostTaskInput {
  senderSlug: string;
  recipientSlug: string;
  title: string;
  instructions: string;
  requiredCapabilities: string[];
  priority: 1 | 2 | 3;
  /** Link to the task this one belongs to. */
  parentTaskId?: string;
  /** Posted by a worker run: refuse it if it would make the chain of hand-offs longer than the limit. */
  enforceChainLimit?: boolean;
}

export interface ReportTaskInput {
  reporterSlug: string;
  taskId: string;
  kind: ReportKind;
  message: string;
  result?: string;
}

export interface ListTasksQuery {
  statuses?: TaskStatus[];
  /** Tasks this agent sent or received. */
  agentSlug?: string;
  /** Case-insensitive match on the title. */
  search?: string;
  limit?: number;
}

export interface ListEventsQuery {
  limit?: number;
  /** Return only events older than this sequence number (for paging back). */
  beforeSequence?: number;
}

export interface RelayStats {
  tasks: Record<TaskStatus, number>;
  agents: { total: number; online: number };
}

export interface RelayStoreOptions {
  /** How long completed and cancelled tasks are kept before maintenance deletes them. */
  taskRetentionMs?: number;
  /** Maximum number of relay events kept in the journal. */
  maxEvents?: number;
}

export interface MaintenanceResult {
  requeued: number;
  pruned: number;
}

const DEFAULT_TASK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_EVENTS = 10_000;
/** How many hand-offs deep worker runs may delegate. A task a person or chat posts is 0; each hand-off adds 1. */
const DEFAULT_CHAIN_LIMIT = 3;
const ONLINE_WINDOW_MS = 2 * 60 * 1000;
/** Presence changes are pushed to live subscribers at most this often per agent. */
const PRESENCE_PUSH_INTERVAL_MS = 30 * 1000;
const TASK_STATUSES: TaskStatus[] = ['queued', 'claimed', 'blocked', 'completed', 'cancelled'];
const SCHEMA_VERSION = 6;

/** Version 1: the original schema. */
const SCHEMA_V1 = `
  CREATE TABLE agents (
    slug TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'agent',
    display_name TEXT NOT NULL,
    model_slug TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    details TEXT,
    registered_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_read_sequence INTEGER NOT NULL DEFAULT 0,
    token_hash TEXT UNIQUE
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    sender_slug TEXT NOT NULL,
    recipient_slug TEXT NOT NULL,
    title TEXT NOT NULL,
    instructions TEXT NOT NULL,
    required_capabilities TEXT NOT NULL,
    priority INTEGER NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    claimed_at TEXT,
    lease_expires_at TEXT
  );
  CREATE INDEX tasks_queue ON tasks (recipient_slug, status, priority DESC, created_at);
  CREATE INDEX tasks_status_updated ON tasks (status, updated_at);
  CREATE INDEX tasks_sender ON tasks (sender_slug, updated_at);
  CREATE TABLE reports (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    result TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX reports_task ON reports (task_id);
  CREATE TABLE events (
    sequence INTEGER PRIMARY KEY,
    recipient_slug TEXT NOT NULL,
    type TEXT NOT NULL,
    task_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX events_recipient ON events (recipient_slug, sequence);
`;

/** Version 2: invites that let agents enroll themselves. */
const SCHEMA_V2 = `
  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    label TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    max_uses INTEGER,
    uses INTEGER NOT NULL DEFAULT 0,
    revoked INTEGER NOT NULL DEFAULT 0
  );
  ALTER TABLE agents ADD COLUMN invite_id TEXT REFERENCES invites (id) ON DELETE SET NULL;
`;

/** Migrations by the schema version they produce. Existing databases are upgraded in place, in order. */
/** Version 3: owner-set agent names and roles, and invites that set them and hand out a first task. */
const SCHEMA_V3 = `
  ALTER TABLE agents ADD COLUMN display_name_locked INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE agents ADD COLUMN details_locked INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE invites ADD COLUMN display_name TEXT;
  ALTER TABLE invites ADD COLUMN role TEXT;
  ALTER TABLE invites ADD COLUMN first_task TEXT;
`;

/** Version 4: workers that run tasks with local harnesses, their short-lived run tokens, and settings. */
const SCHEMA_V4 = `
  CREATE TABLE workers (
    agent_slug TEXT PRIMARY KEY REFERENCES agents (slug) ON DELETE CASCADE,
    harness TEXT NOT NULL,
    command TEXT NOT NULL,
    args TEXT NOT NULL,
    prompt_mode TEXT NOT NULL,
    workdir TEXT NOT NULL,
    allowed_senders TEXT NOT NULL,
    timeout_minutes INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE run_tokens (
    token_hash TEXT PRIMARY KEY,
    agent_slug TEXT NOT NULL REFERENCES agents (slug) ON DELETE CASCADE,
    task_id TEXT,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/** Version 5: the steps of worker runs, for the live view of a task. */
const SCHEMA_V5 = `
  CREATE TABLE task_activity (
    task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    at TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    detail TEXT,
    status TEXT,
    ref TEXT,
    PRIMARY KEY (task_id, seq)
  );
`;

/**
 * Version 6: task threads and hand-off depth, who claimed a task, worker
 * limits and extra folders, and the files a run changed.
 */
const SCHEMA_V6 = `
  ALTER TABLE tasks ADD COLUMN parent_task_id TEXT REFERENCES tasks (id) ON DELETE SET NULL;
  ALTER TABLE tasks ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN claimed_via TEXT;
  CREATE INDEX tasks_parent ON tasks (parent_task_id);
  ALTER TABLE workers ADD COLUMN extra_dirs TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE workers ADD COLUMN max_runs_per_hour INTEGER NOT NULL DEFAULT 20;
  ALTER TABLE workers ADD COLUMN exclusive INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE task_activity ADD COLUMN files TEXT;
`;

const MIGRATIONS: Record<number, string> = { 1: SCHEMA_V1, 2: SCHEMA_V2, 3: SCHEMA_V3, 4: SCHEMA_V4, 5: SCHEMA_V5, 6: SCHEMA_V6 };

type Row = Record<string, SQLInputValue>;

const nowIso = () => new Date().toISOString();

/**
 * Durable task ledger for one relay process, stored in SQLite.
 *
 * `node:sqlite` is synchronous, so every state change runs as one synchronous
 * transaction: it either commits completely or rolls back, and no other
 * request can interleave with it. Changes are pushed to live subscribers only
 * after they commit.
 */
export class RelayStore {
  private readonly dataDirectory: string;
  private readonly taskRetentionMs: number;
  private readonly maxEvents: number;
  private db?: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private lastWriteError?: Error;
  private maintenanceTimer?: NodeJS.Timeout;
  private closing = false;
  private pendingChanges: RelayChange[] = [];
  private readonly listeners = new Set<(change: RelayChange) => void>();
  private readonly lastPresencePush = new Map<string, number>();
  private readonly taskWaiters = new Map<string, Set<() => void>>();

  constructor(dataDirectory: string, options: RelayStoreOptions = {}) {
    this.dataDirectory = dataDirectory;
    this.taskRetentionMs = options.taskRetentionMs ?? DEFAULT_TASK_RETENTION_MS;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  }

  /** Open the database. Call before serving so an unreadable ledger fails at startup. */
  async init(): Promise<void> {
    this.database();
  }

  /** Whether the most recent write succeeded. */
  get healthy(): boolean {
    return this.lastWriteError === undefined;
  }

  /** Receive every committed change. Returns an unsubscribe function. */
  subscribe(listener: (change: RelayChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ---------------------------------------------------------------- agents

  async registerAgent(input: RegisterAgentInput): Promise<AgentWithAvailability> {
    return this.transact(() => {
      const time = nowIso();
      const existing = this.agentRow(input.slug);
      if (existing) {
        // A name or role the owner set wins over what the agent registers with.
        const keepName = Number(existing.display_name_locked) === 1;
        const keepDetails = Number(existing.details_locked) === 1;
        this.run(
          'UPDATE agents SET display_name = ?, model_slug = ?, capabilities = ?, details = ?, last_seen_at = ? WHERE slug = ?',
          keepName ? String(existing.display_name) : input.displayName,
          input.modelSlug,
          JSON.stringify(uniqueSorted(input.capabilities)),
          keepDetails ? (existing.details ?? null) : (input.details ?? null),
          time,
          input.slug,
        );
      } else {
        this.insertAgent({ ...input, kind: 'agent' }, time);
      }
      return this.emitAgent(input.slug);
    });
  }

  /** Create an agent ahead of time and issue its token. The token is returned only here. */
  async createAgent(input: CreateAgentInput): Promise<{ agent: AgentWithAvailability; token?: string }> {
    return this.transact(() => {
      if (this.agentRow(input.slug)) {
        throw new RelayError(`An agent with slug “${input.slug}” already exists.`, 'agent_exists', { slug: input.slug }, 409);
      }
      const kind = input.kind ?? 'agent';
      this.insertAgent({ ...input, kind }, nowIso());
      const token = kind === 'agent' ? this.setToken(input.slug) : undefined;
      return { agent: this.emitAgent(input.slug), ...(token ? { token } : {}) };
    });
  }

  /**
   * Set how an agent appears to everyone: its display name and its role
   * (details). Values set here are kept when the agent re-registers. Passing
   * `details: null` clears the role and lets the agent describe itself again.
   */
  async updateAgentProfile(slug: string, input: { displayName?: string; details?: string | null }): Promise<AgentWithAvailability> {
    return this.transact(() => {
      this.requireAgent(slug);
      if (input.displayName !== undefined) {
        this.run('UPDATE agents SET display_name = ?, display_name_locked = 1 WHERE slug = ?', input.displayName, slug);
      }
      if (input.details === null) {
        this.run('UPDATE agents SET details = NULL, details_locked = 0 WHERE slug = ?', slug);
      } else if (input.details !== undefined) {
        this.run('UPDATE agents SET details = ?, details_locked = 1 WHERE slug = ?', input.details, slug);
      }
      return this.emitAgent(slug);
    });
  }

  /** Make sure the human operator the dashboard acts as exists. */
  async ensureOperator(slug: string): Promise<void> {
    if (this.agentRow(slug)) return;
    await this.createAgent({
      slug,
      kind: 'human',
      displayName: 'Operator',
      modelSlug: 'human',
      capabilities: ['text-input', 'text-output'],
      details: 'The person using the Crosschat dashboard.',
    });
  }

  /** Issue a new token for an agent, replacing any previous one. */
  async issueToken(slug: string): Promise<string> {
    return this.transact(() => {
      const agent = this.requireAgent(slug);
      if (agent.kind === 'human') {
        throw new RelayError('Human operators use the dashboard session, not agent tokens.', 'invalid_agent_kind', { slug }, 409);
      }
      const token = this.setToken(slug);
      this.emitAgent(slug);
      return token;
    });
  }

  async revokeToken(slug: string): Promise<void> {
    this.transact(() => {
      this.requireAgent(slug);
      this.run('UPDATE agents SET token_hash = NULL WHERE slug = ?', slug);
      this.emitAgent(slug);
    });
  }

  /** Resolve a per-agent token to its agent slug. */
  authenticateAgentToken(token: string): string | undefined {
    return this.resolveAgentToken(token)?.slug;
  }

  /** The agent a token belongs to and, for a worker run's token, the task being run. */
  resolveAgentToken(token: string): { slug: string; runTaskId?: string } | undefined {
    const hash = hashToken(token);
    const row = this.get('SELECT slug FROM agents WHERE token_hash = ?', hash);
    if (row) return { slug: String(row.slug) };
    // Short-lived tokens a worker hands to a harness for one task.
    const run = this.get('SELECT agent_slug, task_id FROM run_tokens WHERE token_hash = ? AND expires_at > ?', hash, nowIso());
    return run ? { slug: String(run.agent_slug), ...(run.task_id ? { runTaskId: String(run.task_id) } : {}) } : undefined;
  }

  // --------------------------------------------------------------- workers

  async listWorkerConfigs(): Promise<WorkerConfig[]> {
    return this.all('SELECT * FROM workers ORDER BY agent_slug').map(workerFromRow);
  }

  async getWorkerConfig(agentSlug: string): Promise<WorkerConfig | undefined> {
    const row = this.get('SELECT * FROM workers WHERE agent_slug = ?', agentSlug);
    return row ? workerFromRow(row) : undefined;
  }

  /** Create or replace the worker for an agent. */
  async saveWorkerConfig(input: Omit<WorkerConfig, 'createdAt' | 'updatedAt'>): Promise<WorkerConfig> {
    return this.transact(() => {
      const agent = this.requireAgent(input.agentSlug);
      if (agent.kind === 'human') throw new RelayError('Workers run agents, not people.', 'invalid_agent_kind', undefined, 409);
      const time = nowIso();
      const existing = this.get('SELECT created_at FROM workers WHERE agent_slug = ?', input.agentSlug);
      this.run(
        `INSERT INTO workers (agent_slug, harness, command, args, prompt_mode, workdir, allowed_senders, timeout_minutes, enabled,
           extra_dirs, max_runs_per_hour, exclusive, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (agent_slug) DO UPDATE SET harness = excluded.harness, command = excluded.command, args = excluded.args,
           prompt_mode = excluded.prompt_mode, workdir = excluded.workdir, allowed_senders = excluded.allowed_senders,
           timeout_minutes = excluded.timeout_minutes, enabled = excluded.enabled, extra_dirs = excluded.extra_dirs,
           max_runs_per_hour = excluded.max_runs_per_hour, exclusive = excluded.exclusive, updated_at = excluded.updated_at`,
        input.agentSlug,
        input.harness,
        input.command,
        JSON.stringify(input.args),
        input.promptMode,
        input.workdir,
        JSON.stringify(uniqueSorted(input.allowedSenders)),
        input.timeoutMinutes,
        input.enabled ? 1 : 0,
        JSON.stringify(input.extraDirs),
        input.maxRunsPerHour,
        input.exclusive ? 1 : 0,
        existing ? String(existing.created_at) : time,
        time,
      );
      return workerFromRow(this.get('SELECT * FROM workers WHERE agent_slug = ?', input.agentSlug)!);
    });
  }

  async deleteWorkerConfig(agentSlug: string): Promise<void> {
    this.transact(() => this.run('DELETE FROM workers WHERE agent_slug = ?', agentSlug));
  }

  /** Issue a token that acts as `agentSlug` only until `expiresAt`, for one harness run. */
  async issueRunToken(agentSlug: string, taskId: string, ttlMs: number): Promise<string> {
    return this.transact(() => {
      this.requireAgent(agentSlug);
      const token = `ccr_${randomBytes(32).toString('base64url')}`;
      this.run(
        'INSERT INTO run_tokens (token_hash, agent_slug, task_id, expires_at) VALUES (?, ?, ?, ?)',
        hashToken(token),
        agentSlug,
        taskId,
        new Date(Date.now() + ttlMs).toISOString(),
      );
      return token;
    });
  }

  async revokeRunTokens(taskId: string): Promise<void> {
    this.transact(() => this.run('DELETE FROM run_tokens WHERE task_id = ?', taskId));
  }

  async getSetting(key: string): Promise<string | undefined> {
    const row = this.get('SELECT value FROM settings WHERE key = ?', key);
    return row ? String(row.value) : undefined;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.transact(() => this.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value));
  }

  /** Record steps of a worker run on a task, and push them to live subscribers. */
  async appendActivity(taskId: string, steps: NewActivity[]): Promise<ActivityEntry[]> {
    if (steps.length === 0) return [];
    return this.transact(() => {
      const last = Number(this.get('SELECT COALESCE(MAX(seq), 0) AS seq FROM task_activity WHERE task_id = ?', taskId)?.seq ?? 0);
      const entries = steps.map((step, index) => ({ ...step, seq: last + index + 1 }));
      for (const entry of entries) {
        this.run(
          'INSERT INTO task_activity (task_id, seq, at, kind, text, detail, status, ref, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          taskId,
          entry.seq,
          entry.at,
          entry.kind,
          entry.text,
          entry.detail ?? null,
          entry.status ?? null,
          entry.ref ?? null,
          entry.files ? JSON.stringify(entry.files) : null,
        );
      }
      this.pendingChanges.push({ type: 'activity', taskId, entries });
      return entries;
    });
  }

  /** The recorded steps of worker runs on a task, oldest first. */
  async listActivity(taskId: string): Promise<ActivityEntry[]> {
    return this.all('SELECT * FROM task_activity WHERE task_id = ? ORDER BY seq', taskId).map((row) => ({
      seq: Number(row.seq),
      at: String(row.at),
      kind: String(row.kind) as ActivityEntry['kind'],
      text: String(row.text),
      ...(row.detail === null ? {} : { detail: String(row.detail) }),
      ...(row.status === null ? {} : { status: String(row.status) as NonNullable<ActivityEntry['status']> }),
      ...(row.ref === null ? {} : { ref: String(row.ref) }),
      ...(typeof row.files === 'string' ? { files: JSON.parse(row.files) as ChangedFile[] } : {}),
    }));
  }

  /** Whether a worker run on this task recorded changing this file (so the dashboard may preview it). */
  async taskChangedFile(taskId: string, path: string): Promise<boolean> {
    const rows = this.all("SELECT files FROM task_activity WHERE task_id = ? AND files IS NOT NULL", taskId);
    return rows.some((row) => (JSON.parse(String(row.files)) as ChangedFile[]).some((file) => file.path === path));
  }

  /** Push a change that did not come from a transaction (for example, worker status) to live subscribers. */
  publish(change: RelayChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error: unknown) {
        console.error('[store] change listener failed:', error);
      }
    }
  }

  // --------------------------------------------------------------- invites

  /** Create an invite. The code is returned only here. */
  async createInvite(input: CreateInviteInput): Promise<{ invite: Invite; code: string }> {
    return this.transact(() => {
      const id = randomUUID();
      const code = `cci_${randomBytes(24).toString('base64url')}`;
      const time = Date.now();
      this.run(
        `INSERT INTO invites (id, code_hash, label, created_at, expires_at, max_uses, display_name, role, first_task)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        hashToken(code),
        input.label ?? null,
        new Date(time).toISOString(),
        new Date(time + input.expiresInMs).toISOString(),
        input.maxUses ?? null,
        input.displayName ?? null,
        input.role ?? null,
        input.firstTask ? JSON.stringify(input.firstTask) : null,
      );
      return { invite: this.emitInvite(id), code };
    });
  }

  async listInvites(): Promise<Invite[]> {
    return this.all('SELECT * FROM invites ORDER BY created_at DESC').map((row) => this.inviteFromRow(row));
  }

  async revokeInvite(id: string): Promise<Invite> {
    return this.transact(() => {
      if (!this.get('SELECT id FROM invites WHERE id = ?', id)) throw new RelayError('Unknown invite.', 'unknown_invite', { id }, 404);
      this.run('UPDATE invites SET revoked = 1 WHERE id = ?', id);
      return this.emitInvite(id);
    });
  }

  /**
   * Let an agent enroll itself with an invite code: create the agent, issue
   * its token, apply the name and role the owner chose, queue the invite's
   * first task, and count one use of the invite, all in one transaction. A
   * failed enrollment (for example, a taken slug) does not use up the invite.
   */
  async enroll(code: string, profile: RegisterAgentInput, operatorSlug?: string): Promise<EnrollResult> {
    const result = this.transact((): EnrollResult => {
      const invite = this.get('SELECT * FROM invites WHERE code_hash = ?', hashToken(code));
      const problem = !invite
        ? 'That invite code is not valid.'
        : Number(invite.revoked) === 1
          ? 'That invite was revoked.'
          : Date.parse(String(invite.expires_at)) <= Date.now()
            ? 'That invite has expired.'
            : invite.max_uses !== null && Number(invite.uses) >= Number(invite.max_uses)
              ? 'That invite has already been used.'
              : undefined;
      if (problem) throw new RelayError(`${problem} Ask the relay owner for a new one.`, 'invalid_invite', undefined, 403);
      if (this.agentRow(profile.slug)) {
        throw new RelayError(`The slug “${profile.slug}” is taken. Choose a different slug and try again.`, 'agent_exists', { slug: profile.slug }, 409);
      }

      const setup = this.inviteFromRow(invite!);
      this.insertAgent(
        {
          ...profile,
          kind: 'agent',
          ...(setup.displayName ? { displayName: setup.displayName } : {}),
          ...(setup.role ? { details: setup.role } : {}),
        },
        nowIso(),
      );
      const token = this.setToken(profile.slug);
      this.run(
        'UPDATE agents SET invite_id = ?, display_name_locked = ?, details_locked = ? WHERE slug = ?',
        setup.id,
        setup.displayName ? 1 : 0,
        setup.role ? 1 : 0,
        profile.slug,
      );
      this.run('UPDATE invites SET uses = uses + 1 WHERE id = ?', setup.id);
      const agent = this.emitAgent(profile.slug);
      this.emitInvite(setup.id);

      if (!setup.firstTask || !operatorSlug) return { agent, token };
      const assignedTask = this.insertTask({
        senderSlug: operatorSlug,
        recipientSlug: profile.slug,
        title: setup.firstTask.title,
        instructions: setup.firstTask.instructions,
        requiredCapabilities: [],
        priority: setup.firstTask.priority,
      });
      return { agent, token, assignedTask };
    });
    if (result.assignedTask) this.wakeTaskWaiters(profile.slug);
    return result;
  }

  /** Delete an agent that has no open tasks. Its finished tasks and history stay. */
  async deleteAgent(slug: string): Promise<void> {
    this.transact(() => {
      this.requireAgent(slug);
      const open = this.get(
        `SELECT COUNT(*) AS count FROM tasks
         WHERE (sender_slug = ? OR recipient_slug = ?) AND status IN ('queued', 'claimed', 'blocked')`,
        slug,
        slug,
      );
      if (Number(open?.count) > 0) {
        throw new RelayError('Cancel or finish this agent’s open tasks before deleting it.', 'agent_has_open_tasks', { slug }, 409);
      }
      this.run('DELETE FROM agents WHERE slug = ?', slug);
      this.pendingChanges.push({ type: 'agent-removed', slug });
    });
  }

  async heartbeat(slug: string): Promise<AgentWithAvailability> {
    this.touch(slug);
    return this.publicAgent(this.requireAgent(slug));
  }

  async getAgent(slug: string): Promise<AgentWithAvailability> {
    return this.publicAgent(this.requireAgent(slug));
  }

  async listAgents(includeOffline = false): Promise<AgentWithAvailability[]> {
    return this.all('SELECT * FROM agents ORDER BY slug')
      .map((row) => this.publicAgent(row))
      .filter((agent) => includeOffline || agent.availability === 'online');
  }

  // ----------------------------------------------------------------- tasks

  async postTask(input: PostTaskInput): Promise<Task> {
    const task = this.transact(() => {
      this.touchInTransaction(input.senderSlug);
      let depth = 0;
      if (input.parentTaskId) {
        const parent = this.requireTask(input.parentTaskId);
        if (parent.senderSlug !== input.senderSlug && parent.recipientSlug !== input.senderSlug) {
          throw new RelayError('A task can only be linked to a task you sent or received.', 'task_access_denied', undefined, 403);
        }
        depth = parent.depth + 1;
        const limit = this.chainLimit();
        if (input.enforceChainLimit && depth > limit) {
          throw new RelayError(
            `Hand-off limit reached: this task would be ${depth} hand-offs from the person who started the work, and the limit is ${limit}. Do this part yourself, or finish with BLOCKED: and say what you need.`,
            'chain_limit',
            { depth, limit },
            409,
          );
        }
      }
      return this.insertTask(input, depth);
    });
    this.wakeTaskWaiters(input.recipientSlug);
    return task;
  }

  /** Queue a task inside the current transaction. */
  private insertTask(input: PostTaskInput, depth = 0): Task {
    const recipient = this.requireAgent(input.recipientSlug);
    const capabilities = parseList(recipient.capabilities);
    const missing = input.requiredCapabilities.filter((capability) => !capabilities.includes(capability));
    if (missing.length > 0) {
      throw new RelayError(
        `Cannot assign to ${input.recipientSlug}: it does not advertise ${missing.join(', ')}.`,
        'recipient_lacks_capability',
        { missingCapabilities: missing },
        409,
      );
    }

    const time = nowIso();
    const id = randomUUID();
    this.run(
      `INSERT INTO tasks (id, sender_slug, recipient_slug, title, instructions, required_capabilities, priority, status, parent_task_id, depth, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      id,
      input.senderSlug,
      input.recipientSlug,
      input.title,
      input.instructions,
      JSON.stringify(uniqueSorted(input.requiredCapabilities)),
      input.priority,
      input.parentTaskId ?? null,
      depth,
      time,
      time,
    );
    return this.emitTask(id);
  }

  /**
   * Claim the most urgent queued task for an agent. With `fromSenders`, only
   * tasks from those senders are considered; others stay queued.
   */
  async claimNextTask(recipientSlug: string, leaseSeconds: number, fromSenders?: string[], via: 'worker' | 'chat' = 'chat'): Promise<Task | undefined> {
    this.touch(recipientSlug);
    const requeued = this.requeueExpiredTasks(recipientSlug);
    if (requeued.length > 0) this.wakeTaskWaiters(recipientSlug);

    return this.transact(() => {
      // Priority 3 is the most urgent; ties go to the oldest task.
      if (fromSenders && fromSenders.length === 0) return undefined;
      const senderFilter = fromSenders ? `AND sender_slug IN (${fromSenders.map(() => '?').join(', ')})` : '';
      const row = this.get(
        `SELECT id FROM tasks WHERE recipient_slug = ? AND status = 'queued' ${senderFilter}
         ORDER BY priority DESC, created_at ASC LIMIT 1`,
        recipientSlug,
        ...(fromSenders ?? []),
      );
      if (!row) return undefined;
      const id = String(row.id);
      const time = nowIso();
      this.run(
        `UPDATE tasks SET status = 'claimed', claimed_at = ?, lease_expires_at = ?, claimed_via = ?, updated_at = ? WHERE id = ?`,
        time,
        leaseExpiry(leaseSeconds),
        via,
        time,
        id,
      );
      const task = this.requireTask(id);
      this.addEvent(task.senderSlug, 'task-claimed', task, `${recipientSlug} claimed “${task.title}”${via === 'worker' ? ' (worker)' : ''}.`);
      return this.emitTask(id);
    });
  }

  /**
   * Claim a task, waiting up to `waitMs` for one to arrive. The wake-up
   * subscription is registered before each claim attempt, so a task posted
   * while an attempt is in progress is never missed, and a wake-up that does
   * not yield a task (for example, another worker won it) keeps waiting for
   * the remaining time instead of returning early.
   */
  async waitForTask(
    recipientSlug: string,
    waitMs: number,
    leaseSeconds: number,
    fromSenders?: string[],
    signal?: AbortSignal,
    via: 'worker' | 'chat' = 'chat',
  ): Promise<Task | undefined> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      if (this.closing || signal?.aborted) return undefined;
      const subscription = this.subscribeToTasks(recipientSlug);
      try {
        const task = await this.claimNextTask(recipientSlug, leaseSeconds, fromSenders, via);
        const remaining = deadline - Date.now();
        if (task || remaining <= 0) return task;
        await subscription.wait(remaining, signal);
      } finally {
        subscription.cancel();
      }
    }
  }

  async renewLease(reporterSlug: string, taskId: string, leaseSeconds: number): Promise<Task> {
    return this.transact(() => {
      const task = this.requireTask(taskId);
      ensureClaimOwner(task, reporterSlug);
      this.run('UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ?', leaseExpiry(leaseSeconds), nowIso(), taskId);
      this.touchInTransaction(reporterSlug);
      return this.emitTask(taskId);
    });
  }

  async releaseTask(reporterSlug: string, taskId: string, reason: string): Promise<Task> {
    const task = this.transact(() => {
      const task = this.requireTask(taskId);
      ensureClaimOwner(task, reporterSlug);
      this.returnToQueue(taskId, `Released: ${reason}`);
      this.touchInTransaction(reporterSlug);
      this.addEvent(task.senderSlug, 'task-requeued', task, `${reporterSlug} released “${task.title}”: ${reason}`);
      return this.emitTask(taskId);
    });
    this.wakeTaskWaiters(task.recipientSlug);
    return task;
  }

  async reportTask(input: ReportTaskInput): Promise<Task> {
    return this.transact(() => {
      const task = this.requireTask(input.taskId);
      ensureClaimOwner(task, input.reporterSlug);
      const time = nowIso();
      this.insertReport(input.taskId, input.kind, input.message, input.result, time);
      if (input.kind === 'progress') {
        this.run('UPDATE tasks SET updated_at = ? WHERE id = ?', time, input.taskId);
      } else {
        const status: TaskStatus = input.kind === 'completed' ? 'completed' : 'blocked';
        this.run('UPDATE tasks SET status = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?', status, time, input.taskId);
      }
      this.touchInTransaction(input.reporterSlug);
      const eventType = input.kind === 'progress' ? 'task-progress' : input.kind === 'completed' ? 'task-completed' : 'task-blocked';
      this.addEvent(task.senderSlug, eventType, task, `${input.reporterSlug}: ${input.message}`);
      return this.emitTask(input.taskId);
    });
  }

  /**
   * Return a blocked task to its recipient's queue once the sender has
   * resolved the blocker. The note is recorded on the task and sent to the
   * recipient as a material update.
   */
  async requeueTask(senderSlug: string, taskId: string, note: string): Promise<Task> {
    const task = this.transact(() => {
      const task = this.requireTask(taskId);
      if (task.senderSlug !== senderSlug) {
        throw new RelayError('Only the task sender can requeue this task.', 'task_requeue_denied', undefined, 403);
      }
      if (task.status !== 'blocked') {
        throw new RelayError(`Only a blocked task can be requeued; this one is ${task.status}.`, 'invalid_task_state', { status: task.status }, 409);
      }
      this.returnToQueue(taskId, `Requeued by ${senderSlug}: ${note}`);
      this.touchInTransaction(senderSlug);
      this.addEvent(task.recipientSlug, 'task-requeued', task, `${senderSlug} requeued “${task.title}”: ${note}`);
      return this.emitTask(taskId);
    });
    this.wakeTaskWaiters(task.recipientSlug);
    return task;
  }

  /**
   * Send a finished task back to its recipient with what to change. The task
   * reopens with its history, so each round of work stays in one thread.
   */
  async requestChanges(senderSlug: string, taskId: string, note: string): Promise<Task> {
    const task = this.transact(() => {
      const task = this.requireTask(taskId);
      if (task.senderSlug !== senderSlug) {
        throw new RelayError('Only the task sender can ask for changes.', 'task_changes_denied', undefined, 403);
      }
      if (task.status !== 'completed') {
        throw new RelayError(`Changes can be asked for on a completed task; this one is ${task.status}.`, 'invalid_task_state', { status: task.status }, 409);
      }
      const time = nowIso();
      this.run(`UPDATE tasks SET status = 'queued', claimed_at = NULL, claimed_via = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`, time, taskId);
      this.insertReport(taskId, 'changes', note, undefined, time);
      this.touchInTransaction(senderSlug);
      this.addEvent(task.recipientSlug, 'task-requeued', task, `${senderSlug} asked for changes to “${task.title}”: ${note}`);
      return this.emitTask(taskId);
    });
    this.wakeTaskWaiters(task.recipientSlug);
    return task;
  }

  /** The task a task was delegated from, and the tasks delegated from it. */
  async relatedTasks(taskId: string): Promise<{ parent?: TaskSummary; children: TaskSummary[] }> {
    const task = this.requireTask(taskId);
    const summaries = (where: string, value: string) =>
      this.all(
        `SELECT t.*,
           (SELECT COUNT(*) FROM reports r WHERE r.task_id = t.id) AS report_count,
           (SELECT json_object('kind', r.kind, 'message', r.message, 'createdAt', r.created_at)
              FROM reports r WHERE r.task_id = t.id ORDER BY r.rowid DESC LIMIT 1) AS latest_report
         FROM tasks t WHERE ${where} ORDER BY t.created_at`,
        value,
      ).map(summaryFromRow);
    const parent = task.parentTaskId ? summaries('t.id = ?', task.parentTaskId)[0] : undefined;
    return { ...(parent ? { parent } : {}), children: summaries('t.parent_task_id = ?', taskId) };
  }

  /** The longest chain of agent-to-agent hand-offs a worker run may start. */
  chainLimit(): number {
    const value = Number(this.get("SELECT value FROM settings WHERE key = 'chain.maxDepth'")?.value);
    return Number.isInteger(value) && value >= 0 ? value : DEFAULT_CHAIN_LIMIT;
  }

  async setChainLimit(limit: number): Promise<void> {
    await this.setSetting('chain.maxDepth', String(limit));
  }

  /** Whether an agent's tasks go only to its worker (so its chat sessions shouldn't claim them). */
  workerOnly(agentSlug: string): boolean {
    const row = this.get('SELECT enabled, exclusive FROM workers WHERE agent_slug = ?', agentSlug);
    return Boolean(row && Number(row.enabled) === 1 && Number(row.exclusive) === 1);
  }

  async cancelTask(senderSlug: string, taskId: string, reason: string): Promise<Task> {
    return this.transact(() => {
      const task = this.requireTask(taskId);
      if (task.senderSlug !== senderSlug) {
        throw new RelayError('Only the task sender can cancel this task.', 'task_cancel_denied', undefined, 403);
      }
      if (task.status === 'completed' || task.status === 'cancelled') {
        throw new RelayError(`A ${task.status} task cannot be cancelled.`, 'invalid_task_state', { status: task.status }, 409);
      }
      this.run(`UPDATE tasks SET status = 'cancelled', lease_expires_at = NULL, updated_at = ? WHERE id = ?`, nowIso(), taskId);
      this.touchInTransaction(senderSlug);
      this.addEvent(task.recipientSlug, 'task-cancelled', task, `${senderSlug} cancelled “${task.title}”: ${reason}`);
      return this.emitTask(taskId);
    });
  }

  /** Read a task as one of its participants. */
  async getTask(requesterSlug: string, taskId: string): Promise<Task> {
    const task = this.requireTask(taskId);
    if (task.senderSlug !== requesterSlug && task.recipientSlug !== requesterSlug) {
      throw new RelayError('Only the task sender or recipient can read this task.', 'task_access_denied', undefined, 403);
    }
    this.touch(requesterSlug);
    return task;
  }

  /** Read any task (for the owner's dashboard). */
  async getTaskById(taskId: string): Promise<Task> {
    return this.requireTask(taskId);
  }

  async listTasks(query: ListTasksQuery = {}): Promise<TaskSummary[]> {
    const conditions: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (query.statuses && query.statuses.length > 0) {
      conditions.push(`t.status IN (${query.statuses.map(() => '?').join(', ')})`);
      parameters.push(...query.statuses);
    }
    if (query.agentSlug) {
      conditions.push('(t.sender_slug = ? OR t.recipient_slug = ?)');
      parameters.push(query.agentSlug, query.agentSlug);
    }
    if (query.search) {
      conditions.push(`t.title LIKE ? ESCAPE '\\'`);
      parameters.push(`%${query.search.replace(/[\\%_]/g, (character) => `\\${character}`)}%`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    return this.all(
      `SELECT t.*,
         (SELECT COUNT(*) FROM reports r WHERE r.task_id = t.id) AS report_count,
         (SELECT json_object('kind', r.kind, 'message', r.message, 'createdAt', r.created_at)
            FROM reports r WHERE r.task_id = t.id ORDER BY r.rowid DESC LIMIT 1) AS latest_report
       FROM tasks t ${where} ORDER BY t.updated_at DESC LIMIT ?`,
      ...parameters,
      limit,
    ).map(summaryFromRow);
  }

  // ---------------------------------------------------------------- events

  async readUpdates(
    agentSlug: string,
    limit: number,
  ): Promise<{ updates: RelayEvent[]; cursor: number; mayHaveMissedUpdates?: true }> {
    return this.transact(() => {
      const agent = this.requireAgent(agentSlug);
      this.touchInTransaction(agentSlug);
      const lastRead = Number(agent.last_read_sequence);
      const oldest = this.get('SELECT MIN(sequence) AS sequence FROM events')?.sequence;
      // Events are trimmed globally, so a gap means this agent might have lost
      // some of its own updates; it cannot tell which ones.
      const mayHaveMissedUpdates = oldest !== null && oldest !== undefined && lastRead < Number(oldest) - 1;
      const updates = this.all(
        'SELECT * FROM events WHERE recipient_slug = ? AND sequence > ? ORDER BY sequence LIMIT ?',
        agentSlug,
        lastRead,
        limit,
      ).map(eventFromRow);
      const cursor = updates.length > 0 ? updates.at(-1)!.sequence : mayHaveMissedUpdates ? Number(oldest) - 1 : lastRead;
      if (cursor !== lastRead) this.run('UPDATE agents SET last_read_sequence = ? WHERE slug = ?', cursor, agentSlug);
      return { updates, cursor, ...(mayHaveMissedUpdates ? { mayHaveMissedUpdates: true as const } : {}) };
    });
  }

  /** Every agent's events, newest first (for the dashboard activity feed). */
  async listEvents(query: ListEventsQuery = {}): Promise<RelayEvent[]> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    return this.all(
      'SELECT * FROM events WHERE sequence < ? ORDER BY sequence DESC LIMIT ?',
      query.beforeSequence ?? Number.MAX_SAFE_INTEGER,
      limit,
    ).map(eventFromRow);
  }

  async stats(): Promise<RelayStats> {
    const tasks = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<TaskStatus, number>;
    for (const row of this.all('SELECT status, COUNT(*) AS count FROM tasks GROUP BY status')) {
      tasks[String(row.status) as TaskStatus] = Number(row.count);
    }
    const agents = await this.listAgents(true);
    return { tasks, agents: { total: agents.length, online: agents.filter((agent) => agent.availability === 'online').length } };
  }

  // ----------------------------------------------------------- maintenance

  /**
   * Requeue every expired lease, whether or not its recipient is still
   * polling, and delete completed or cancelled tasks past the retention window.
   */
  async runMaintenance(): Promise<MaintenanceResult> {
    const requeued = this.requeueExpiredTasks();
    this.transact(() => this.run('DELETE FROM run_tokens WHERE expires_at <= ?', nowIso()));
    const pruned = this.transact(() => {
      const threshold = new Date(Date.now() - this.taskRetentionMs).toISOString();
      const ids = this.all(
        `SELECT id FROM tasks WHERE status IN ('completed', 'cancelled') AND updated_at <= ?`,
        threshold,
      ).map((row) => String(row.id));
      if (ids.length === 0) return 0;
      this.run(`DELETE FROM tasks WHERE status IN ('completed', 'cancelled') AND updated_at <= ?`, threshold);
      this.pendingChanges.push({ type: 'tasks-removed', ids });
      return ids.length;
    });
    for (const recipientSlug of new Set(requeued.map((task) => task.recipientSlug))) this.wakeTaskWaiters(recipientSlug);
    return { requeued: requeued.length, pruned };
  }

  startMaintenance(intervalMs: number): void {
    this.stopMaintenance();
    this.maintenanceTimer = setInterval(() => {
      this.runMaintenance().catch((error: unknown) => console.error('[store] maintenance failed:', error));
    }, intervalMs);
    this.maintenanceTimer.unref();
  }

  stopMaintenance(): void {
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = undefined;
  }

  /** Stop maintenance, let waiting long-polls return, then close the database. */
  async close(): Promise<void> {
    this.closing = true;
    this.stopMaintenance();
    for (const recipientSlug of [...this.taskWaiters.keys()]) this.wakeTaskWaiters(recipientSlug);
    // Let woken long-polls observe `closing` before the database goes away.
    await new Promise((resolve) => setImmediate(resolve));
    this.listeners.clear();
    this.db?.close();
    this.db = undefined;
  }

  // -------------------------------------------------------------- internals

  private database(): DatabaseSync {
    if (this.db) return this.db;
    if (this.closing) throw new RelayError('The relay is shutting down.', 'shutting_down', undefined, 503);
    mkdirSync(this.dataDirectory, { recursive: true });
    const db = new DatabaseSync(join(this.dataDirectory, 'relay.db'));
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      const version = Number((db.prepare('PRAGMA user_version').get() as Row).user_version);
      if (version > SCHEMA_VERSION) {
        throw new Error(`relay.db uses schema version ${version}, but this relay supports up to ${SCHEMA_VERSION}. Upgrade crosschat-relay.`);
      }
      this.db = db;
      if (version < SCHEMA_VERSION) {
        this.transact(() => {
          for (let next = version + 1; next <= SCHEMA_VERSION; next += 1) db.exec(MIGRATIONS[next]!);
          db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
          // A brand-new database may be replacing the JSON ledger of an older version.
          if (version === 0) this.importLegacyJson();
        });
      }
      return db;
    } catch (error) {
      this.db = undefined;
      db.close();
      throw error;
    }
  }

  /** Import the ledger written by versions that stored state in relay-state.json. */
  private importLegacyJson(): void {
    const legacyFile = join(this.dataDirectory, 'relay-state.json');
    if (!existsSync(legacyFile)) return;
    const legacy = JSON.parse(readFileSync(legacyFile, 'utf8')) as LegacyState;
    if (legacy.version !== 1 || !legacy.agents || !legacy.tasks || !Array.isArray(legacy.events)) {
      throw new Error('relay-state.json has an unsupported shape; move it aside to start with an empty ledger.');
    }
    for (const agent of Object.values(legacy.agents)) {
      this.run(
        `INSERT INTO agents (slug, kind, display_name, model_slug, capabilities, details, registered_at, last_seen_at, last_read_sequence)
         VALUES (?, 'agent', ?, ?, ?, ?, ?, ?, ?)`,
        agent.slug,
        agent.displayName,
        agent.modelSlug,
        JSON.stringify(agent.capabilities),
        agent.details ?? null,
        agent.registeredAt,
        agent.lastSeenAt,
        agent.lastReadSequence ?? 0,
      );
    }
    for (const task of Object.values(legacy.tasks)) {
      this.run(
        `INSERT INTO tasks (id, sender_slug, recipient_slug, title, instructions, required_capabilities, priority, status, created_at, updated_at, claimed_at, lease_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        task.id,
        task.senderSlug,
        task.recipientSlug,
        task.title,
        task.instructions,
        JSON.stringify(task.requiredCapabilities),
        task.priority,
        task.status,
        task.createdAt,
        task.updatedAt,
        task.claimedAt ?? null,
        task.leaseExpiresAt ?? null,
      );
      for (const report of task.reports) this.insertReport(task.id, report.kind, report.message, report.result, report.createdAt, report.id);
    }
    for (const event of legacy.events) {
      this.run(
        'INSERT INTO events (sequence, recipient_slug, type, task_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        event.sequence,
        event.recipientSlug,
        event.type,
        event.taskId,
        event.summary,
        event.createdAt,
      );
    }
    // Keep the original next to the database rather than deleting it.
    renameSync(legacyFile, `${legacyFile}.migrated`);
    console.log(`[store] Imported ${Object.keys(legacy.tasks).length} tasks from relay-state.json into relay.db.`);
  }

  /** Run a state change atomically; push its changes to subscribers only after it commits. */
  private transact<T>(action: () => T): T {
    const db = this.database();
    db.exec('BEGIN IMMEDIATE');
    let result: T;
    try {
      result = action();
      db.exec('COMMIT');
      this.lastWriteError = undefined;
    } catch (error: unknown) {
      this.pendingChanges = [];
      if (db.isTransaction) db.exec('ROLLBACK');
      if (!(error instanceof RelayError)) this.lastWriteError = error instanceof Error ? error : new Error(String(error));
      throw error;
    }
    const changes = this.pendingChanges;
    this.pendingChanges = [];
    for (const change of changes) {
      for (const listener of this.listeners) {
        try {
          listener(change);
        } catch (error: unknown) {
          console.error('[store] change listener failed:', error);
        }
      }
    }
    return result;
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.database().prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private run(sql: string, ...parameters: SQLInputValue[]): void {
    this.statement(sql).run(...parameters);
  }

  private get(sql: string, ...parameters: SQLInputValue[]): Row | undefined {
    return this.statement(sql).get(...parameters) as Row | undefined;
  }

  private all(sql: string, ...parameters: SQLInputValue[]): Row[] {
    return this.statement(sql).all(...parameters) as Row[];
  }

  private insertAgent(input: CreateAgentInput & { kind: AgentKind }, time: string): void {
    // Nothing can be addressed to an agent before it exists.
    const lastSequence = Number(this.get('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events')?.sequence ?? 0);
    this.run(
      `INSERT INTO agents (slug, kind, display_name, model_slug, capabilities, details, registered_at, last_seen_at, last_read_sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.slug,
      input.kind,
      input.displayName,
      input.modelSlug,
      JSON.stringify(uniqueSorted(input.capabilities)),
      input.details ?? null,
      time,
      time,
      lastSequence,
    );
  }

  private inviteFromRow(row: Row): Invite {
    const id = String(row.id);
    const expiresAt = String(row.expires_at);
    const uses = Number(row.uses);
    const maxUses = row.max_uses === null || row.max_uses === undefined ? undefined : Number(row.max_uses);
    const revoked = Number(row.revoked) === 1;
    return {
      id,
      ...(row.label ? { label: String(row.label) } : {}),
      createdAt: String(row.created_at),
      expiresAt,
      ...(maxUses !== undefined ? { maxUses } : {}),
      uses,
      revoked,
      active: !revoked && Date.parse(expiresAt) > Date.now() && (maxUses === undefined || uses < maxUses),
      agents: this.all('SELECT slug FROM agents WHERE invite_id = ? ORDER BY registered_at', id).map((agent) => String(agent.slug)),
      ...(row.display_name ? { displayName: String(row.display_name) } : {}),
      ...(row.role ? { role: String(row.role) } : {}),
      ...(row.first_task ? { firstTask: JSON.parse(String(row.first_task)) as FirstTask } : {}),
    };
  }

  private emitInvite(id: string): Invite {
    const invite = this.inviteFromRow(this.get('SELECT * FROM invites WHERE id = ?', id)!);
    this.pendingChanges.push({ type: 'invite', invite });
    return invite;
  }

  private setToken(slug: string): string {
    const token = `cca_${randomBytes(32).toString('base64url')}`;
    this.run('UPDATE agents SET token_hash = ? WHERE slug = ?', hashToken(token), slug);
    return token;
  }

  private insertReport(taskId: string, kind: ReportKind, message: string, result: string | undefined, time: string, id: string = randomUUID()): void {
    this.run(
      'INSERT INTO reports (id, task_id, kind, message, result, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      taskId,
      kind,
      message,
      result ?? null,
      time,
    );
  }

  private returnToQueue(taskId: string, reportMessage: string): void {
    const time = nowIso();
    this.run(`UPDATE tasks SET status = 'queued', claimed_at = NULL, claimed_via = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`, time, taskId);
    this.insertReport(taskId, 'progress', reportMessage, undefined, time);
  }

  private requeueExpiredTasks(recipientSlug?: string): Task[] {
    return this.transact(() => {
      const now = nowIso();
      const rows = recipientSlug
        ? this.all(`SELECT id FROM tasks WHERE status = 'claimed' AND lease_expires_at <= ? AND recipient_slug = ?`, now, recipientSlug)
        : this.all(`SELECT id FROM tasks WHERE status = 'claimed' AND lease_expires_at <= ?`, now);
      return rows.map((row) => {
        const id = String(row.id);
        const task = this.requireTask(id);
        this.returnToQueue(id, 'Lease expired; task returned to the recipient queue.');
        this.addEvent(task.senderSlug, 'task-requeued', task, `Lease expired for “${task.title}”; it was requeued.`);
        return this.emitTask(id);
      });
    });
  }

  private addEvent(recipientSlug: string, type: RelayEvent['type'], task: Pick<Task, 'id'>, summary: string): void {
    const createdAt = nowIso();
    const inserted = this.statement(
      'INSERT INTO events (recipient_slug, type, task_id, summary, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(recipientSlug, type, task.id, summary, createdAt);
    const sequence = Number(inserted.lastInsertRowid);
    // Keep the journal bounded. Readers that fall behind the trimmed history
    // are told via `mayHaveMissedUpdates`.
    this.run('DELETE FROM events WHERE sequence <= ?', sequence - this.maxEvents);
    this.pendingChanges.push({ type: 'event', event: { sequence, recipientSlug, type, taskId: task.id, summary, createdAt } });
  }

  /** Record presence as its own small write. */
  private touch(slug: string): void {
    this.transact(() => this.touchInTransaction(slug));
  }

  private touchInTransaction(slug: string): void {
    this.requireAgent(slug);
    const now = Date.now();
    this.run('UPDATE agents SET last_seen_at = ? WHERE slug = ?', new Date(now).toISOString(), slug);
    // Presence changes on every poll; only push it occasionally.
    if (now - (this.lastPresencePush.get(slug) ?? 0) >= PRESENCE_PUSH_INTERVAL_MS) {
      this.lastPresencePush.set(slug, now);
      this.emitAgent(slug);
    }
  }

  private agentRow(slug: string): Row | undefined {
    return this.get('SELECT * FROM agents WHERE slug = ?', slug);
  }

  private requireAgent(slug: string): Row {
    const row = this.agentRow(slug);
    if (!row) {
      throw new RelayError(`Unknown agent slug “${slug}”. Register it before using the relay.`, 'unknown_agent', { slug }, 404);
    }
    return row;
  }

  private publicAgent(row: Row): AgentWithAvailability {
    const lastSeenAt = String(row.last_seen_at);
    return {
      slug: String(row.slug),
      kind: String(row.kind) as AgentKind,
      displayName: String(row.display_name),
      modelSlug: String(row.model_slug),
      capabilities: parseList(row.capabilities),
      ...(row.details ? { details: String(row.details) } : {}),
      registeredAt: String(row.registered_at),
      lastSeenAt,
      hasToken: row.token_hash !== null && row.token_hash !== undefined,
      ownerSet: { displayName: Number(row.display_name_locked) === 1, details: Number(row.details_locked) === 1 },
      availability: Date.parse(lastSeenAt) >= Date.now() - ONLINE_WINDOW_MS ? 'online' : 'offline',
    };
  }

  private emitAgent(slug: string): AgentWithAvailability {
    const agent = this.publicAgent(this.requireAgent(slug));
    this.pendingChanges.push({ type: 'agent', agent });
    return agent;
  }

  private requireTask(taskId: string): Task {
    const row = this.get('SELECT * FROM tasks WHERE id = ?', taskId);
    if (!row) throw new RelayError(`Unknown task “${taskId}”.`, 'unknown_task', { taskId }, 404);
    const reports = this.all('SELECT * FROM reports WHERE task_id = ? ORDER BY rowid', taskId).map(reportFromRow);
    const { reportCount: _count, latestReport: _latest, ...summary } = summaryFromRow({ ...row, report_count: reports.length });
    return { ...summary, instructions: String(row.instructions), reports };
  }

  private emitTask(taskId: string): Task {
    const task = this.requireTask(taskId);
    const { instructions: _instructions, reports, ...summary } = task;
    const latest = reports.at(-1);
    this.pendingChanges.push({
      type: 'task',
      task: {
        ...summary,
        reportCount: reports.length,
        ...(latest ? { latestReport: { kind: latest.kind, message: excerpt(latest.message), createdAt: latest.createdAt } } : {}),
      },
    });
    return task;
  }

  private subscribeToTasks(recipientSlug: string): { wait(ms: number, signal?: AbortSignal): Promise<void>; cancel(): void } {
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    const waiters = this.taskWaiters.get(recipientSlug) ?? new Set<() => void>();
    this.taskWaiters.set(recipientSlug, waiters);
    waiters.add(wake);

    return {
      wait: (ms, signal) =>
        new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, ms);
          timeout.unref();
          signal?.addEventListener('abort', () => {
            clearTimeout(timeout);
            resolve();
          }, { once: true });
          void woken.then(() => {
            clearTimeout(timeout);
            resolve();
          });
        }),
      cancel: () => {
        waiters.delete(wake);
        if (waiters.size === 0 && this.taskWaiters.get(recipientSlug) === waiters) this.taskWaiters.delete(recipientSlug);
      },
    };
  }

  private wakeTaskWaiters(recipientSlug: string): void {
    const waiters = this.taskWaiters.get(recipientSlug);
    if (!waiters) return;
    this.taskWaiters.delete(recipientSlug);
    for (const wake of waiters) wake();
  }
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: Record<string, unknown>,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

interface LegacyState {
  version: number;
  agents: Record<string, { slug: string; displayName: string; modelSlug: string; capabilities: string[]; details?: string; registeredAt: string; lastSeenAt: string; lastReadSequence?: number }>;
  tasks: Record<string, Omit<Task, 'reports'> & { reports: TaskReport[] }>;
  events: RelayEvent[];
}

function ensureClaimOwner(task: Task, reporterSlug: string): void {
  if (task.recipientSlug !== reporterSlug || task.status !== 'claimed') {
    throw new RelayError(
      'Only the recipient that currently holds a claimed task may update it.',
      'task_update_denied',
      { taskStatus: task.status },
      409,
    );
  }
}

function workerFromRow(row: Row): WorkerConfig {
  return {
    agentSlug: String(row.agent_slug),
    harness: String(row.harness),
    command: String(row.command),
    args: parseList(row.args),
    promptMode: String(row.prompt_mode) as WorkerConfig['promptMode'],
    workdir: String(row.workdir),
    allowedSenders: parseList(row.allowed_senders),
    timeoutMinutes: Number(row.timeout_minutes),
    enabled: Number(row.enabled) === 1,
    extraDirs: parseList(row.extra_dirs),
    maxRunsPerHour: Number(row.max_runs_per_hour ?? 20),
    exclusive: Number(row.exclusive ?? 0) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function summaryFromRow(row: Row): TaskSummary {
  return {
    id: String(row.id),
    senderSlug: String(row.sender_slug),
    recipientSlug: String(row.recipient_slug),
    title: String(row.title),
    requiredCapabilities: parseList(row.required_capabilities),
    priority: Number(row.priority) as 1 | 2 | 3,
    status: String(row.status) as TaskStatus,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    ...(row.claimed_at ? { claimedAt: String(row.claimed_at) } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: String(row.lease_expires_at) } : {}),
    ...(row.parent_task_id ? { parentTaskId: String(row.parent_task_id) } : {}),
    depth: Number(row.depth ?? 0),
    ...(row.claimed_via ? { claimedVia: String(row.claimed_via) as 'worker' | 'chat' } : {}),
    reportCount: Number(row.report_count ?? 0),
    ...(typeof row.latest_report === 'string' ? { latestReport: latestReportFromJson(row.latest_report) } : {}),
  };
}

function latestReportFromJson(json: string): NonNullable<TaskSummary['latestReport']> {
  const report = JSON.parse(json) as NonNullable<TaskSummary['latestReport']>;
  return { ...report, message: excerpt(report.message) };
}

const EXCERPT_LENGTH = 280;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_LENGTH ? `${flat.slice(0, EXCERPT_LENGTH - 1)}…` : flat;
}

function reportFromRow(row: Row): TaskReport {
  return {
    id: String(row.id),
    kind: String(row.kind) as ReportKind,
    message: String(row.message),
    ...(row.result ? { result: String(row.result) } : {}),
    createdAt: String(row.created_at),
  };
}

function eventFromRow(row: Row): RelayEvent {
  return {
    sequence: Number(row.sequence),
    recipientSlug: String(row.recipient_slug),
    type: String(row.type) as RelayEvent['type'],
    taskId: String(row.task_id),
    summary: String(row.summary),
    createdAt: String(row.created_at),
  };
}

function parseList(value: SQLInputValue | undefined): string[] {
  return typeof value === 'string' ? (JSON.parse(value) as string[]) : [];
}

function leaseExpiry(leaseSeconds: number): string {
  return new Date(Date.now() + leaseSeconds * 1000).toISOString();
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}
