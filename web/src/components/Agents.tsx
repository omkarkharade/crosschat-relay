import { useState } from 'react';

import { api } from '../api';
import { fullDate, timeAgo } from '../format';
import { agentInstructions, clientSnippets, mcpUrl } from '../snippets';
import { href } from '../route';
import { DEFAULT_CAPABILITIES, type Agent, type TaskSummary, type WorkerStatus } from '../types';
import { useNow } from '../useRelay';
import { WorkerDialog, WorkerLine } from './Workers';
import { AvailabilityDot, Avatar, Chip, CodeBlock, EmptyState, errorMessage, Icon, Modal, Tabs, useToast } from './ui';

type Pending = { kind: 'rotate' | 'revoke' | 'delete'; agent: Agent };

/** How many times agents' workers may pass work on to another agent, so two agents can't keep each other busy forever. */
function HandOffLimitDialog({ value, onSaved, onClose }: { value: number; onSaved: (value: number) => void; onClose: () => void }) {
  const [limit, setLimit] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toast = useToast();

  async function save() {
    setBusy(true);
    try {
      const result = await api.setWorkerLimits(limit);
      onSaved(result.maxChainDepth);
      toast('Hand-off limit saved.');
      onClose();
    } catch (failure: unknown) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Hand-off limit"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="hand-off-limit" className="button button-primary" disabled={busy}>
            Save
          </button>
        </>
      }
    >
      <form
        id="hand-off-limit"
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="muted">
          While a worker runs a task, its agent can hand parts of the work to other agents, and they can hand work on again. This sets how many hand-offs deep that may go
          from the task you (or a chat) started. Past the limit, the agent has to do the work itself or report that it's blocked.
        </p>
        <label className="field field-narrow">
          <span>Most hand-offs in a row</span>
          <input type="number" min={0} max={10} value={limit} onChange={(event) => setLimit(Math.min(10, Math.max(0, Number(event.target.value) || 0)))} />
        </label>
        <small className="muted">0 means workers never hand work to another agent. Each worker's hourly run limit applies as well.</small>
        {error && <p className="form-error">{error}</p>}
      </form>
    </Modal>
  );
}

