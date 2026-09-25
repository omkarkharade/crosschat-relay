import { useState } from 'react';

import { api } from '../api';
import { fullDate, timeAgo, timeLeft } from '../format';
import { href } from '../route';
import { agentInstructions, clientSnippets, invitePrompt, mcpUrl } from '../snippets';
import type { Agent, Invite, Priority } from '../types';
import { useNow } from '../useRelay';
import { AgentLabel, CodeBlock, CopyButton, EmptyState, errorMessage, Icon, Tabs, useToast } from './ui';
import { ThisComputer } from './Workers';

const EXPIRY_OPTIONS = [
  { hours: 1, label: '1 hour' },
  { hours: 24, label: '1 day' },
  { hours: 24 * 7, label: '7 days' },
];

const USE_OPTIONS: Array<{ uses: number | undefined; label: string }> = [
  { uses: 1, label: 'One agent' },
  { uses: 5, label: 'Up to 5' },
  { uses: undefined, label: 'Unlimited' },
];

export function Connect({
  invites,
  agents,
  version,
  local,
  operatorSlug,
}: {
  invites: Invite[];
  agents: Agent[];
  version?: string;
  local: boolean;
  operatorSlug?: string;
}) {
  const [created, setCreated] = useState<{ id: string; prompt: string }>();
  const agentsBySlug = new Map(agents.map((agent) => [agent.slug, agent]));
  // The live copy of the invite just created, so joins show up as they happen.
  const current = created && invites.find((invite) => invite.id === created.id);

  return (
    <section className="view view-narrow">
      <header className="view-header">
        <div>
          <h1>Connect an agent</h1>
          <p className="muted">
            Paste one message into any agent's chat: Claude Code, Codex, Cursor, or anything else that speaks MCP. It gets its own token and connects
            itself. You can choose the name and role others see for it, and give it a task to start on.
          </p>
        </div>
      </header>

      {local && <ThisComputer agents={agents} {...(operatorSlug ? { operatorSlug } : {})} />}

      <InviteForm
        onCreated={(invite, code) =>
          setCreated({
            id: invite.id,
            prompt: invitePrompt({
              origin: window.location.origin,
              code,
              expiresAt: invite.expiresAt,
              ...(invite.maxUses ? { maxUses: invite.maxUses } : {}),
              ...(invite.displayName ? { displayName: invite.displayName } : {}),
              ...(invite.role ? { role: invite.role } : {}),
              ...(invite.firstTask ? { firstTaskTitle: invite.firstTask.title } : {}),
            }),
          })
        }
      />

      {created && (
        <section className="panel panel-highlight" aria-labelledby="invite-message-heading">
          <div className="panel-heading">
            <div>
              <h2 id="invite-message-heading">Paste this into the agent's chat</h2>
              <p className="muted small">This is the only time the invite code is shown. Anyone with it can add an agent until it expires or is used up.</p>
            </div>
            <CopyButton text={created.prompt} label="Copy message" />
          </div>
          <pre className="invite-message">{created.prompt}</pre>
          <JoinStatus invite={current} agents={agentsBySlug} />
        </section>
      )}

      <InviteList invites={invites} agents={agentsBySlug} highlightId={created?.id} />

      <details className="panel manual-setup">
        <summary>
          <h2>Set up an agent by hand instead</h2>
          <span className="muted small">For clients that can't make HTTP requests, or if you prefer to create the agent yourself.</span>
        </summary>
        <ManualSetup {...(version ? { version } : {})} />
      </details>
    </section>
  );
}

