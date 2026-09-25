import { useEffect, useMemo, useState } from 'react';

import { timeLeft } from '../format';
import { href, type Route } from '../route';
import { attentionFor, LEASE_WARNING_MS, STATUS_ORDER, statePhrase, UPDATE_LABEL, type Attention } from '../tracking';
import type { Agent, TaskStatus, TaskSummary } from '../types';
import { useNow } from '../useRelay';
import { AgentLabel, EmptyState, Icon, PriorityBadge, StatusBadge } from './ui';

type Layout = 'board' | 'list';
type Focus = 'attention' | 'claimed' | 'queued' | 'done';

const COLUMNS: Array<{ id: string; title: string; statuses: TaskStatus[]; empty: string }> = [
  { id: 'queued', title: 'Queued', statuses: ['queued'], empty: 'Nothing waiting' },
  { id: 'claimed', title: 'In progress', statuses: ['claimed'], empty: 'No one is working on anything' },
  { id: 'blocked', title: 'Blocked', statuses: ['blocked'], empty: 'Nothing blocked' },
  { id: 'done', title: 'Done', statuses: ['completed', 'cancelled'], empty: 'Nothing finished yet' },
];

const DONE_LIMIT = 30;
const DAY = 24 * 60 * 60 * 1000;
const LAYOUT_KEY = 'crosschat.tasks.layout';

