import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { api } from '../api';
import { fullDate } from '../format';
import type { ActivityEntry } from '../types';
import { onActivity } from '../useRelay';

const KIND_LABEL: Record<ActivityEntry['kind'], string> = {
  start: 'Start',
  message: 'Said',
  thinking: 'Thought',
  plan: 'Plan',
  command: 'Ran',
  tool: 'Tool',
  file: 'File',
  files: 'Files',
  output: 'Output',
  error: 'Problem',
  end: 'End',
};

/** The recorded steps of worker runs on a task, kept current from the live stream. */
export function useTaskActivity(taskId: string, version: number): ActivityEntry[] {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  useEffect(() => onActivity((id, incoming) => id === taskId && setEntries((current) => merge(current, incoming))), [taskId]);

  // Load what was recorded, and again when the task changes (for example, after the stream reconnects).
  useEffect(() => {
    let cancelled = false;
    api.activity(taskId).then(
      (result) => !cancelled && setEntries((current) => merge(current, result.entries)),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [taskId, version]);

  return entries;
}

/**
 * The live view of worker runs on a task: what the harness says, the commands
 * and tools it runs, and the files it changes, as it happens. Shows nothing
 * for tasks that no worker has run.
 */
export function RunActivity({ entries, live }: { entries: ActivityEntry[]; live: boolean }) {
  const listRef = useRef<HTMLOListElement>(null);
  const pinnedToEnd = useRef(true);
  const steps = useMemo(() => collapse(entries), [entries]);
  const running = live && steps.length > 0 && steps.at(-1)?.kind !== 'end';

  // Follow new steps, unless the reader scrolled up to look at earlier ones.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && pinnedToEnd.current) list.scrollTop = list.scrollHeight;
  }, [steps]);

  if (steps.length === 0) return null;

  return (
    <section className="drawer-section" aria-label="Worker run">
      <div className="section-heading">
        <h3>Worker run</h3>
        {running && (
          <span className="live live-live run-live" role="status">
            <span className="live-dot pulse" aria-hidden="true" />
            Live
          </span>
        )}
      </div>
      <ol
        ref={listRef}
        className="run-steps"
        onScroll={(event) => {
          const list = event.currentTarget;
          pinnedToEnd.current = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
        }}
      >
        {steps.map((step) => (
          <RunStep key={step.ref ?? `seq-${step.seq}`} step={step} />
        ))}
      </ol>
    </section>
  );
}

function RunStep({ step }: { step: ActivityEntry }) {
  const time = clock(step.at);
  if (step.kind === 'start' || step.kind === 'end') {
    return (
      <li className={`run-step run-${step.kind} ${step.status ? `run-status-${step.status}` : ''}`}>
        <span className="run-divider-text">{step.text}</span>
        <time title={fullDate(step.at)}>{time}</time>
      </li>
    );
  }
  const body =
    step.kind === 'thinking' ? (
      <details className="run-details">
        <summary>{firstLine(step.text)}</summary>
        <p className="run-text">{step.text}</p>
      </details>
    ) : step.kind === 'command' || step.kind === 'file' || step.kind === 'output' || step.kind === 'plan' ? (
      <pre className="run-code">{step.text}</pre>
    ) : (
      <p className="run-text">{step.text}</p>
    );
  return (
    <li className={`run-step run-${step.kind}`}>
      <span className="run-kind">{KIND_LABEL[step.kind]}</span>
      <div className="run-body">
        {body}
        {step.detail && (
          <details className="run-details">
            <summary>{step.kind === 'command' ? 'Output' : 'Result'}</summary>
            <pre className="run-code run-output">{step.detail}</pre>
          </details>
        )}
      </div>
      <span className="run-meta">
        {step.status && <StepStatus status={step.status} />}
        <time title={fullDate(step.at)}>{time}</time>
      </span>
    </li>
  );
}

function StepStatus({ status }: { status: NonNullable<ActivityEntry['status']> }) {
  if (status === 'running')
    return (
      <span className="run-state run-state-running">
        <span className="pulse" aria-hidden="true" />
        running
      </span>
    );
  return <span className={`run-state run-state-${status}`}>{status === 'ok' ? 'done' : 'failed'}</span>;
}

/** Add entries, keeping each sequence number once, in order. */
function merge(current: ActivityEntry[], incoming: ActivityEntry[]): ActivityEntry[] {
  if (incoming.length === 0) return current;
  const bySeq = new Map(current.map((entry) => [entry.seq, entry]));
  for (const entry of incoming) bySeq.set(entry.seq, entry);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** One row per step: a later entry with the same ref updates the step in place. */
function collapse(entries: ActivityEntry[]): ActivityEntry[] {
  const steps: ActivityEntry[] = [];
  const positions = new Map<string, number>();
  for (const entry of entries) {
    const position = entry.ref === undefined ? undefined : positions.get(entry.ref);
    if (position === undefined) {
      if (entry.ref !== undefined) positions.set(entry.ref, steps.length);
      steps.push(entry);
    } else {
      steps[position] = { ...entry, seq: steps[position]!.seq };
    }
  }
  return steps;
}

function clock(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim()) ?? text;
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}
