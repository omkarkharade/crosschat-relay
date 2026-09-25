import { useState } from 'react';

import { fullDate, timeAgo } from '../format';
import { href } from '../route';
import type { Agent, RelayEvent } from '../types';
import { useNow } from '../useRelay';
import { EmptyState } from './ui';

const EVENT_LABEL: Record<RelayEvent['type'], string> = {
  'task-claimed': 'Claimed',
  'task-progress': 'Progress',
  'task-completed': 'Completed',
  'task-blocked': 'Blocked',
  'task-cancelled': 'Cancelled',
  'task-requeued': 'Requeued',
};

export function Activity({ events, agents, onLoadOlder }: { events: RelayEvent[]; agents: Agent[]; onLoadOlder: () => Promise<boolean> }) {
  const [agentFilter, setAgentFilter] = useState('');
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const now = useNow(15_000);
  const shown = agentFilter ? events.filter((event) => event.recipientSlug === agentFilter) : events;

  return (
    <section className="view">
      <header className="view-header">
        <div>
          <h1>Activity</h1>
          <p className="muted">Every update the relay delivered, newest first.</p>
        </div>
        <select value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)} aria-label="Filter by the agent who was notified">
          <option value="">Delivered to anyone</option>
          {agents.map((agent) => (
            <option key={agent.slug} value={agent.slug}>
              Delivered to {agent.displayName}
            </option>
          ))}
        </select>
      </header>

      {shown.length === 0 ? (
        <EmptyState title="No activity yet">
          <p>Claims, reports, cancellations, and requeues show up here as they happen.</p>
        </EmptyState>
      ) : (
        <ol className="feed">
          {shown.map((event) => (
            <li key={event.sequence} className="feed-item">
              <span className={`feed-type type-${event.type}`}>{EVENT_LABEL[event.type]}</span>
              <a className="feed-summary" href={href({ view: 'activity', taskId: event.taskId })}>
                {event.summary}
              </a>
              <span className="feed-meta">
                <span className="muted">to {event.recipientSlug}</span>
                <time title={fullDate(event.createdAt)}>{timeAgo(event.createdAt, now)}</time>
              </span>
            </li>
          ))}
        </ol>
      )}

      {events.length > 0 && hasMore && !agentFilter && (
        <div className="center">
          <button
            type="button"
            className="button"
            disabled={loading}
            onClick={() => {
              setLoading(true);
              void onLoadOlder()
                .then(setHasMore)
                .finally(() => setLoading(false));
            }}
          >
            {loading ? 'Loading…' : 'Load older'}
          </button>
        </div>
      )}
    </section>
  );
}
