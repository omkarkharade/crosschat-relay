// Mirrors the relay's API shapes (src/store.ts).

export type TaskStatus = 'queued' | 'claimed' | 'blocked' | 'completed' | 'cancelled';
/** 'changes' is the sender asking for changes to a finished task, which reopens it. */
export type ReportKind = 'progress' | 'completed' | 'blocked' | 'changes';
export type Priority = 1 | 2 | 3;

export interface Agent {
  slug: string;
  kind: 'agent' | 'human';
  displayName: string;
  modelSlug: string;
  capabilities: string[];
  details?: string;
  registeredAt: string;
  lastSeenAt: string;
  hasToken: boolean;
  /** Fields set by the relay owner, which the agent's own registrations don't overwrite. */
  ownerSet: { displayName: boolean; details: boolean };
  availability: 'online' | 'offline';
}

export interface TaskSummary {
  id: string;
  senderSlug: string;
  recipientSlug: string;
  title: string;
  requiredCapabilities: string[];
  priority: Priority;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  leaseExpiresAt?: string;
  /** The task this one was delegated from. */
  parentTaskId?: string;
  /** Agent-to-agent hand-offs that led here: 0 for a task a person or chat posted. */
  depth: number;
  /** Who took it: an automatic worker run or a chat session. */
  claimedVia?: 'worker' | 'chat';
  reportCount: number;
  /** The most recent report, with its message shortened. */
  latestReport?: { kind: ReportKind; message: string; createdAt: string };
}

export interface TaskReport {
  id: string;
  kind: ReportKind;
  message: string;
  result?: string;
  createdAt: string;
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

export type RelayChange =
  | { type: 'task'; task: TaskSummary }
  | { type: 'tasks-removed'; ids: string[] }
  | { type: 'agent'; agent: Agent }
  | { type: 'agent-removed'; slug: string }
  | { type: 'event'; event: RelayEvent }
  | { type: 'invite'; invite: Invite }
  | { type: 'worker'; worker: WorkerStatus }
  | { type: 'workers-paused'; paused: boolean }
  | { type: 'activity'; taskId: string; entries: ActivityEntry[] };

/** One step of a worker run on a task (the live view). */
export interface ActivityEntry {
  seq: number;
  at: string;
  kind: 'start' | 'message' | 'thinking' | 'plan' | 'command' | 'tool' | 'file' | 'files' | 'output' | 'error' | 'end';
  text: string;
  detail?: string;
  status?: 'running' | 'ok' | 'failed';
  /** Entries with the same ref describe the same step; the latest one wins. */
  ref?: string;
  /** For the 'files' step at the end of a run: what the run changed. */
  files?: ChangedFile[];
}

/** A file a worker run added, changed, or deleted. */
export interface ChangedFile {
  path: string;
  change: 'added' | 'changed' | 'deleted';
  size?: number;
}

export interface WorkerConfig {
  agentSlug: string;
  harness: string;
  command: string;
  args: string[];
  promptMode: 'stdin' | 'file' | 'argument';
  workdir: string;
  allowedSenders: string[];
  timeoutMinutes: number;
  enabled: boolean;
  extraDirs: string[];
  maxRunsPerHour: number;
  /** Only the worker takes this agent's tasks; its chat sessions get none. */
  exclusive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerStatus extends WorkerConfig {
  state: 'idle' | 'running' | 'paused' | 'disabled' | 'error' | 'limited';
  /** When a worker at its hourly limit takes tasks again. */
  resumesAt?: string;
  currentTask?: { id: string; title: string; startedAt: string };
  lastRun?: { taskId: string; title: string; outcome: 'completed' | 'blocked'; finishedAt: string; summary: string };
  error?: string;
}

export interface DetectedHarness {
  id: string;
  name: string;
  path?: string;
  canRun: boolean;
  /** Whether a worker can give it folders besides the working folder. */
  extraDirs: boolean;
  safety?: string;
  note?: string;
}

/** One folder of this computer, for the folder and program pickers. */
export interface BrowseResult {
  path: string;
  parent?: string;
  entries: Array<{ name: string; path: string; kind: 'dir' | 'file' }>;
  places: Array<{ name: string; path: string }>;
  truncated: boolean;
}

export interface LocalInfo {
  hostname: string;
  homeDirectory: string;
  mcpUrl?: string;
  harnesses: DetectedHarness[];
}

export interface ConnectResult {
  agent: Agent;
  connection: { configured: boolean; message: string; file?: string; snippet?: string };
  token?: string;
  worker?: WorkerStatus;
}

export interface Invite {
  id: string;
  label?: string;
  createdAt: string;
  expiresAt: string;
  maxUses?: number;
  uses: number;
  revoked: boolean;
  active: boolean;
  agents: string[];
  displayName?: string;
  role?: string;
  firstTask?: FirstTask;
}

export interface FirstTask {
  title: string;
  instructions: string;
  priority: Priority;
}

export interface Overview {
  version: string;
  operatorSlug: string;
  stats: { tasks: Record<TaskStatus, number>; agents: { total: number; online: number } };
}

export const DEFAULT_CAPABILITIES = [
  'text-input',
  'text-output',
  'image-input',
  'image-output',
  'code-execution',
  'web-search',
  'file-system',
];
