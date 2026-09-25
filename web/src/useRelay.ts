import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from './api';
import type { ActivityEntry, Agent, Invite, Overview, RelayChange, RelayEvent, TaskSummary, WorkerStatus } from './types';

export type Connection = 'connecting' | 'live' | 'reconnecting';

export interface RelayData {
  overview?: Overview;
  agents: Agent[];
  tasks: TaskSummary[];
  events: RelayEvent[];
  invites: Invite[];
  /** Workers by agent slug. */
  workers: Map<string, WorkerStatus>;
  workersPaused: boolean;
  /** How many agent-to-agent hand-offs worker runs may start. */
  maxChainDepth: number;
  setMaxChainDepth: (value: number) => void;
  /** Whether this dashboard is open on the computer the relay runs on (workers can be set up only there). */
  local: boolean;
  connection: Connection;
  /** Bumps whenever a change touches a task, so an open detail view can refetch. */
  taskVersions: Record<string, number>;
  loadOlderEvents: () => Promise<boolean>;
}

type ActivityListener = (taskId: string, entries: ActivityEntry[]) => void;
const activityListeners = new Set<ActivityListener>();

/** Receive worker-run steps as they stream in. Returns an unsubscribe function. */
export function onActivity(listener: ActivityListener): () => void {
  activityListeners.add(listener);
  return () => activityListeners.delete(listener);
}

const OPEN_STATUSES = 'queued,claimed,blocked';
const FINISHED_STATUSES = 'completed,cancelled';
const MAX_EVENTS_IN_MEMORY = 500;

/**
 * Loads a snapshot of the relay and keeps it current from the live change
 * stream. After the stream reconnects, the snapshot is reloaded so nothing
 * that happened while disconnected is missed.
 */