function InviteForm({ onCreated }: { onCreated: (invite: Invite, code: string) => void }) {
  const [label, setLabel] = useState('');
  const [expiresInHours, setExpiresInHours] = useState(24);
  const [maxUses, setMaxUses] = useState<number | undefined>(1);
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState('');
  const [giveTask, setGiveTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState('');
  const [taskInstructions, setTaskInstructions] = useState('');
  const [taskPriority, setTaskPriority] = useState<Priority>(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const taskIncomplete = giveTask && (!taskTitle.trim() || !taskInstructions.trim());

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const { invite, code } = await api.createInvite({
        expiresInHours,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(maxUses ? { maxUses } : {}),
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        ...(role.trim() ? { role: role.trim() } : {}),
        ...(giveTask ? { firstTask: { title: taskTitle.trim(), instructions: taskInstructions.trim(), priority: taskPriority } } : {}),
      });
      onCreated(invite, code);
      setLabel('');
      setDisplayName('');
      setRole('');
      setGiveTask(false);
      setTaskTitle('');
      setTaskInstructions('');
      setTaskPriority(2);
    } catch (failure: unknown) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="panel form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h2>Create an invite</h2>
      <label className="field">
        <span>Label (optional)</span>
        <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={120} placeholder="For example: Claude Code on my laptop" />
      </label>
      <div className="field-row">
        <fieldset className="field">
          <legend>Expires after</legend>
          <div className="segmented">
            {EXPIRY_OPTIONS.map((option) => (
              <button key={option.hours} type="button" className={`segment ${expiresInHours === option.hours ? 'segment-active' : ''}`} aria-pressed={expiresInHours === option.hours} onClick={() => setExpiresInHours(option.hours)}>
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="field">
          <legend>Can be used by</legend>
          <div className="segmented">
            {USE_OPTIONS.map((option) => (
              <button key={option.label} type="button" className={`segment ${maxUses === option.uses ? 'segment-active' : ''}`} aria-pressed={maxUses === option.uses} onClick={() => setMaxUses(option.uses)}>
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>

      <fieldset className="field-group">
        <legend>
          How others will see this agent <span className="muted">(optional)</span>
        </legend>
        <div className="field-row">
          <label className="field">
            <span>Display name</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={500} placeholder="For example: Backend reviewer" />
            <small className="muted">Leave empty to let the agent name itself.</small>
          </label>
          <label className="field">
            <span>Role</span>
            <textarea
              rows={2}
              value={role}
              onChange={(event) => setRole(event.target.value)}
              maxLength={2000}
              placeholder="What it works on and which tasks to send it. For example: Reviews backend pull requests for security issues."
            />
            <small className="muted">Other agents see this when deciding whom to send work to.</small>
          </label>
        </div>
        <p className="muted small">The agent can't change a name or role you set here. You can edit both later on the Agents page.</p>
      </fieldset>

      <fieldset className="field-group">
        <legend>First task</legend>
        <label className="check">
          <input type="checkbox" checked={giveTask} onChange={(event) => setGiveTask(event.target.checked)} />
          Give it a task as soon as it joins
        </label>
        {giveTask && (
          <div className="subfields">
            <label className="field">
              <span>Title</span>
              <input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} maxLength={500} placeholder="What should it do first?" required />
            </label>
            <label className="field">
              <span>Instructions</span>
              <textarea
                rows={4}
                value={taskInstructions}
                onChange={(event) => setTaskInstructions(event.target.value)}
                maxLength={40_000}
                placeholder="Everything it needs: context, constraints, and what a good result looks like."
                required
              />
            </label>
            <div className="field">
              <span>Priority</span>
              <div className="segmented">
                {([1, 2, 3] as Priority[]).map((value) => (
                  <button key={value} type="button" className={`segment ${taskPriority === value ? 'segment-active' : ''}`} aria-pressed={taskPriority === value} onClick={() => setTaskPriority(value)}>
                    {value === 1 ? 'Low' : value === 2 ? 'Normal' : 'Urgent'}
                  </button>
                ))}
              </div>
            </div>
            {maxUses !== 1 && <p className="muted small">Every agent that joins with this invite gets its own copy of the task.</p>}
          </div>
        )}
      </fieldset>

      {error && <p className="form-error">{error}</p>}
      <div>
        <button type="submit" className="button button-primary" disabled={busy || taskIncomplete}>
          <Icon name="plus" size={16} />
          {busy ? 'Creating…' : 'Create invite message'}
        </button>
      </div>
    </form>
  );
}

function JoinStatus({ invite, agents }: { invite: Invite | undefined; agents: Map<string, Agent> }) {
  if (!invite || invite.agents.length === 0) {
    return (
      <p className="join-status join-waiting" role="status">
        <span className="pulse" aria-hidden="true" />
        Waiting for an agent to join. This updates by itself.
      </p>
    );
  }
  return (
    <div className="join-status join-done" role="status">
      <Icon name="check" size={16} />
      <span>Joined:</span>
      {invite.agents.map((slug) => (
        <a key={slug} href={href({ view: 'agents' })}>
          <AgentLabel slug={slug} agent={agents.get(slug)} />
        </a>
      ))}
    </div>
  );
}

function InviteList({ invites, agents, highlightId }: { invites: Invite[]; agents: Map<string, Agent>; highlightId?: string }) {
  const now = useNow(30_000);
  const toast = useToast();

  if (invites.length === 0) {
    return <EmptyState title="No invites yet">Create one above. It shows up here with who joined through it.</EmptyState>;
  }

  return (
    <section className="panel" aria-labelledby="invites-heading">
      <h2 id="invites-heading">Invites</h2>
      <ul className="invite-list">
        {invites.map((invite) => {
          const state = inviteState(invite, now);
          return (
            <li key={invite.id} className={`invite-row ${invite.id === highlightId ? 'invite-row-new' : ''}`}>
              <div className="invite-main">
                <span className="invite-label">{invite.label ?? invite.displayName ?? 'Untitled invite'}</span>
                {(invite.displayName || invite.role || invite.firstTask) && (
                  <span className="invite-setup">
                    {invite.displayName && (
                      <span>
                        Joins as <strong>{invite.displayName}</strong>
                      </span>
                    )}
                    {invite.role && <span className="invite-role">{invite.role}</span>}
                    {invite.firstTask && (
                      <span>
                        First task: <strong>{invite.firstTask.title}</strong>
                      </span>
                    )}
                  </span>
                )}
                <span className="muted small" title={fullDate(invite.createdAt)}>
                  Created {timeAgo(invite.createdAt, now)} ·{' '}
                  {state === 'active' ? <span title={fullDate(invite.expiresAt)}>expires {timeLeft(invite.expiresAt, now).replace(' left', '')}</span> : null}
                  {state === 'active' ? ' · ' : null}
                  {invite.uses} of {invite.maxUses ?? '∞'} used
                </span>
                {invite.agents.length > 0 && (
                  <span className="invite-agents">
                    {invite.agents.map((slug) => (
                      <AgentLabel key={slug} slug={slug} agent={agents.get(slug)} />
                    ))}
                  </span>
                )}
              </div>
              <span className={`badge invite-${state}`}>{INVITE_STATE_LABEL[state]}</span>
              {state === 'active' ? (
                <button
                  type="button"
                  className="button button-small button-quiet-danger"
                  onClick={() => {
                    api.revokeInvite(invite.id).then(
                      () => toast('Invite revoked.'),
                      (failure: unknown) => toast(errorMessage(failure), 'error'),
                    );
                  }}
                >
                  Revoke
                </button>
              ) : (
                <span />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type InviteState = 'active' | 'used' | 'expired' | 'revoked';

const INVITE_STATE_LABEL: Record<InviteState, string> = { active: 'Active', used: 'Used up', expired: 'Expired', revoked: 'Revoked' };

function inviteState(invite: Invite, now: number): InviteState {
  if (invite.revoked) return 'revoked';
  if (invite.maxUses !== undefined && invite.uses >= invite.maxUses) return 'used';
  if (Date.parse(invite.expiresAt) <= now) return 'expired';
  return 'active';
}

type ClientTab = 'claude' | 'codex' | 'json';

function ManualSetup({ version }: { version?: string }) {
  const [tab, setTab] = useState<ClientTab>('claude');
  const snippet = clientSnippets(mcpUrl(), '<AGENT_TOKEN>').find((item) => item.id === tab)!;

  return (
    <ol className="steps">
      <li className="step">
        <h3>Create the agent and its token</h3>
        <p>
          On the <a href={href({ view: 'agents' })}>Agents</a> page, choose <strong>Add agent</strong>. You get a token that only works as that agent, plus
          ready-to-paste commands with the token filled in.
        </p>
      </li>
      <li className="step">
        <h3>Add the relay to the agent's MCP client</h3>
        <p>
          The MCP endpoint is <code>{mcpUrl()}</code>. Replace <code>&lt;AGENT_TOKEN&gt;</code> with the agent's token.
        </p>
        <Tabs
          tabs={[
            { id: 'claude', label: 'Claude Code' },
            { id: 'codex', label: 'Codex' },
            { id: 'json', label: 'Cursor / JSON' },
          ]}
          active={tab}
          onChange={setTab}
        />
        <CodeBlock label={snippet.label} code={snippet.code} />
        {snippet.note && <p className="muted small">{snippet.note}</p>}
      </li>
      <li className="step">
        <h3>Tell the agent how to behave</h3>
        <p>Paste this into the agent's CLAUDE.md, AGENTS.md, or system prompt.</p>
        <CodeBlock label="Agent instructions" code={agentInstructions(undefined)} />
        {version && <p className="muted small">Relay version {version}.</p>}
      </li>
    </ol>
  );
}
