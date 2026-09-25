/**
 * Demo mode: `npm run dev:demo`. Replaces the relay with an in-browser fake
 * API and live stream, seeded with sample agents and tasks and a little
 * simulated activity, so the dashboard can be developed, reviewed, and
 * screenshotted without a relay or a token. Production builds never include
 * this file (see main.tsx).
 */
import type { ActivityEntry, Agent, Invite, LocalInfo, RelayChange, RelayEvent, Task, TaskReport, TaskStatus, TaskSummary, WorkerStatus } from './types';

const MINUTE = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE).toISOString();
const ahead = (minutes: number) => new Date(Date.now() + minutes * MINUTE).toISOString();
let idCounter = 1;
const id = () => `00000000-0000-4000-8000-${String(idCounter++).padStart(12, '0')}`;

const agents: Agent[] = [
  agent('operator', 'Operator', 'human', ['text-input', 'text-output'], 0, 'human', false, 'The person using the Crosschat dashboard.'),
  agent('claude-research', 'Claude (research)', 'claude-opus-5-5', ['text-input', 'text-output', 'web-search'], 0.5, 'agent', true, 'Researches, compares options, and writes summaries.'),
  agent('codex-builder', 'Codex (builder)', 'gpt-5-codex', ['text-input', 'text-output', 'code-execution', 'file-system'], 1, 'agent', true),
  agent('claude-reviewer', 'Claude (reviewer)', 'claude-sonnet-5', ['text-input', 'text-output', 'code-execution'], 1.5, 'agent', true, 'Reviews pull requests and checks results.'),
  agent('gemini-designer', 'Gemini (designer)', 'gemini-3-pro', ['text-input', 'text-output', 'image-input', 'image-output'], 95, 'agent', false),
];

function agent(slug: string, displayName: string, modelSlug: string, capabilities: string[], seenMinutesAgo: number, kind: Agent['kind'], hasToken: boolean, details?: string): Agent {
  return {
    slug,
    kind,
    displayName,
    modelSlug,
    capabilities,
    ...(details ? { details } : {}),
    registeredAt: ago(60 * 24 * 3),
    lastSeenAt: ago(seenMinutesAgo),
    hasToken,
    ownerSet: { displayName: false, details: false },
    availability: seenMinutesAgo < 2 ? 'online' : 'offline',
  };
}

const tasks = new Map<string, Task>();
const events: RelayEvent[] = [];
let sequence = 1;

function report(kind: TaskReport['kind'], message: string, minutesAgo: number, result?: string): TaskReport {
  return { id: id(), kind, message, createdAt: ago(minutesAgo), ...(result ? { result } : {}) };
}

function seed(input: {
  title: string;
  from: string;
  to: string;
  status: TaskStatus;
  priority?: 1 | 2 | 3;
  createdMinutesAgo: number;
  claimedMinutesAgo?: number;
  leaseMinutes?: number;
  instructions: string;
  reports?: TaskReport[];
  /** The title of an already seeded task this one was handed off from. */
  partOf?: string;
}) {
  const reports = input.reports ?? [];
  const parent = input.partOf ? [...tasks.values()].find((task) => task.title === input.partOf) : undefined;
  const updated = reports.at(-1)?.createdAt ?? (input.claimedMinutesAgo !== undefined ? ago(input.claimedMinutesAgo) : ago(input.createdMinutesAgo));
  const task: Task = {
    id: id(),
    senderSlug: input.from,
    recipientSlug: input.to,
    title: input.title,
    instructions: input.instructions,
    requiredCapabilities: [],
    priority: input.priority ?? 2,
    status: input.status,
    createdAt: ago(input.createdMinutesAgo),
    updatedAt: updated,
    ...(input.claimedMinutesAgo !== undefined ? { claimedAt: ago(input.claimedMinutesAgo) } : {}),
    ...(input.leaseMinutes !== undefined ? { leaseExpiresAt: ahead(input.leaseMinutes) } : {}),
    ...(parent ? { parentTaskId: parent.id } : {}),
    depth: parent ? parent.depth + 1 : 0,
    // The demo's builder runs through a worker; everyone else works from a chat.
    ...(input.claimedMinutesAgo !== undefined ? { claimedVia: input.to === 'codex-builder' ? ('worker' as const) : ('chat' as const) } : {}),
    reports,
  };
  tasks.set(task.id, task);
  if (input.claimedMinutesAgo !== undefined) addEvent(task.senderSlug, 'task-claimed', task, `${task.recipientSlug} claimed “${task.title}”.`, input.claimedMinutesAgo);
  for (const item of reports) {
    const type = item.kind === 'completed' ? 'task-completed' : item.kind === 'blocked' ? 'task-blocked' : 'task-progress';
    addEvent(task.senderSlug, type, task, `${task.recipientSlug}: ${item.message}`, (Date.now() - Date.parse(item.createdAt)) / MINUTE);
  }
}

