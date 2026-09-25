import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from './api';
import { Activity } from './components/Activity';
import { Agents } from './components/Agents';
import { Board } from './components/Board';
import { Connect } from './components/Connect';
import { NewTaskDialog } from './components/NewTaskDialog';
import { SignIn } from './components/SignIn';
import { TaskDrawer } from './components/TaskDrawer';
import { Icon, ToastProvider, useToast } from './components/ui';
import { href, navigate, useRoute, type View } from './route';
import { attentionFor } from './tracking';
import type { TaskSummary } from './types';
import { useNow, useRelay, type Connection } from './useRelay';

export function App() {
  const [session, setSession] = useState<'checking' | 'signed-in' | 'signed-out'>('checking');

  useEffect(() => {
    api.session().then(
      (result) => setSession(result.authenticated ? 'signed-in' : 'signed-out'),
      () => setSession('signed-out'),
    );
  }, []);

  const signedOut = useCallback(() => setSession('signed-out'), []);

  return (
    <ToastProvider>
      {session === 'checking' && <div className="splash" aria-busy="true" />}
      {session === 'signed-out' && <SignIn onSignedIn={() => setSession('signed-in')} />}
      {session === 'signed-in' && <Dashboard onSignedOut={signedOut} />}
    </ToastProvider>
  );
}

const NAV: Array<{ view: View; label: string; icon: 'board' | 'agents' | 'activity' | 'plug' }> = [
  { view: 'board', label: 'Tasks', icon: 'board' },
  { view: 'agents', label: 'Agents', icon: 'agents' },
  { view: 'activity', label: 'Activity', icon: 'activity' },
  { view: 'connect', label: 'Connect', icon: 'plug' },
];

function Dashboard({ onSignedOut }: { onSignedOut: () => void }) {
  const toast = useToast();
  const [operatorSlug, setOperatorSlug] = useState<string>();

  // Tell the operator when a task they sent finishes or gets stuck.
  const onTaskChange = useCallback(
    (next: TaskSummary, previous: TaskSummary | undefined) => {
      if (!operatorSlug || next.senderSlug !== operatorSlug || !previous || previous.status === next.status) return;
      const open = { label: 'Open', href: href({ view: 'board', taskId: next.id }) };
      if (next.status === 'completed') toast(`Done: ${next.title}`, 'success', open);
      if (next.status === 'blocked') toast(`Blocked: ${next.title}`, 'error', open);
    },
    [operatorSlug, toast],
  );

  const relay = useRelay(onSignedOut, onTaskChange);
  useEffect(() => setOperatorSlug(relay.overview?.operatorSlug), [relay.overview?.operatorSlug]);

  const route = useRoute();
  const [composing, setComposing] = useState(false);
  const closeTask = useCallback(() => navigate({ view: route.view }), [route.view]);
  const now = useNow(15_000);
  const agentsBySlug = useMemo(() => new Map(relay.agents.map((agent) => [agent.slug, agent])), [relay.agents]);
  const attentionCount = useMemo(
    () => relay.tasks.filter((task) => attentionFor(task, agentsBySlug, now)).length,
    [relay.tasks, agentsBySlug, now],
  );
  const onlineCount = relay.agents.filter((agent) => agent.availability === 'online' && agent.kind === 'agent').length;

  // Keep what needs attention visible from other browser tabs.
  useEffect(() => {
    document.title = attentionCount > 0 ? `(${attentionCount}) Crosschat` : 'Crosschat';
  }, [attentionCount]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={26} height={26} />
          <span>Crosschat</span>
        </div>
        <nav className="nav" aria-label="Main">
          {NAV.map((item) => (
            <a
              key={item.view}
              href={href({ view: item.view })}
              className={`nav-link ${route.view === item.view ? 'nav-link-active' : ''}`}
              aria-current={route.view === item.view ? 'page' : undefined}
            >
              <Icon name={item.icon} />
              <span className="nav-label">{item.label}</span>
              {item.view === 'board' && attentionCount > 0 && (
                <span className="nav-count nav-count-alert" title={`${attentionCount} need attention`}>
                  {attentionCount}
                </span>
              )}
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <LiveIndicator connection={relay.connection} />
          <p className="muted small sidebar-meta">
            {onlineCount} agent{onlineCount === 1 ? '' : 's'} online
          </p>
          <button
            type="button"
            className="button button-small button-ghost"
            onClick={() => {
              void api.signOut().finally(onSignedOut);
            }}
          >
            <Icon name="logout" size={14} />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      <main className="main">
        {route.view === 'board' && <Board tasks={relay.tasks} agents={relay.agents} route={route} onNewTask={() => setComposing(true)} />}
        {route.view === 'agents' && (
          <Agents
            agents={relay.agents}
            tasks={relay.tasks}
            workers={relay.workers}
            workersPaused={relay.workersPaused}
            maxChainDepth={relay.maxChainDepth}
            onMaxChainDepth={relay.setMaxChainDepth}
            local={relay.local}
            {...(operatorSlug ? { operatorSlug } : {})}
          />
        )}
        {route.view === 'activity' && <Activity events={relay.events} agents={relay.agents} onLoadOlder={relay.loadOlderEvents} />}
        {route.view === 'connect' && (
          <Connect
            invites={relay.invites}
            agents={relay.agents}
            local={relay.local}
            {...(operatorSlug ? { operatorSlug } : {})}
            {...(relay.overview ? { version: relay.overview.version } : {})}
          />
        )}
      </main>

      {route.taskId && <TaskDrawer taskId={route.taskId} version={relay.taskVersions[route.taskId] ?? 0} agents={relay.agents} local={relay.local} onClose={closeTask} />}
      {composing && <NewTaskDialog agents={relay.agents} {...(operatorSlug ? { operatorSlug } : {})} onClose={() => setComposing(false)} />}
    </div>
  );
}

function LiveIndicator({ connection }: { connection: Connection }) {
  const label = connection === 'live' ? 'Live' : connection === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  return (
    <p className={`live live-${connection}`} role="status" title={label}>
      <span className="live-dot" />
      <span className="live-label">{label}</span>
    </p>
  );
}
