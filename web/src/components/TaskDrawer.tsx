import { useEffect, useState } from 'react';

import { api } from '../api';
import { fullDate, PRIORITY_LABEL, timeAgo, timeLeft } from '../format';
import { href } from '../route';
import { LEASE_WARNING_MS, statePhrase, timeline, type TimelineEntry } from '../tracking';
import type { Agent, Task, TaskSummary } from '../types';
import { RunActivity, useTaskActivity } from './RunActivity';
import { TaskFiles } from './TaskFiles';
import { useNow } from '../useRelay';
import { AgentLabel, CopyButton, errorMessage, Icon, Modal, PriorityBadge, StatusBadge, useToast } from './ui';

type Action = 'cancel' | 'requeue' | 'changes';

export function TaskDrawer({ taskId, version, agents, local, onClose }: { taskId: string; version: number; agents: Agent[]; local: boolean; onClose: () => void }) {
  const [task, setTask] = useState<Task>();
  const [related, setRelated] = useState<{ parent?: TaskSummary; children: TaskSummary[] }>({ children: [] });
  const activity = useTaskActivity(taskId, version);
  const [error, setError] = useState<string>();
  const [action, setAction] = useState<Action>();
  const now = useNow(10_000);
  const agentsBySlug = new Map(agents.map((agent) => [agent.slug, agent]));
  const name = (slug: string) => agentsBySlug.get(slug)?.displayName ?? slug;

  // Refetch whenever the live stream reports a change to this task.
  useEffect(() => {
    let cancelled = false;
    api.task(taskId).then(
      (loaded) => !cancelled && (setTask(loaded), setError(undefined)),
      (failure: unknown) => !cancelled && setError(errorMessage(failure)),
    );
    api.related(taskId).then((loaded) => !cancelled && setRelated(loaded), () => undefined);
    return () => {
      cancelled = true;
    };
  }, [taskId, version]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && !action && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, action]);

  const finalReport = task?.reports.findLast((report) => report.kind === 'completed');
  const blocker = task?.status === 'blocked' ? task.reports.findLast((report) => report.kind === 'blocked') : undefined;
  const open = task && (task.status === 'queued' || task.status === 'claimed' || task.status === 'blocked');
  const leaseMs = task?.leaseExpiresAt ? Date.parse(task.leaseExpiresAt) - now : undefined;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" aria-label="Task details">
        <header className="drawer-header">
          <div className="drawer-badges">
            {task && <StatusBadge status={task.status} />}
            {task && <PriorityBadge priority={task.priority} />}
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close task details">
            <Icon name="close" />
          </button>
        </header>

        {error && <p className="form-error">{error}</p>}
        {!task && !error && <p className="muted">Loading…</p>}

        {task && (
          <div className="drawer-body">
            <div>
              <h2 className="drawer-title">{task.title}</h2>
              <p className="muted drawer-state">{statePhrase(task, now)}</p>
            </div>

            <Stepper status={task.status} />

            <div className="people">
              <div className="person">
                <span className="person-role">From</span>
                <AgentLabel slug={task.senderSlug} agent={agentsBySlug.get(task.senderSlug)} />
              </div>
              <Icon name="arrow" size={16} />
              <div className="person">
                <span className="person-role">To</span>
                <AgentLabel slug={task.recipientSlug} agent={agentsBySlug.get(task.recipientSlug)} />
              </div>
            </div>

            {blocker && (
              <section className="callout callout-danger">
                <h3>Blocked</h3>
                <p className="prose-plain">{blocker.message}</p>
                <div className="callout-actions">
                  <button type="button" className="button button-primary" onClick={() => setAction('requeue')}>
                    Resolve and requeue
                  </button>
                  <button type="button" className="button" onClick={() => setAction('cancel')}>
                    Cancel task
                  </button>
                </div>
              </section>
            )}

            {finalReport && (
              <section className="callout callout-success">
                <div className="section-heading">
                  <h3>Result</h3>
                  <div className="section-actions">
                    {task.status === 'completed' && (
                      <button type="button" className="button button-small" onClick={() => setAction('changes')}>
                        Request changes
                      </button>
                    )}
                    <CopyButton text={finalReport.result ?? finalReport.message} />
                  </div>
                </div>
                {finalReport.result ? (
                  <>
                    <p className="callout-lead">{finalReport.message}</p>
                    <div className="prose">{finalReport.result}</div>
                  </>
                ) : (
                  <p className="prose-plain">{finalReport.message}</p>
                )}
              </section>
            )}

            <TaskFiles key={task.id} taskId={task.id} entries={activity} local={local} />

            {(related.parent || related.children.length > 0) && (
              <section className="drawer-section" aria-label="Related tasks">
                <h3>Related tasks</h3>
                <ul className="related-tasks">
                  {related.parent && <RelatedTask label="Part of" task={related.parent} name={name} />}
                  {related.children.map((child) => (
                    <RelatedTask key={child.id} label="Handed off" task={child} name={name} />
                  ))}
                </ul>
              </section>
            )}

            <dl className="facts">
              <dt>Priority</dt>
              <dd>{PRIORITY_LABEL[task.priority]}</dd>
              <dt>Sent</dt>
              <dd title={fullDate(task.createdAt)}>{timeAgo(task.createdAt, now)}</dd>
              {task.claimedVia && (task.status === 'claimed' || task.status === 'completed' || task.status === 'blocked') && (
                <>
                  <dt>Picked up by</dt>
                  <dd>{task.claimedVia === 'worker' ? `${name(task.recipientSlug)}'s worker (runs automatically)` : `a ${name(task.recipientSlug)} chat session`}</dd>
                </>
              )}
              {task.depth > 0 && (
                <>
                  <dt>Hand-offs</dt>
                  <dd>{task.depth === 1 ? '1 agent-to-agent hand-off' : `${task.depth} agent-to-agent hand-offs`} from the first task</dd>
                </>
              )}
              {task.status === 'claimed' && task.leaseExpiresAt && (
                <>
                  <dt>Lease</dt>
                  <dd title={fullDate(task.leaseExpiresAt)} className={leaseMs !== undefined && leaseMs < LEASE_WARNING_MS ? 'warning-text' : undefined}>
                    {timeLeft(task.leaseExpiresAt, now)}
                  </dd>
                </>
              )}
              {task.requiredCapabilities.length > 0 && (
                <>
                  <dt>Needs</dt>
                  <dd>{task.requiredCapabilities.join(', ')}</dd>
                </>
              )}
            </dl>

            {open && !blocker && (
              <div className="drawer-actions">
                <button type="button" className="button button-quiet-danger" onClick={() => setAction('cancel')}>
                  Cancel task
                </button>
              </div>
            )}

            <RunActivity entries={activity} live={task.status === 'claimed'} />

            <section className="drawer-section">
              <div className="section-heading">
                <h3>Instructions</h3>
                <CopyButton text={task.instructions} />
              </div>
              <div className="prose">{task.instructions}</div>
            </section>

            <section className="drawer-section">
              <h3>Activity</h3>
              <ol className="timeline">
                {timeline(task, name).map((entry) => (
                  <TimelineItem key={entry.key} entry={entry} now={now} hideResult={entry.key === finalReport?.id} />
                ))}
              </ol>
            </section>
          </div>
        )}
      </aside>

      {task && action && <TaskActionDialog task={task} action={action} recipientName={name(task.recipientSlug)} onDone={() => setAction(undefined)} />}
    </>
  );
}