function addEvent(recipientSlug: string, type: RelayEvent['type'], task: Task, summary: string, minutesAgo = 0): RelayEvent {
  const event: RelayEvent = { sequence: sequence++, recipientSlug, type, taskId: task.id, summary, createdAt: ago(minutesAgo) };
  events.push(event);
  return event;
}

seed({
  title: 'Add CSV export to the reports page',
  from: 'claude-research',
  to: 'codex-builder',
  status: 'claimed',
  priority: 3,
  createdMinutesAgo: 42,
  claimedMinutesAgo: 38,
  leaseMinutes: 9,
  instructions: 'Add a "Download CSV" button to /reports that exports exactly the rows currently visible, with the active filters applied.\n\nUse the existing table column labels as CSV headers. Keep it client-side; no new endpoint.',
  reports: [report('progress', 'Button and CSV serializer are in. Now handling filters and large tables (streaming the download).', 6)],
});
seed({
  title: 'Compare vector databases for 40M embeddings',
  from: 'operator',
  to: 'claude-research',
  status: 'blocked',
  createdMinutesAgo: 130,
  claimedMinutesAgo: 120,
  instructions: 'We store ~40M embeddings (1536 dims). Compare pgvector, Qdrant, and LanceDB on monthly cost, p95 query latency, and operational burden. Recommend one.',
  reports: [
    report('progress', 'Collected pricing and benchmark data for all three.', 70),
    report('blocked', 'I need the expected query rate (QPS at peak) to compare latency and cost meaningfully. Please add it and requeue.', 24),
  ],
});
seed({
  title: 'Review PR #214: retry logic for webhooks',
  partOf: 'Add CSV export to the reports page',
  from: 'codex-builder',
  to: 'claude-reviewer',
  status: 'claimed',
  createdMinutesAgo: 18,
  claimedMinutesAgo: 15,
  leaseMinutes: 1,
  instructions: 'Review the retry/backoff changes in PR #214. Focus on idempotency and what happens when the receiver times out after processing.',
  reports: [],
});
seed({
  title: 'Draft onboarding email sequence',
  from: 'operator',
  to: 'gemini-designer',
  status: 'queued',
  priority: 1,
  createdMinutesAgo: 75,
  instructions: 'Three short emails for new trial users: day 0 welcome, day 2 "connect your first agent", day 6 "invite your team". Friendly, under 120 words each.',
});
seed({
  title: 'Upgrade CI runners to Node 24',
  from: 'operator',
  to: 'codex-builder',
  status: 'queued',
  createdMinutesAgo: 9,
  instructions: 'Bump the Node version in every workflow to 24 and fix anything that breaks. Keep the Node 22 test job.',
});
seed({
  title: 'Summarize this week’s customer interviews',
  from: 'operator',
  to: 'claude-research',
  status: 'queued',
  priority: 3,
  createdMinutesAgo: 3,
  instructions: 'Summarize the five interview notes in /research/2026-09 into top pains, surprising quotes, and three product bets.',
});
seed({
  title: 'Fix flaky login test on Windows',
  from: 'claude-reviewer',
  to: 'codex-builder',
  status: 'completed',
  createdMinutesAgo: 300,
  claimedMinutesAgo: 290,
  instructions: 'login.spec.ts fails about 1 in 10 runs on windows-latest. Find the cause and fix it.',
  reports: [
    report('progress', 'Reproduced: the test clicks before the form finishes hydrating.', 260),
    report(
      'completed',
      'Fixed. The test now waits for the form to be interactive.',
      232,
      'Root cause: a race between hydration and the first click.\n\nChanges:\n- login.spec.ts waits for `data-ready="true"` on the form\n- LoginForm sets `data-ready` after hydration\n\nRan the test 200 times on windows-latest: 0 failures.',
    ),
  ],
});
seed({
  title: 'Research pricing for the team plan',
  from: 'operator',
  to: 'claude-research',
  status: 'completed',
  createdMinutesAgo: 1500,
  claimedMinutesAgo: 1480,
  instructions: 'Look at how 6 comparable developer tools price team plans. Suggest a price and the limits that should differ from the free tier.',
  reports: [
    report(
      'completed',
      'Recommendation ready.',
      1400,
      'Suggest $12 per seat per month, billed annually.\n\nMost comparable tools charge $10–15/seat. Differentiators people pay for: SSO, audit log, and more than 5 agents.',
    ),
  ],
});
seed({
  title: 'Generate hero illustration for the landing page',
  from: 'operator',
  to: 'gemini-designer',
  status: 'cancelled',
  createdMinutesAgo: 2000,
  instructions: 'A calm illustration of several robots passing envelopes along a line.',
  reports: [],
});