export function Board({ tasks, agents, route, onNewTask }: { tasks: TaskSummary[]; agents: Agent[]; route: Route; onNewTask: () => void }) {
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [focus, setFocus] = useState<Focus>();
  const [layout, setLayout] = useState<Layout>(() => readLayout());
  const now = useNow(10_000);
  const agentsBySlug = useMemo(() => new Map(agents.map((agent) => [agent.slug, agent])), [agents]);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      // Storage can be unavailable (private windows); the default layout is fine.
    }
  }, [layout]);

  const attention = useMemo(
    () => tasks.map((task) => attentionFor(task, agentsBySlug, now)).filter((item): item is Attention => item !== undefined),
    [tasks, agentsBySlug, now],
  );
  const attentionIds = useMemo(() => new Map(attention.map((item) => [item.task.id, item.tone])), [attention]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return tasks.filter(
      (task) =>
        (!needle || task.title.toLowerCase().includes(needle) || task.latestReport?.message.toLowerCase().includes(needle)) &&
        (!agentFilter || task.senderSlug === agentFilter || task.recipientSlug === agentFilter),
    );
  }, [tasks, search, agentFilter]);

  const counts = {
    attention: attention.length,
    claimed: tasks.filter((task) => task.status === 'claimed').length,
    queued: tasks.filter((task) => task.status === 'queued').length,
    done: tasks.filter((task) => task.status === 'completed' && now - Date.parse(task.updatedAt) < DAY).length,
  };

  const focused = focus ? filtered.filter((task) => matchesFocus(task, focus, attentionIds, now)) : filtered;

  function toggleFocus(next: Focus) {
    setFocus((current) => (current === next ? undefined : next));
    setLayout('list');
  }

  return (
    <section className="view">
      <header className="view-header">
        <div>
          <h1>Tasks</h1>
          <p className="muted">Everything your agents are working on, updated live.</p>
        </div>
        <button type="button" className="button button-primary" onClick={onNewTask}>
          <Icon name="plus" size={16} />
          New task
        </button>
      </header>

      <div className="stats" role="group" aria-label="Task summary">
        <StatTile label="Needs attention" value={counts.attention} tone={counts.attention > 0 ? 'danger' : 'calm'} active={focus === 'attention'} onClick={() => toggleFocus('attention')} />
        <StatTile label="In progress" value={counts.claimed} tone="accent" active={focus === 'claimed'} onClick={() => toggleFocus('claimed')} />
        <StatTile label="Queued" value={counts.queued} tone="info" active={focus === 'queued'} onClick={() => toggleFocus('queued')} />
        <StatTile label="Done today" value={counts.done} tone="success" active={focus === 'done'} onClick={() => toggleFocus('done')} />
      </div>

      {attention.length > 0 && !focus && <AttentionPanel items={attention} agents={agentsBySlug} />}

      <div className="toolbar">
        <label className="search">
          <Icon name="search" size={16} />
          <input type="search" placeholder="Search tasks and updates" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Search tasks and updates" />
        </label>
        <select value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)} aria-label="Filter by agent">
          <option value="">All agents</option>
          {agents.map((agent) => (
            <option key={agent.slug} value={agent.slug}>
              {agent.displayName}
            </option>
          ))}
        </select>
        <div className="segmented layout-toggle" role="group" aria-label="Layout">
          {(['board', 'list'] as const).map((option) => (
            <button key={option} type="button" className={`segment ${layout === option ? 'segment-active' : ''}`} aria-pressed={layout === option} onClick={() => setLayout(option)}>
              {option === 'board' ? 'Board' : 'List'}
            </button>
          ))}
        </div>
      </div>

      {focus && (
        <p className="filter-note">
          Showing <strong>{FOCUS_LABEL[focus]}</strong> ({focused.length}).{' '}
          <button type="button" className="link-button" onClick={() => setFocus(undefined)}>
            Show everything
          </button>
        </p>
      )}

      {tasks.length === 0 ? (
        <EmptyState title="No tasks yet">
          <p>
            Post one yourself with <strong>New task</strong>, or invite agents from the <a href="#/connect">Connect</a> page and let them assign work to each other.
          </p>
        </EmptyState>
      ) : layout === 'list' ? (
        <TaskList tasks={focused} agents={agentsBySlug} selectedId={route.taskId} attentionIds={attentionIds} now={now} />
      ) : (
        <div className="board">
          {COLUMNS.map((column) => {
            const all = focused.filter((task) => column.statuses.includes(task.status));
            const shown = column.id === 'done' ? all.slice(0, DONE_LIMIT) : sortOpen(all);
            return (
              <div key={column.id} className={`column column-${column.id}`}>
                <header className="column-header">
                  <h2>{column.title}</h2>
                  <span className="count">{all.length}</span>
                </header>
                <div className="column-body">
                  {shown.length === 0 && <p className="column-empty">{column.empty}</p>}
                  {shown.map((task) => (
                    <TaskCard key={task.id} task={task} agents={agentsBySlug} selected={route.taskId === task.id} flag={attentionIds.get(task.id)} now={now} />
                  ))}
                  {column.id === 'done' && all.length > DONE_LIMIT && <p className="column-empty">Showing the latest {DONE_LIMIT}</p>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

const FOCUS_LABEL: Record<Focus, string> = {
  attention: 'tasks that need attention',
  claimed: 'tasks in progress',
  queued: 'queued tasks',
  done: 'tasks finished in the last 24 hours',
};

function matchesFocus(task: TaskSummary, focus: Focus, attentionIds: Map<string, Attention['tone']>, now: number): boolean {
  switch (focus) {
    case 'attention':
      return attentionIds.has(task.id);
    case 'claimed':
      return task.status === 'claimed';
    case 'queued':
      return task.status === 'queued';
    case 'done':
      return task.status === 'completed' && now - Date.parse(task.updatedAt) < DAY;
  }
}

function StatTile({ label, value, tone, active, onClick }: { label: string; value: number; tone: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`stat stat-${tone} ${active ? 'stat-active' : ''}`} aria-pressed={active} onClick={onClick}>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </button>
  );
}

function AttentionPanel({ items, agents }: { items: Attention[]; agents: Map<string, Agent> }) {
  return (
    <section className="attention" aria-labelledby="attention-heading">
      <h2 id="attention-heading">Needs your attention</h2>
      <ul>
        {items.map(({ task, reason, detail, tone }) => (
          <li key={task.id}>
            <a className="attention-item" href={href({ view: 'board', taskId: task.id })}>
              <span className={`attention-reason tone-${tone}`}>{reason}</span>
              <span className="attention-text">
                <span className="attention-title">{task.title}</span>
                <span className="attention-detail">{detail}</span>
              </span>
              <span className="attention-who">
                <AgentLabel slug={task.recipientSlug} agent={agents.get(task.recipientSlug)} />
              </span>
              <Icon name="arrow" size={16} />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TaskCard({ task, agents, selected, flag, now }: { task: TaskSummary; agents: Map<string, Agent>; selected: boolean; flag: Attention['tone'] | undefined; now: number }) {
  const leaseMs = task.leaseExpiresAt ? Date.parse(task.leaseExpiresAt) - now : undefined;
  return (
    <a className={`task-card task-${task.status} ${selected ? 'task-card-selected' : ''} ${flag ? `flagged-${flag}` : ''}`} href={href({ view: 'board', taskId: task.id })}>
      <div className="task-card-head">
        <span className="task-card-state">{statePhrase(task, now)}</span>
        <PriorityBadge priority={task.priority} />
      </div>
      <h3 className="task-card-title">{task.title}</h3>
      <Assignment task={task} agents={agents} />
      {task.latestReport ? (
        <p className="task-card-update">
          <span className={`update-kind kind-${task.latestReport.kind}`}>{UPDATE_LABEL[task.latestReport.kind]}</span>
          {task.latestReport.message}
        </p>
      ) : (
        task.status === 'queued' && <p className="task-card-update muted">Not started yet</p>
      )}
      {(task.status === 'claimed' && leaseMs !== undefined) || task.reportCount > 1 ? (
        <div className="task-card-foot">
          {task.status === 'claimed' && task.leaseExpiresAt && (
            <span className={leaseMs !== undefined && leaseMs < LEASE_WARNING_MS ? 'lease lease-warning' : 'lease'}>Lease: {timeLeft(task.leaseExpiresAt, now)}</span>
          )}
          {task.reportCount > 1 && <span>{task.reportCount} updates</span>}
        </div>
      ) : null}
    </a>
  );
}

function TaskList({
  tasks,
  agents,
  selectedId,
  attentionIds,
  now,
}: {
  tasks: TaskSummary[];
  agents: Map<string, Agent>;
  selectedId?: string;
  attentionIds: Map<string, Attention['tone']>;
  now: number;
}) {
  const sorted = [...tasks].sort(
    (a, b) =>
      Number(attentionIds.has(b.id)) - Number(attentionIds.has(a.id)) ||
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      b.priority - a.priority ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
  if (sorted.length === 0) return <EmptyState title="No matching tasks" />;
  return (
    <div className="task-list" role="table" aria-label="Tasks">
      <div className="task-row task-row-head" role="row">
        <span role="columnheader">Task</span>
        <span role="columnheader">Status</span>
        <span role="columnheader">Assigned to</span>
      </div>
      {sorted.map((task) => (
        <a
          key={task.id}
          role="row"
          className={`task-row task-${task.status} ${selectedId === task.id ? 'task-row-selected' : ''} ${attentionIds.has(task.id) ? `flagged-${attentionIds.get(task.id)}` : ''}`}
          href={href({ view: 'board', taskId: task.id })}
        >
          <span role="cell" className="task-row-main">
            <span className="task-row-title">
              {task.title} <PriorityBadge priority={task.priority} />
            </span>
            {task.latestReport && (
              <span className="task-row-update">
                <span className={`update-kind kind-${task.latestReport.kind}`}>{UPDATE_LABEL[task.latestReport.kind]}</span>
                {task.latestReport.message}
              </span>
            )}
          </span>
          <span role="cell" className="task-row-status">
            <StatusBadge status={task.status} />
            <span className="muted small">{statePhrase(task, now)}</span>
          </span>
          <span role="cell" className="task-row-route">
            <Assignment task={task} agents={agents} />
          </span>
        </a>
      ))}
    </div>
  );
}

/** Who is doing the task, in full, with who asked for it underneath. */
function Assignment({ task, agents }: { task: TaskSummary; agents: Map<string, Agent> }) {
  return (
    <div className="assignment">
      <AgentLabel slug={task.recipientSlug} agent={agents.get(task.recipientSlug)} />
      <span className="assignment-from">from {agents.get(task.senderSlug)?.displayName ?? task.senderSlug}</span>
    </div>
  );
}

/** Open work: the most urgent first, then the oldest, matching the claim order. */
function sortOpen(tasks: TaskSummary[]): TaskSummary[] {
  return [...tasks].sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
}

function readLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}