function RelatedTask({ label, task, name }: { label: string; task: TaskSummary; name: (slug: string) => string }) {
  return (
    <li>
      <span className="related-label">{label}</span>
      <a href={href({ view: 'board', taskId: task.id })} className="related-link">
        {task.title}
      </a>
      <span className="muted related-meta">
        {name(task.senderSlug)} → {name(task.recipientSlug)} · <StatusBadge status={task.status} />
      </span>
    </li>
  );
}

const STEPS = ['Queued', 'In progress', 'Done'];

function Stepper({ status }: { status: Task['status'] }) {
  const current = status === 'queued' ? 0 : status === 'claimed' || status === 'blocked' ? 1 : 2;
  return (
    <ol className={`stepper stepper-${status}`} aria-label="Progress">
      {STEPS.map((label, index) => {
        const finished = status === 'completed' && index === current;
        const state = index < current || finished ? 'done' : index === current ? 'current' : 'todo';
        const text = index === 1 && status === 'blocked' ? 'Blocked' : index === 2 && status === 'cancelled' ? 'Cancelled' : label;
        return (
          <li key={label} className={`step-item step-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="step-dot">{state === 'done' ? <Icon name="check" size={12} /> : index + 1}</span>
            <span className="step-label">{text}</span>
          </li>
        );
      })}
    </ol>
  );
}

function TimelineItem({ entry, now, hideResult }: { entry: TimelineEntry; now: number; hideResult: boolean }) {
  return (
    <li className={`timeline-item entry-${entry.kind}`}>
      <span className="timeline-marker" aria-hidden="true" />
      <div className="timeline-content">
        <div className="timeline-head">
          <span className="timeline-title">{entry.title}</span>
          <time title={fullDate(entry.at)}>{timeAgo(entry.at, now)}</time>
        </div>
        {entry.message && <p className="prose-plain">{entry.message}</p>}
        {entry.result && !hideResult && <div className="prose">{entry.result}</div>}
      </div>
    </li>
  );
}

function TaskActionDialog({ task, action, recipientName, onDone }: { task: Task; action: Action; recipientName: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toast = useToast();
  const isCancel = action === 'cancel';

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      if (isCancel) await api.cancelTask(task.id, text);
      else if (action === 'changes') await api.requestChanges(task.id, text);
      else await api.requeueTask(task.id, text);
      toast(isCancel ? 'Task cancelled.' : `Sent back to ${recipientName}.`);
      onDone();
    } catch (failure: unknown) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={isCancel ? 'Cancel this task?' : action === 'changes' ? 'Request changes' : 'Resolve the blocker'}
      onClose={onDone}
      footer={
        <>
          <button type="button" className="button" onClick={onDone}>
            Back
          </button>
          <button type="submit" form="task-action" className={`button ${isCancel ? 'button-danger' : 'button-primary'}`} disabled={busy || !text.trim()}>
            {isCancel ? 'Cancel task' : action === 'changes' ? 'Send back' : 'Requeue'}
          </button>
        </>
      }
    >
      <form
        id="task-action"
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="muted">
          {isCancel
            ? `${recipientName} gets one update with your reason. This can't be undone.`
            : action === 'changes'
              ? `The task reopens for ${recipientName} with its earlier result and your notes, so the next round builds on it.`
              : `The task goes back to ${recipientName}'s queue with your note, so it can pick up where it stopped.`}
        </p>
        <label className="field">
          <span>{isCancel ? 'Reason' : action === 'changes' ? 'What to change' : 'What changed'}</span>
          <textarea rows={4} value={text} onChange={(event) => setText(event.target.value)} placeholder={isCancel ? '' : 'For example: peak load is about 300 queries per second.'} required />
        </label>
        {error && <p className="form-error">{error}</p>}
      </form>
    </Modal>
  );
}