const OPERATOR = 'operator';

const LOCAL: LocalInfo = {
  hostname: 'studio-pc',
  homeDirectory: 'C:\\Users\\sam',
  mcpUrl: 'http://localhost:4318/mcp',
  harnesses: [
    { id: 'claude-code', name: 'Claude Code', path: 'C:\\Users\\sam\\.local\\bin\\claude.exe', canRun: true, extraDirs: true, safety: 'Can read and edit files in the working folder. Shell commands and other tools that need approval are refused.' },
    { id: 'codex', name: 'Codex', path: 'C:\\Users\\sam\\AppData\\Roaming\\npm\\codex.cmd', canRun: true, extraDirs: true, safety: 'Runs in the Codex workspace-write sandbox: it can change files in the working folder but not elsewhere.' },
    { id: 'gemini', name: 'Gemini CLI', canRun: true, extraDirs: true },
    { id: 'opencode', name: 'OpenCode', path: 'C:\\Users\\sam\\AppData\\Roaming\\npm\\opencode.cmd', canRun: true, extraDirs: false, safety: "Follows OpenCode's own permission settings; Crosschat adds no sandbox of its own." },
    { id: 'zcode', name: 'ZCode', path: 'C:\\Program Files\\ZCode\\resources\\glm\\zcode.cjs', canRun: true, extraDirs: false, safety: "Runs in ZCode's edit mode (not its headless default, yolo): it can read and edit files in the working folder; tools that need approval are refused." },
    { id: 'codewhale', name: 'Codewhale (DeepSeek)', canRun: true, extraDirs: false },
    { id: 'cursor', name: 'Cursor', canRun: false, extraDirs: false },
  ],
};

// A small pretend file system for the folder and program pickers.
const DEMO_FOLDERS: Record<string, string[]> = {
  'C:\\': ['Program Files', 'Tools', 'Users'],
  'C:\\Program Files': ['ZCode'],
  'C:\\Program Files\\ZCode': ['resources', 'ZCode.exe'],
  'C:\\Tools': ['aider.exe', 'my-agent.cmd', 'notes.txt'],
  'C:\\Users': ['sam'],
  'C:\\Users\\sam': ['.config', 'Desktop', 'Documents', 'projects'],
  'C:\\Users\\sam\\.config': [],
  'C:\\Users\\sam\\Desktop': [],
  'C:\\Users\\sam\\Documents': [],
  'C:\\Users\\sam\\projects': ['game', 'website'],
  'C:\\Users\\sam\\projects\\game': ['assets', 'src'],
  'C:\\Users\\sam\\projects\\website': [],
  'C:\\Users\\sam\\projects\\game\\assets': [],
  'C:\\Users\\sam\\projects\\game\\src': [],
};

function demoBrowse(url: URL) {
  const join = (folder: string, name: string) => (folder.endsWith('\\') ? folder + name : `${folder}\\${name}`);
  const path = (url.searchParams.get('path') || LOCAL.homeDirectory).replace(/\\+$/, '') || 'C:\\';
  const key = /^[A-Z]:$/.test(path) ? `${path}\\` : path;
  const names = DEMO_FOLDERS[key];
  if (!names) throw Object.assign(new Error(`${key} doesn't exist.`), { status: 404 });
  const hidden = url.searchParams.get('hidden') === '1';
  const files = url.searchParams.get('mode') === 'file';
  const entries = names
    .filter((name) => hidden || !name.startsWith('.'))
    .map((name) => ({ name, path: join(key, name), kind: (DEMO_FOLDERS[join(key, name)] ? 'dir' : 'file') as 'dir' | 'file' }))
    .filter((entry) => entry.kind === 'dir' || (files && /\.(exe|cmd|bat|cjs|js|mjs)$/i.test(entry.name)));
  const parent = key === 'C:\\' ? undefined : key.slice(0, key.lastIndexOf('\\')) || 'C:\\';
  return {
    path: key,
    ...(parent ? { parent: /^[A-Z]:$/.test(parent) ? `${parent}\\` : parent } : {}),
    entries,
    places: [
      { name: 'Home', path: LOCAL.homeDirectory },
      { name: 'Desktop', path: 'C:\\Users\\sam\\Desktop' },
      { name: 'Documents', path: 'C:\\Users\\sam\\Documents' },
      { name: 'C:\\', path: 'C:\\' },
    ],
    truncated: false,
  };
}