export function Agents({
  agents,
  tasks,
  workers,
  workersPaused,
  maxChainDepth,
  onMaxChainDepth,
  local,
  operatorSlug,
}: {
  agents: Agent[];
  tasks: TaskSummary[];
  workers: Map<string, WorkerStatus>;
  workersPaused: boolean;
  maxChainDepth: number;
  onMaxChainDepth: (value: number) => void;
  local: boolean;
  operatorSlug?: string;
}) {
  const [creating, setCreating] = useState(false);
  const [limits, setLimits] = useState(false);
  const [revealed, setRevealed] = useState<{ slug: string; token: string; isNew: boolean }>();
  const [pending, setPending] = useState<Pending>();
  const [editing, setEditing] = useState<Agent>();
  const [configuring, setConfiguring] = useState<Agent>();
  const toast = useToast();
  const now = useNow(15_000);

  return (
    <section className="view">
      <header className="view-header">
        <div>
          <h1>Agents</h1>
          <p className="muted">
            Each agent has its own token, so it can only act as itself. The easiest way to add one is an{' '}
            <a href="#/connect">invite message</a> the agent uses to connect itself.
          </p>
        </div>
        <div className="header-actions">
          {workers.size > 0 && (
            <button
              type="button"
              className={`button ${workersPaused ? 'button-primary' : ''}`}
              onClick={() => {
                api.pauseWorkers(!workersPaused).then(
                  (result) => toast(result.paused ? 'Workers paused. Tasks wait in the queue.' : 'Workers resumed.'),
                  (failure: unknown) => toast(errorMessage(failure), 'error'),
                );
              }}
            >
              {workersPaused ? 'Resume workers' : 'Pause all workers'}
            </button>
          )}
          {workers.size > 0 && local && (
            <button type="button" className="button" onClick={() => setLimits(true)} title="How far agents may hand work to each other">
              Hand-off limit: {maxChainDepth}
            </button>
          )}
          <button type="button" className="button button-primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} />
            Add agent
          </button>
        </div>
      </header>
      {workersPaused && <div className="notice">Workers are paused: no task runs automatically until you resume them.</div>}
      {limits && <HandOffLimitDialog value={maxChainDepth} onSaved={onMaxChainDepth} onClose={() => setLimits(false)} />}

      {agents.length === 0 ? (
        <EmptyState title="No agents yet" />
      ) : (
        <div className="agent-grid">
          {agents.map((agent) => {
            const isOperator = agent.slug === operatorSlug;
            const working = tasks.filter((task) => task.recipientSlug === agent.slug && task.status === 'claimed');
            const queued = tasks.filter((task) => task.recipientSlug === agent.slug && task.status === 'queued').length;
            return (
              <article key={agent.slug} className="agent-card">
                <header className="agent-card-header">
                  <Avatar slug={agent.slug} name={agent.displayName} size="large" />
                  <div className="agent-name">
                    <h2>
                      <AvailabilityDot online={agent.availability === 'online'} />
                      {agent.displayName}
                      {agent.ownerSet.displayName && <span className="owner-set" title="You set this name; the agent can't change it.">set by you</span>}
                    </h2>
                    <p className="mono muted">{agent.slug}</p>
                  </div>
                  {isOperator ? <span className="badge">You</span> : agent.kind === 'human' ? <span className="badge">Human</span> : null}
                </header>

                {agent.kind === 'agent' && (
                  <div className="agent-now">
                    <span className="agent-now-label">Now</span>
                    {working.length > 0 ? (
                      <span className="agent-now-tasks">
                        {working.map((task) => (
                          <a key={task.id} href={href({ view: 'board', taskId: task.id })}>
                            {task.title}
                          </a>
                        ))}
                      </span>
                    ) : (
                      <span className="muted">Idle</span>
                    )}
                    {queued > 0 && (
                      <span className="agent-now-queue">
                        {queued} queued
                      </span>
                    )}
                  </div>
                )}

                <dl className="facts facts-compact">
                  <dt>Model</dt>
                  <dd className="mono">{agent.modelSlug}</dd>
                  <dt>Last seen</dt>
                  <dd title={fullDate(agent.lastSeenAt)}>{timeAgo(agent.lastSeenAt, now)}</dd>
                  {agent.kind === 'agent' && (
                    <>
                      <dt>Token</dt>
                      <dd>{agent.hasToken ? 'Issued' : <span className="warning-text">None (uses the admin token)</span>}</dd>
                    </>
                  )}
                </dl>

                {agent.details && (
                  <p className="agent-details">
                    {agent.ownerSet.details && <span className="agent-role-label">Role</span>}
                    {agent.details}
                  </p>
                )}

                {workers.get(agent.slug) && <WorkerLine worker={workers.get(agent.slug)!} />}

                <div className="chips">
                  {agent.capabilities.map((capability) => (
                    <Chip key={capability}>{capability}</Chip>
                  ))}
                </div>

                {agent.kind === 'agent' && (
                  <footer className="agent-actions">
                    <button type="button" className="button button-small" onClick={() => setEditing(agent)}>
                      <Icon name="edit" size={14} />
                      Edit
                    </button>
                    {local && (
                      <button type="button" className="button button-small" onClick={() => setConfiguring(agent)}>
                        <Icon name="play" size={14} />
                        {workers.has(agent.slug) ? 'Auto-run…' : 'Run automatically…'}
                      </button>
                    )}
                    <button type="button" className="button button-small" onClick={() => setPending({ kind: 'rotate', agent })}>
                      <Icon name="key" size={14} />
                      {agent.hasToken ? 'New token' : 'Issue token'}
                    </button>
                    {agent.hasToken && (
                      <button type="button" className="button button-small" onClick={() => setPending({ kind: 'revoke', agent })}>
                        Revoke
                      </button>
                    )}
                    <button type="button" className="button button-small button-quiet-danger" onClick={() => setPending({ kind: 'delete', agent })}>
                      <Icon name="trash" size={14} />
                      Delete
                    </button>
                  </footer>
                )}
              </article>
            );
          })}
        </div>
      )}

      {creating && (
        <NewAgentDialog
          onClose={() => setCreating(false)}
          onCreated={(slug, token) => {
            setCreating(false);
            if (token) setRevealed({ slug, token, isNew: true });
          }}
        />
      )}
      {pending && (
        <ConfirmAgentAction
          pending={pending}
          onClose={() => setPending(undefined)}
          onToken={(slug, token) => {
            setPending(undefined);
            setRevealed({ slug, token, isNew: false });
          }}
        />
      )}
      {revealed && <TokenReveal {...revealed} onClose={() => setRevealed(undefined)} />}
      {editing && <EditAgentDialog agent={editing} onClose={() => setEditing(undefined)} />}
      {configuring && (
        <WorkerDialog
          agent={configuring}
          {...(workers.get(configuring.slug) ? { worker: workers.get(configuring.slug)! } : {})}
          agents={agents}
          {...(operatorSlug ? { operatorSlug } : {})}
          onClose={() => setConfiguring(undefined)}
        />
      )}
    </section>
  );
}

function EditAgentDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [displayName, setDisplayName] = useState(agent.displayName);
  const [role, setRole] = useState(agent.details ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toast = useToast();

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const nameChanged = displayName.trim() !== agent.displayName;
      const roleChanged = role.trim() !== (agent.details ?? '');
      await api.updateAgent(agent.slug, {
        ...(nameChanged ? { displayName: displayName.trim() } : {}),
        // An empty role hands the description back to the agent.
        ...(roleChanged ? { details: role.trim() ? role.trim() : null } : {}),
      });
      toast(`Updated ${displayName.trim()}.`);
      onClose();
    } catch (failure: unknown) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  const unchanged = displayName.trim() === agent.displayName && role.trim() === (agent.details ?? '');

  return (
    <Modal
      title={`How others see ${agent.slug}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="edit-agent" className="button button-primary" disabled={busy || !displayName.trim() || unchanged}>
            Save
          </button>
        </>
      }
    >
      <form
        id="edit-agent"
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>Display name</span>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={500} required />
        </label>
        <label className="field">
          <span>Role</span>
          <textarea
            rows={3}
            value={role}
            onChange={(event) => setRole(event.target.value)}
            maxLength={2000}
            placeholder="What it works on and which tasks to send it."
          />
          <small className="muted">Other agents see this in list_agents when deciding whom to send work to. Leave it empty to let the agent describe itself.</small>
        </label>
        <p className="muted small">Names and roles you set here are kept when the agent registers again. Its slug ({agent.slug}) never changes.</p>
        {error && <p className="form-error">{error}</p>}
      </form>
    </Modal>
  );
}

function NewAgentDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (slug: string, token?: string) => void }) {
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [modelSlug, setModelSlug] = useState('');
  const [capabilities, setCapabilities] = useState<string[]>(['text-input', 'text-output']);
  const [custom, setCustom] = useState('');
  const [details, setDetails] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toast = useToast();
  const options = [...new Set([...DEFAULT_CAPABILITIES, ...capabilities])];

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const { agent, token } = await api.createAgent({
        slug: slug.trim().toLowerCase(),
        displayName,
        modelSlug,
        capabilities,
        ...(details.trim() ? { details } : {}),
      });
      toast(`Added ${agent.displayName}.`);
      onCreated(agent.slug, token);
    } catch (failure: unknown) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add an agent"
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="new-agent"
            className="button button-primary"
            disabled={busy || !slug.trim() || !displayName.trim() || !modelSlug.trim() || capabilities.length === 0}
          >
            {busy ? 'Adding…' : 'Add and issue token'}
          </button>
        </>
      }
    >
      <form
        id="new-agent"
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field-row">
          <label className="field">
            <span>Slug</span>
            <input
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              placeholder="claude-research"
              pattern="[a-z0-9][a-z0-9._:\-]{1,79}"
              title="2–80 lowercase letters, digits, dots, underscores, colons, or hyphens"
              required
            />
            <small className="muted">The agent's address. It can't be changed later.</small>
          </label>
          <label className="field">
            <span>Display name</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Claude (research)" required />
          </label>
        </div>
        <label className="field">
          <span>Model</span>
          <input value={modelSlug} onChange={(event) => setModelSlug(event.target.value)} placeholder="claude-opus-5-5" required />
        </label>
        <fieldset className="field">
          <legend>Capabilities</legend>
          <div className="checks">
            {options.map((capability) => (
              <label key={capability} className="check">
                <input
                  type="checkbox"
                  checked={capabilities.includes(capability)}
                  onChange={(event) =>
                    setCapabilities((current) => (event.target.checked ? [...current, capability] : current.filter((item) => item !== capability)))
                  }
                />
                {capability}
              </label>
            ))}
          </div>
          <div className="inline-add">
            <input value={custom} onChange={(event) => setCustom(event.target.value)} placeholder="Add a custom capability" aria-label="Custom capability" />
            <button
              type="button"
              className="button button-small"
              disabled={!custom.trim()}
              onClick={() => {
                const value = custom.trim().toLowerCase();
                setCapabilities((current) => (current.includes(value) ? current : [...current, value]));
                setCustom('');
              }}
            >
              Add
            </button>
          </div>
        </fieldset>
        <label className="field">
          <span>Details (optional)</span>
          <textarea rows={2} value={details} onChange={(event) => setDetails(event.target.value)} maxLength={2000} placeholder="What this agent is good at." />
        </label>
        {error && <p className="form-error">{error}</p>}
      </form>
    </Modal>
  );
}

function ConfirmAgentAction({ pending, onClose, onToken }: { pending: Pending; onClose: () => void; onToken: (slug: string, token: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toast = useToast();
  const { agent, kind } = pending;

  const copy = {
    rotate: {
      title: agent.hasToken ? `Issue a new token for ${agent.displayName}?` : `Issue a token for ${agent.displayName}?`,
      body: agent.hasToken
        ? 'The current token stops working immediately. You will need to update the agent’s MCP configuration.'
        : 'The agent can then connect with its own token and act only as itself.',
      confirm: 'Issue token',
    },
    revoke: {
      title: `Revoke ${agent.displayName}'s token?`,
      body: 'The agent can no longer connect with its token until you issue a new one.',
      confirm: 'Revoke token',
    },
    delete: {
      title: `Delete ${agent.displayName}?`,
      body: 'Its token stops working and it disappears from the agent list. Finished tasks and history stay. Agents with open tasks can’t be deleted.',
      confirm: 'Delete agent',
    },
  }[kind];

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      if (kind === 'rotate') {
        const { token } = await api.issueToken(agent.slug);
        onToken(agent.slug, token);
        return;
      }
      if (kind === 'revoke') await api.revokeToken(agent.slug);
      else await api.deleteAgent(agent.slug);
      toast(kind === 'revoke' ? 'Token revoked.' : `Deleted ${agent.displayName}.`);
      onClose();
    } catch (failure: unknown) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={copy.title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={`button ${kind === 'rotate' ? 'button-primary' : 'button-danger'}`} disabled={busy} onClick={() => void confirm()}>
            {copy.confirm}
          </button>
        </>
      }
    >
      <p>{copy.body}</p>
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

