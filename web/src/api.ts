import type { ActivityEntry, Agent, BrowseResult, ConnectResult, FirstTask, Invite, LocalInfo, Overview, Priority, RelayEvent, Task, TaskSummary, WorkerStatus } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      // Proves the request came from the dashboard (see src/api.ts).
      ...(method !== 'GET' ? { 'x-crosschat-request': '1' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!response.ok) {
    throw new ApiError(payload.message ?? `Request failed (${response.status}).`, response.status, payload.error);
  }
  return payload as T;
}

export interface NewAgentInput {
  slug: string;
  displayName: string;
  modelSlug: string;
  capabilities: string[];
  details?: string;
}

export interface NewTaskInput {
  recipientSlug: string;
  title: string;
  instructions: string;
  requiredCapabilities: string[];
  priority: Priority;
}

export interface WorkerInput {
  harness: string;
  command?: string;
  args?: string[];
  promptMode?: 'stdin' | 'file' | 'argument';
  workdir: string;
  allowedSenders: string[];
  timeoutMinutes: number;
  enabled: boolean;
  extraDirs: string[];
  maxRunsPerHour: number;
  exclusive: boolean;
}

export interface ConnectInput {
  harness: string;
  slug: string;
  displayName: string;
  role?: string;
  configureClient: boolean;
  worker?: Omit<WorkerInput, 'harness'>;
}

export const api = {
  session: () => request<{ authenticated: boolean; version: string }>('GET', '/api/session'),
  signIn: (token: string) => request<{ authenticated: boolean }>('POST', '/api/session', { token }),
  signOut: () => request<{ authenticated: boolean }>('DELETE', '/api/session'),

  overview: () => request<Overview>('GET', '/api/overview'),

  agents: () => request<Agent[]>('GET', '/api/agents'),
  createAgent: (input: NewAgentInput) => request<{ agent: Agent; token?: string }>('POST', '/api/agents', input),
  updateAgent: (slug: string, input: { displayName?: string; details?: string | null }) =>
    request<Agent>('PATCH', `/api/agents/${encodeURIComponent(slug)}`, input),
  issueToken: (slug: string) => request<{ token: string }>('POST', `/api/agents/${encodeURIComponent(slug)}/token`),
  revokeToken: (slug: string) => request<{ revoked: boolean }>('DELETE', `/api/agents/${encodeURIComponent(slug)}/token`),
  deleteAgent: (slug: string) => request<{ deleted: boolean }>('DELETE', `/api/agents/${encodeURIComponent(slug)}`),

  tasks: (query: { status?: string; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (query.status) search.set('status', query.status);
    if (query.limit) search.set('limit', String(query.limit));
    return request<TaskSummary[]>('GET', `/api/tasks?${search}`);
  },
  task: (id: string) => request<Task>('GET', `/api/tasks/${encodeURIComponent(id)}`),
  activity: (id: string) => request<{ entries: ActivityEntry[] }>('GET', `/api/tasks/${encodeURIComponent(id)}/activity`),
  postTask: (input: NewTaskInput) => request<Task>('POST', '/api/tasks', input),
  cancelTask: (id: string, reason: string) => request<Task>('POST', `/api/tasks/${encodeURIComponent(id)}/cancel`, { reason }),
  requeueTask: (id: string, note: string) => request<Task>('POST', `/api/tasks/${encodeURIComponent(id)}/requeue`, { note }),
  requestChanges: (id: string, note: string) => request<Task>('POST', `/api/tasks/${encodeURIComponent(id)}/request-changes`, { note }),
  related: (id: string) => request<{ parent?: TaskSummary; children: TaskSummary[] }>('GET', `/api/tasks/${encodeURIComponent(id)}/related`),
  /** A picture a worker run on the task changed (from the relay's own computer only). */
  fileUrl: (id: string, path: string) => `/api/tasks/${encodeURIComponent(id)}/file?${new URLSearchParams({ path })}`,
  reveal: (id: string, path: string) => request<{ revealed: boolean }>('POST', `/api/tasks/${encodeURIComponent(id)}/reveal`, { path }),

  invites: () => request<Invite[]>('GET', '/api/invites'),
  createInvite: (input: { label?: string; expiresInHours: number; maxUses?: number; displayName?: string; role?: string; firstTask?: FirstTask }) =>
    request<{ invite: Invite; code: string }>('POST', '/api/invites', input),
  revokeInvite: (id: string) => request<Invite>('DELETE', `/api/invites/${encodeURIComponent(id)}`),

  workers: () => request<{ paused: boolean; local: boolean; maxChainDepth: number; workers: WorkerStatus[] }>('GET', '/api/workers'),
  setWorkerLimits: (maxChainDepth: number) => request<{ maxChainDepth: number }>('PUT', '/api/workers/limits', { maxChainDepth }),
  pauseWorkers: (paused: boolean) => request<{ paused: boolean }>('POST', '/api/workers/pause', { paused }),
  saveWorker: (slug: string, input: WorkerInput) => request<WorkerStatus>('PUT', `/api/workers/${encodeURIComponent(slug)}`, input),
  deleteWorker: (slug: string) => request<{ deleted: boolean }>('DELETE', `/api/workers/${encodeURIComponent(slug)}`),
  local: () => request<LocalInfo>('GET', '/api/local'),
  browse: (query: { path?: string; mode: 'dir' | 'file'; hidden?: boolean }) => {
    const search = new URLSearchParams({ mode: query.mode });
    if (query.path) search.set('path', query.path);
    if (query.hidden) search.set('hidden', '1');
    return request<BrowseResult>('GET', `/api/local/browse?${search}`);
  },
  connectLocal: (input: ConnectInput) => request<ConnectResult>('POST', '/api/local/connect', input),

  events: (query: { limit?: number; before?: number } = {}) => {
    const search = new URLSearchParams({ limit: String(query.limit ?? 50) });
    if (query.before !== undefined) search.set('before', String(query.before));
    return request<RelayEvent[]>('GET', `/api/events?${search}`);
  },
};