let workersPaused = false;
let maxChainDepth = 3;
const workers = new Map<string, WorkerStatus>();

function worker(agentSlug: string, harness: string, command: string, workdir: string, state: WorkerStatus['state'], extra: Partial<WorkerStatus> = {}): WorkerStatus {
  return {
    agentSlug,
    harness,
    command,
    args: [],
    promptMode: 'stdin',
    workdir,
    allowedSenders: [OPERATOR, 'claude-research'],
    timeoutMinutes: 30,
    enabled: true,
    extraDirs: [],
    maxRunsPerHour: 20,
    exclusive: true,
    createdAt: ago(600),
    updatedAt: ago(600),
    state,
    ...extra,
  };
}

const invites = new Map<string, Invite>();
invites.set('invite-seed', {
  id: 'invite-seed',
  label: 'Codex on the build server',
  createdAt: ago(60 * 24 * 2),
  expiresAt: ago(60 * 24),
  maxUses: 1,
  uses: 1,
  revoked: false,
  active: false,
  agents: ['codex-builder'],
});

/** In the demo, someone "pastes" the invite a few seconds after it is created. */
function simulateJoin(invite: Invite) {
  setTimeout(() => {
    if (!invite.active) return;
    const slug = `claude-code-${Math.random().toString(36).slice(2, 6)}`;
    const joined = agent(
      slug,
      invite.displayName ?? 'Claude Code (laptop)',
      'claude-opus-5-5',
      ['text-input', 'text-output', 'code-execution', 'file-system'],
      0,
      'agent',
      true,
      invite.role ?? 'General coding help.',
    );
    joined.ownerSet = { displayName: Boolean(invite.displayName), details: Boolean(invite.role) };
    agents.push(joined);
    if (invite.firstTask) {
      const time = new Date().toISOString();
      const task: Task = {
        id: id(),
        senderSlug: OPERATOR,
        recipientSlug: slug,
        title: invite.firstTask.title,
        instructions: invite.firstTask.instructions,
        requiredCapabilities: [],
        priority: invite.firstTask.priority,
        status: 'queued',
        createdAt: time,
        updatedAt: time,
        depth: 0,
        reports: [],
      };
      tasks.set(task.id, task);
      changed(task);
    }
    invite.uses += 1;
    invite.agents = [...invite.agents, slug];
    invite.active = invite.maxUses === undefined || invite.uses < invite.maxUses;
    emit({ type: 'agent', agent: joined });
    emit({ type: 'invite', invite: { ...invite } });
  }, 6_000);
}

function summary(task: Task): TaskSummary {
  const { instructions: _instructions, reports, ...rest } = task;
  const latest = reports.at(-1);
  return {
    ...rest,
    reportCount: reports.length,
    ...(latest ? { latestReport: { kind: latest.kind, message: latest.message.replace(/\s+/g, ' ').slice(0, 280), createdAt: latest.createdAt } } : {}),
  };
}

// Workers for two of the agents: one busy with its claimed task, one listening.
{
  const busy = [...tasks.values()].find((task) => task.recipientSlug === 'codex-builder' && task.status === 'claimed');
  workers.set(
    'codex-builder',
    worker('codex-builder', 'codex', LOCAL.harnesses[1]!.path!, 'C:\\Users\\sam\\projects\\game', 'running', busy ? { currentTask: { id: busy.id, title: busy.title, startedAt: busy.claimedAt! } } : {}),
  );
  workers.set(
    'claude-reviewer',
    worker('claude-reviewer', 'claude-code', LOCAL.harnesses[0]!.path!, 'C:\\Users\\sam\\projects\\game', 'idle', {
      lastRun: { taskId: 'x', title: 'Review PR #209', outcome: 'completed', finishedAt: ago(35), summary: 'Approved.' },
    }),
  );
}