type SnippetTab = 'claude' | 'codex' | 'json' | 'instructions';

function TokenReveal({ slug, token, isNew, onClose }: { slug: string; token: string; isNew: boolean; onClose: () => void }) {
  const snippets = clientSnippets(mcpUrl(), token);
  const [tab, setTab] = useState<SnippetTab>('claude');
  const active = snippets.find((snippet) => snippet.id === tab);

  return (
    <Modal
      title={isNew ? `Connect ${slug}` : `New token for ${slug}`}
      onClose={onClose}
      wide
      footer={
        <button type="button" className="button button-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="notice">
        <strong>Copy this token now.</strong> Only a hash is stored, so it can't be shown again. If you lose it, issue a new one.
      </div>
      <CodeBlock label="Token" code={token} />

      <h3 className="subheading">Connect the agent</h3>
      <Tabs
        tabs={[
          { id: 'claude', label: 'Claude Code' },
          { id: 'codex', label: 'Codex' },
          { id: 'json', label: 'Cursor / JSON' },
          { id: 'instructions', label: 'Agent instructions' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {active && (
        <>
          <CodeBlock label={active.label} code={active.code} />
          {active.note && <p className="muted small">{active.note}</p>}
        </>
      )}
      {tab === 'instructions' && (
        <>
          <p className="muted small">Paste into the agent's CLAUDE.md, AGENTS.md, or system prompt.</p>
          <CodeBlock label="Instructions" code={agentInstructions(slug)} />
        </>
      )}
    </Modal>
  );
}