export function useRelay(
  onUnauthorized: () => void,
  /** Called for every live task change, with the task as it was before (if it was loaded). */
  onTaskChange?: (next: TaskSummary, previous: TaskSummary | undefined) => void,
): RelayData {
  const onTaskChangeRef = useRef(onTaskChange);
  onTaskChangeRef.current = onTaskChange;
  const tasksRef = useRef<Map<string, TaskSummary>>(new Map());
  const [overview, setOverview] = useState<Overview>();
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [tasks, setTasks] = useState<Map<string, TaskSummary>>(new Map());
  const [events, setEvents] = useState<RelayEvent[]>([]);
  const [invites, setInvites] = useState<Map<string, Invite>>(new Map());
  const [workers, setWorkers] = useState<Map<string, WorkerStatus>>(new Map());
  const [workersPaused, setWorkersPaused] = useState(false);
  const [maxChainDepth, setMaxChainDepth] = useState(3);
  const [local, setLocal] = useState(false);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [taskVersions, setTaskVersions] = useState<Record<string, number>>({});

  const loadSnapshot = useCallback(async () => {
    try {
      const [nextOverview, nextAgents, open, finished, nextEvents, nextInvites, nextWorkers] = await Promise.all([
        api.overview(),
        api.agents(),
        api.tasks({ status: OPEN_STATUSES, limit: 500 }),
        api.tasks({ status: FINISHED_STATUSES, limit: 100 }),
        api.events({ limit: 50 }),
        api.invites(),
        api.workers(),
      ]);
      setOverview(nextOverview);
      setAgents(new Map(nextAgents.map((agent) => [agent.slug, agent])));
      setTasks(new Map([...open, ...finished].map((task) => [task.id, task])));
      setEvents(nextEvents);
      setInvites(new Map(nextInvites.map((invite) => [invite.id, invite])));
      setWorkers(new Map(nextWorkers.workers.map((worker) => [worker.agentSlug, worker])));
      setWorkersPaused(nextWorkers.paused);
      setMaxChainDepth(nextWorkers.maxChainDepth);
      setLocal(nextWorkers.local);
    } catch (error: unknown) {
      if ((error as { status?: number }).status === 401) onUnauthorized();
      else throw error;
    }
  }, [onUnauthorized]);

  useEffect(() => {
    let disposed = false;
    let hadError = false;
    void loadSnapshot();

    const source = new EventSource('/api/stream');
    source.onopen = () => {
      if (disposed) return;
      setConnection('live');
      if (hadError) void loadSnapshot();
      hadError = false;
    };
    source.onerror = () => {
      if (disposed) return;
      hadError = true;
      setConnection('reconnecting');
      // A 401 closes the stream for good; check whether the session expired.
      if (source.readyState === EventSource.CLOSED) {
        api.session().then((session) => !session.authenticated && onUnauthorized(), () => undefined);
      }
    };
    source.addEventListener('change', (message) => {
      apply(JSON.parse((message as MessageEvent<string>).data) as RelayChange);
    });

    function apply(change: RelayChange) {
      switch (change.type) {
        case 'task': {
          const previous = tasksRef.current.get(change.task.id);
          // Update the lookup now, not on the next render, so a burst of changes compares correctly.
          tasksRef.current = new Map(tasksRef.current).set(change.task.id, change.task);
          onTaskChangeRef.current?.(change.task, previous);
          setTasks((current) => new Map(current).set(change.task.id, change.task));
          setTaskVersions((current) => ({ ...current, [change.task.id]: (current[change.task.id] ?? 0) + 1 }));
          break;
        }
        case 'tasks-removed':
          setTasks((current) => {
            const next = new Map(current);
            for (const id of change.ids) next.delete(id);
            return next;
          });
          break;
        case 'agent':
          setAgents((current) => new Map(current).set(change.agent.slug, change.agent));
          break;
        case 'agent-removed':
          setAgents((current) => {
            const next = new Map(current);
            next.delete(change.slug);
            return next;
          });
          break;
        case 'invite':
          setInvites((current) => new Map(current).set(change.invite.id, change.invite));
          break;
        case 'worker':
          setWorkers((current) => {
            const next = new Map(current);
            // A worker with no command was removed.
            if (change.worker.command) next.set(change.worker.agentSlug, change.worker);
            else next.delete(change.worker.agentSlug);
            return next;
          });
          break;
        case 'workers-paused':
          setWorkersPaused(change.paused);
          break;
        case 'activity':
          for (const listener of activityListeners) listener(change.taskId, change.entries);
          break;
        case 'event':
          setEvents((current) =>
            current.some((event) => event.sequence === change.event.sequence)
              ? current
              : [change.event, ...current].slice(0, MAX_EVENTS_IN_MEMORY),
          );
          break;
      }
    }

    return () => {
      disposed = true;
      source.close();
    };
  }, [loadSnapshot, onUnauthorized]);

  const loadOlderEvents = useCallback(async () => {
    const oldest = events.at(-1)?.sequence;
    if (oldest === undefined) return false;
    const older = await api.events({ limit: 50, before: oldest });
    setEvents((current) => [...current, ...older.filter((event) => event.sequence < oldest)]);
    return older.length === 50;
  }, [events]);

  const now = useNow(15_000);
  const agentList = useMemo(
    () =>
      [...agents.values()]
        // Presence is only pushed occasionally, so work out "online" here.
        .map((agent) => ({ ...agent, availability: isOnline(agent.lastSeenAt, now) ? 'online' : 'offline' }) as Agent)
        .sort((a, b) => a.slug.localeCompare(b.slug)),
    [agents, now],
  );
  tasksRef.current = tasks;
  const taskList = useMemo(() => [...tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [tasks]);

  const inviteList = useMemo(() => [...invites.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [invites]);

  return {
    overview,
    agents: agentList,
    tasks: taskList,
    events,
    invites: inviteList,
    workers,
    workersPaused,
    maxChainDepth,
    setMaxChainDepth,
    local,
    connection,
    taskVersions,
    loadOlderEvents,
  };
}

const ONLINE_WINDOW_MS = 2 * 60 * 1000;

function isOnline(lastSeenAt: string, now: number): boolean {
  return Date.parse(lastSeenAt) >= now - ONLINE_WINDOW_MS;
}

/** The current time, refreshed every `intervalMs`. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