// Worker-run steps for the busy worker's task, plus a script that continues it live.
const activity = new Map<string, ActivityEntry[]>();
const RUN_SCRIPT: Array<Omit<ActivityEntry, 'seq' | 'at'>> = [
  { kind: 'command', text: 'npm test -- export', status: 'running', ref: 'r1:item_7' },
  { kind: 'command', text: 'npm test -- export', status: 'ok', ref: 'r1:item_7', detail: ' ✓ exports 50k rows in 1.8s\n ✓ applies status and date filters\n\n Tests  2 passed (2)' },
  { kind: 'message', text: 'The filtered export works on a 50k-row table. Adding a note to the changelog.' },
  { kind: 'file', text: 'Updated CHANGELOG.md', status: 'ok', ref: 'r1:item_9' },
  {
    kind: 'files',
    text: 'Files: 1 added, 3 changed',
    files: [
      { path: 'C:/Users/sam/projects/game/public/export-icon.png', change: 'added', size: 1822 },
      { path: 'C:/Users/sam/projects/game/src/reports/export.ts', change: 'changed', size: 4210 },
      { path: 'C:/Users/sam/projects/game/src/reports/ReportPage.tsx', change: 'changed', size: 9120 },
      { path: 'C:/Users/sam/projects/game/CHANGELOG.md', change: 'changed', size: 2311 },
    ],
  },
];
{
  const busy = [...tasks.values()].find((task) => task.recipientSlug === 'codex-builder' && task.status === 'claimed');
  if (busy) {
    const steps: Array<Omit<ActivityEntry, 'seq' | 'at'>> = [
      { kind: 'start', text: 'Codex started in C:\\Users\\sam\\projects\\game' },
      { kind: 'thinking', text: 'I need to find where the CSV export builds its query, then pass the active filters through.' },
      { kind: 'command', text: 'rg -n "exportCsv" src', status: 'ok', ref: 'r1:item_2', detail: 'src/reports/export.ts:14:export async function exportCsv(table, options) {\nsrc/reports/ReportPage.tsx:88:  await exportCsv(table, { columns });' },
      { kind: 'message', text: 'The export ignores the table filters. I will pass them into the query builder.' },
      { kind: 'file', text: 'Updated src/reports/export.ts\nUpdated src/reports/ReportPage.tsx', status: 'ok', ref: 'r1:item_4' },
    ];
    activity.set(busy.id, steps.map((step, index) => ({ ...step, seq: index + 1, at: ago(30 - index * 4) })));
  }
}

function addActivity(taskId: string, step: Omit<ActivityEntry, 'seq' | 'at'>) {
  const list = activity.get(taskId) ?? [];
  const entry = { ...step, seq: list.length + 1, at: new Date().toISOString() };
  activity.set(taskId, [...list, entry]);
  emit({ type: 'activity', taskId, entries: [entry] });
}

// ------------------------------------------------------------ live stream

const streams = new Set<DemoEventSource>();

function emit(change: RelayChange) {
  for (const stream of streams) stream.deliver(change);
}

function changed(task: Task, event?: RelayEvent) {
  emit({ type: 'task', task: summary(task) });
  if (event) emit({ type: 'event', event });
}

class DemoEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(_url: string) {
    super();
    streams.add(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.(new Event('open'));
    }, 150);
  }

  deliver(change: RelayChange) {
    if (this.readyState !== 1) return;
    this.dispatchEvent(new MessageEvent('change', { data: JSON.stringify(change) }));
  }

  close() {
    this.readyState = 2;
    streams.delete(this);
  }
}

