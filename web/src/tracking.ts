import { timeAgo } from './format';
import type { Agent, ReportKind, TaskReport, TaskStatus, TaskSummary } from './types';

const MINUTE = 60_000;
/** A queued task counts as stuck after waiting this long for an offline recipient. */
const STUCK_QUEUED_MS = 10 * MINUTE;
/** A lease this close to expiring is shown as a warning. */
export const LEASE_WARNING_MS = 2 * MINUTE;

export interface Attention {
  task: TaskSummary;
  reason: string;
  detail: string;
  tone: 'danger' | 'warning';
}

/** Why a task needs the operator's attention, or undefined if it doesn't. */
export function attentionFor(task: TaskSummary, agents: Map<string, Agent>, now: number): Attention | undefined {
  const recipient = agents.get(task.recipientSlug);
  const recipientName = recipient?.displayName ?? task.recipientSlug;

  if (task.status === 'blocked') {
    return {
      task,
      reason: 'Blocked',
      detail: task.latestReport?.message ?? `${recipientName} reported a blocker.`,
      tone: 'danger',
    };
  }
  if (task.status === 'claimed' && task.leaseExpiresAt && Date.parse(task.leaseExpiresAt) <= now) {
    return {
      task,
      reason: 'Lease expired',
      detail: `${recipientName} stopped reporting. The task goes back to the queue within a minute.`,
      tone: 'warning',
    };
  }
  if (task.status === 'queued' && recipient?.availability === 'offline' && now - Date.parse(task.updatedAt) > STUCK_QUEUED_MS) {
    return {
      task,
      reason: 'Agent offline',
      detail: `${recipientName} was last seen ${timeAgo(recipient.lastSeenAt, now)}.`,
      tone: 'warning',
    };
  }
  return undefined;
}

/** A short phrase for where a task stands, e.g. "Working for 12m". */
export function statePhrase(task: Pick<TaskSummary, 'status' | 'createdAt' | 'updatedAt' | 'claimedAt'>, now: number): string {
  switch (task.status) {
    case 'queued':
      return `Waiting ${duration(now - Date.parse(task.updatedAt))}`;
    case 'claimed':
      return `Working for ${duration(now - Date.parse(task.claimedAt ?? task.updatedAt))}`;
    case 'blocked':
      return `Blocked for ${duration(now - Date.parse(task.updatedAt))}`;
    case 'completed':
      return `Finished ${timeAgo(task.updatedAt, now)}`;
    case 'cancelled':
      return `Cancelled ${timeAgo(task.updatedAt, now)}`;
  }
}

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export const UPDATE_LABEL: Record<ReportKind, string> = { progress: 'Update', completed: 'Done', blocked: 'Blocked', changes: 'Changes requested' };

/** Order for mixed lists: what needs action first, finished work last. */
export const STATUS_ORDER: Record<TaskStatus, number> = { blocked: 0, claimed: 1, queued: 2, completed: 3, cancelled: 4 };

export type TimelineKind = 'created' | 'claimed' | 'progress' | 'requeued' | 'changes' | 'blocked' | 'completed' | 'cancelled';

export interface TimelineEntry {
  key: string;
  kind: TimelineKind;
  title: string;
  message?: string;
  result?: string;
  at: string;
}

/**
 * The task's history as one list, newest first: when it was sent and claimed,
 * plus every report. Requeues and releases are recorded as reports by the
 * relay, so they are recognised by their wording.
 */
export function timeline(
  task: { senderSlug: string; recipientSlug: string; status: TaskStatus; createdAt: string; updatedAt: string; claimedAt?: string; reports: TaskReport[] },
  name: (slug: string) => string,
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    { key: 'created', kind: 'created', title: `${name(task.senderSlug)} sent this to ${name(task.recipientSlug)}`, at: task.createdAt },
  ];
  if (task.claimedAt) {
    entries.push({ key: 'claimed', kind: 'claimed', title: `${name(task.recipientSlug)} started working`, at: task.claimedAt });
  }
  for (const report of task.reports) {
    const requeue = /^(Requeued by|Released:|Lease expired)/.test(report.message);
    const kind: TimelineKind = requeue ? 'requeued' : report.kind;
    const title =
      kind === 'requeued'
        ? 'Back in the queue'
        : kind === 'changes'
          ? `${name(task.senderSlug)} asked for changes`
          : kind === 'completed'
            ? `${name(task.recipientSlug)} finished`
            : kind === 'blocked'
              ? `${name(task.recipientSlug)} is blocked`
              : `${name(task.recipientSlug)} posted an update`;
    entries.push({ key: report.id, kind, title, message: report.message, ...(report.result ? { result: report.result } : {}), at: report.createdAt });
  }
  if (task.status === 'cancelled') {
    entries.push({ key: 'cancelled', kind: 'cancelled', title: 'Cancelled', at: task.updatedAt });
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}