/** A little background activity so the live updates are visible. */
function simulate() {
  const script: Array<() => void> = [
    () => progress('codex-builder', 'Filters applied to the export; testing with a 50k-row table.'),
    () => progress('claude-reviewer', 'Idempotency looks right. Checking the timeout-after-success path next.'),
    () => {
      const task = [...tasks.values()].find((item) => item.recipientSlug === 'codex-builder' && item.status === 'queued');
      if (!task) return;
      const time = new Date().toISOString();
      Object.assign(task, { status: 'claimed', claimedAt: time, updatedAt: time, leaseExpiresAt: ahead(15) });
      changed(task, addEvent(task.senderSlug, 'task-claimed', task, `codex-builder claimed “${task.title}”.`));
    },
    () => complete('claude-reviewer', 'Approved with two small comments.', 'Approve.\n\n1. Log the attempt number on each retry.\n2. Cap total retry time at 10 minutes, not 30.'),
  ];
  // Active agents poll for work, which refreshes their presence.
  setInterval(() => {
    for (const item of agents) {
      if (item.availability !== 'online') continue;
      item.lastSeenAt = new Date().toISOString();
      emit({ type: 'agent', agent: { ...item } });
    }
  }, 30_000);

  let step = 0;
  setInterval(() => {
    script[step % script.length]!();
    step += 1;
  }, 9_000);

  // The busy worker's run continues, one step every few seconds.
  let runStep = 0;
  const runTimer = setInterval(() => {
    const taskId = [...activity.keys()][0];
    const next = RUN_SCRIPT[runStep];
    if (!taskId || !next) return clearInterval(runTimer);
    addActivity(taskId, next);
    runStep += 1;
  }, 4_000);

  function progress(slug: string, message: string) {
    const task = [...tasks.values()].find((item) => item.recipientSlug === slug && item.status === 'claimed');
    if (!task) return;
    const item = report('progress', message, 0);
    task.reports.push(item);
    task.updatedAt = item.createdAt;
    task.leaseExpiresAt = ahead(15);
    changed(task, addEvent(task.senderSlug, 'task-progress', task, `${slug}: ${message}`));
  }

  function complete(slug: string, message: string, result: string) {
    const task = [...tasks.values()].find((item) => item.recipientSlug === slug && item.status === 'claimed');
    if (!task) return;
    const item = report('completed', message, 0, result);
    task.reports.push(item);
    Object.assign(task, { status: 'completed', updatedAt: item.createdAt });
    delete task.leaseExpiresAt;
    changed(task, addEvent(task.senderSlug, 'task-completed', task, `${slug}: ${message}`));
  }
}

// -------------------------------------------------------------- fake API

type Handler = (match: RegExpMatchArray, body: Record<string, unknown>, url: URL) => unknown;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function requireTask(taskId: string): Task {
  const task = tasks.get(taskId);
  if (!task) throw Object.assign(new Error('Unknown task.'), { status: 404 });
  return task;
}

const routes: Array<[string, RegExp, Handler]> = [
  ['GET', /^\/api\/session$/, () => ({ authenticated: true, version: 'demo' })],
  ['DELETE', /^\/api\/session$/, () => ({ authenticated: true })],
  [
    'GET',
    /^\/api\/overview$/,
    () => {
      const counts = { queued: 0, claimed: 0, blocked: 0, completed: 0, cancelled: 0 };
      for (const task of tasks.values()) counts[task.status] += 1;
      return { version: 'demo', operatorSlug: OPERATOR, stats: { tasks: counts, agents: { total: agents.length, online: 3 } } };
    },
  ],
  ['GET', /^\/api\/agents$/, () => agents.map((item) => ({ ...item, lastSeenAt: item.availability === 'online' ? ago(0.5) : item.lastSeenAt }))],
  [
    'POST',
    /^\/api\/agents$/,
    (_match, body) => {
      const created = agent(String(body.slug), String(body.displayName), String(body.modelSlug), body.capabilities as string[], 999, 'agent', true);
      agents.push(created);
      emit({ type: 'agent', agent: created });
      return { agent: created, token: 'cca_demo_token_shown_once_0123456789abcdef' };
    },
  ],
  [
    'PATCH',
    /^\/api\/agents\/([^/]+)$/,
    (match, body) => {
      const target = agents.find((item) => item.slug === match[1]);
      if (!target) throw Object.assign(new Error('Unknown agent.'), { status: 404 });
      if (body.displayName !== undefined) {
        target.displayName = String(body.displayName);
        target.ownerSet = { ...target.ownerSet, displayName: true };
      }
      if (body.details === null) {
        delete target.details;
        target.ownerSet = { ...target.ownerSet, details: false };
      } else if (body.details !== undefined) {
        target.details = String(body.details);
        target.ownerSet = { ...target.ownerSet, details: true };
      }
      emit({ type: 'agent', agent: { ...target } });
      return target;
    },
  ],
  ['POST', /^\/api\/agents\/([^/]+)\/token$/, () => ({ token: 'cca_demo_rotated_token_0123456789abcdef' })],
  ['DELETE', /^\/api\/agents\/([^/]+)\/token$/, () => ({ revoked: true })],
  ['DELETE', /^\/api\/agents\/([^/]+)$/, () => ({ deleted: true })],
  [
    'GET',
    /^\/api\/tasks$/,
    (_match, _body, url) => {
      const statuses = url.searchParams.get('status')?.split(',');
      return [...tasks.values()]
        .filter((task) => !statuses || statuses.includes(task.status))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(summary);
    },
  ],
  ['GET', /^\/api\/tasks\/([^/]+)\/activity$/, (match) => (requireTask(match[1]!), { entries: activity.get(match[1]!) ?? [] })],
  ['GET', /^\/api\/local\/browse$/, (_match, _body, url) => demoBrowse(url)],
  [
    'POST',
    /^\/api\/tasks$/,
    (_match, body) => {
      const time = new Date().toISOString();
      const task: Task = {
        id: id(),
        senderSlug: OPERATOR,
        recipientSlug: String(body.recipientSlug),
        title: String(body.title),
        instructions: String(body.instructions),
        requiredCapabilities: (body.requiredCapabilities as string[]) ?? [],
        priority: (body.priority as 1 | 2 | 3) ?? 2,
        status: 'queued',
        createdAt: time,
        updatedAt: time,
        depth: 0,
        reports: [],
      };
      tasks.set(task.id, task);
      changed(task);
      return task;
    },
  ],
  ['GET', /^\/api\/tasks\/([^/]+)$/, (match) => requireTask(match[1]!)],
  [
    'POST',
    /^\/api\/tasks\/([^/]+)\/cancel$/,
    (match, body) => {
      const task = requireTask(match[1]!);
      Object.assign(task, { status: 'cancelled', updatedAt: new Date().toISOString() });
      delete task.leaseExpiresAt;
      changed(task, addEvent(task.recipientSlug, 'task-cancelled', task, `${task.senderSlug} cancelled “${task.title}”: ${String(body.reason)}`));
      return task;
    },
  ],
  [
    'POST',
    /^\/api\/tasks\/([^/]+)\/requeue$/,
    (match, body) => {
      const task = requireTask(match[1]!);
      const item = report('progress', `Requeued by ${task.senderSlug}: ${String(body.note)}`, 0);
      task.reports.push(item);
      Object.assign(task, { status: 'queued', updatedAt: item.createdAt });
      delete task.claimedAt;
      changed(task, addEvent(task.recipientSlug, 'task-requeued', task, `${task.senderSlug} requeued “${task.title}”: ${String(body.note)}`));
      return task;
    },
  ],
  ['GET', /^\/api\/workers$/, () => ({ paused: workersPaused, local: true, maxChainDepth, workers: [...workers.values()] })],
  ['PUT', /^\/api\/workers\/limits$/, (_match, body) => ((maxChainDepth = Number(body.maxChainDepth)), { maxChainDepth })],
  [
    'GET',
    /^\/api\/tasks\/([^/]+)\/related$/,
    (match) => {
      const task = requireTask(match[1]!);
      const parent = task.parentTaskId ? tasks.get(task.parentTaskId) : undefined;
      return { ...(parent ? { parent: summary(parent) } : {}), children: [...tasks.values()].filter((item) => item.parentTaskId === task.id).map(summary) };
    },
  ],
  [
    'POST',
    /^\/api\/tasks\/([^/]+)\/request-changes$/,
    (match, body) => {
      const task = requireTask(match[1]!);
      const item = report('changes', String(body.note), 0);
      task.reports.push(item);
      Object.assign(task, { status: 'queued', updatedAt: item.createdAt });
      delete task.claimedAt;
      delete task.claimedVia;
      changed(task, addEvent(task.recipientSlug, 'task-requeued', task, `${task.senderSlug} asked for changes to “${task.title}”: ${String(body.note)}`));
      return task;
    },
  ],
  ['POST', /^\/api\/tasks\/([^/]+)\/reveal$/, () => ({ revealed: true })],
  [
    'POST',
    /^\/api\/workers\/pause$/,
    (_match, body) => {
      workersPaused = Boolean(body.paused);
      emit({ type: 'workers-paused', paused: workersPaused });
      for (const item of workers.values()) {
        if (item.state === 'idle' || item.state === 'paused') {
          item.state = workersPaused ? 'paused' : 'idle';
          emit({ type: 'worker', worker: { ...item } });
        }
      }
      return { paused: workersPaused };
    },
  ],
  [
    'PUT',
    /^\/api\/workers\/([^/]+)$/,
    (match, body) => {
      const slug = match[1]!;
      const saved = worker(slug, String(body.harness), String(body.command ?? ''), String(body.workdir), body.enabled === false ? 'disabled' : 'idle', {
        allowedSenders: body.allowedSenders as string[],
        timeoutMinutes: Number(body.timeoutMinutes),
      });
      workers.set(slug, saved);
      emit({ type: 'worker', worker: saved });
      return saved;
    },
  ],
  [
    'DELETE',
    /^\/api\/workers\/([^/]+)$/,
    (match) => {
      const removed = workers.get(match[1]!);
      workers.delete(match[1]!);
      if (removed) emit({ type: 'worker', worker: { ...removed, command: '' } });
      return { deleted: true };
    },
  ],
  ['GET', /^\/api\/local$/, () => LOCAL],
  [
    'POST',
    /^\/api\/local\/connect$/,
    (_match, body) => {
      const harness = LOCAL.harnesses.find((item) => item.id === body.harness);
      const created = agent(String(body.slug), String(body.displayName), harness?.name ?? 'custom', ['text-input', 'text-output', 'code-execution', 'file-system'], 0, 'agent', true, body.role ? String(body.role) : undefined);
      agents.push(created);
      emit({ type: 'agent', agent: created });
      const settings = body.worker as { workdir: string; allowedSenders: string[]; timeoutMinutes: number; command?: string } | undefined;
      let saved: WorkerStatus | undefined;
      if (settings) {
        saved = worker(created.slug, String(body.harness), settings.command ?? harness?.path ?? '', settings.workdir, 'idle', {
          allowedSenders: settings.allowedSenders,
          timeoutMinutes: settings.timeoutMinutes,
        });
        workers.set(created.slug, saved);
        emit({ type: 'worker', worker: saved });
      }
      const configured = body.configureClient === true && body.harness === 'claude-code';
      return {
        agent: created,
        connection: configured
          ? { configured: true, message: 'Added the relay to Claude Code for your user (claude mcp add --scope user). Restart open Claude Code sessions to load it.' }
          : { configured: false, message: 'Add the relay to this harness yourself with the details below.', snippet: '{ "mcpServers": { "crosschat": { "url": "http://localhost:4318/mcp" } } }' },
        ...(configured ? {} : { token: 'cca_demo_token_shown_once_0123456789abcdef' }),
        ...(saved ? { worker: saved } : {}),
      };
    },
  ],
  ['GET', /^\/api\/invites$/, () => [...invites.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))],
  [
    'POST',
    /^\/api\/invites$/,
    (_match, body) => {
      const invite: Invite = {
        id: id(),
        ...(body.label ? { label: String(body.label) } : {}),
        createdAt: new Date().toISOString(),
        expiresAt: ahead(Number(body.expiresInHours) * 60),
        ...(body.maxUses ? { maxUses: Number(body.maxUses) } : {}),
        ...(body.displayName ? { displayName: String(body.displayName) } : {}),
        ...(body.role ? { role: String(body.role) } : {}),
        ...(body.firstTask ? { firstTask: body.firstTask as Invite['firstTask'] } : {}),
        uses: 0,
        revoked: false,
        active: true,
        agents: [],
      };
      invites.set(invite.id, invite);
      emit({ type: 'invite', invite: { ...invite } });
      simulateJoin(invite);
      return { invite, code: 'cci_demo_invite_code_0123456789abcdef' };
    },
  ],
  [
    'DELETE',
    /^\/api\/invites\/([^/]+)$/,
    (match) => {
      const invite = invites.get(match[1]!);
      if (!invite) throw Object.assign(new Error('Unknown invite.'), { status: 404 });
      Object.assign(invite, { revoked: true, active: false });
      emit({ type: 'invite', invite: { ...invite } });
      return invite;
    },
  ],
  [
    'GET',
    /^\/api\/events$/,
    (_match, _body, url) => {
      const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      return [...events].reverse().filter((event) => event.sequence < before).slice(0, limit);
    },
  ],
];

export function installDemo(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    await new Promise((resolve) => setTimeout(resolve, 120));
    for (const [routeMethod, pattern, handler] of routes) {
      const match = url.pathname.match(pattern);
      if (!match || routeMethod !== method) continue;
      try {
        return json(200, handler(match, body, url));
      } catch (error: unknown) {
        return json((error as { status?: number }).status ?? 500, { error: 'demo_error', message: (error as Error).message });
      }
    }
    return json(404, { error: 'not_found', message: 'Not available in demo mode.' });
  };
  window.EventSource = DemoEventSource as unknown as typeof EventSource;
  simulate();
}
