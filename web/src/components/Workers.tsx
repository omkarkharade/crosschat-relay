import { useEffect, useState } from 'react';

import { api, type WorkerInput } from '../api';
import { timeAgo } from '../format';
import { href } from '../route';
import { agentInstructions, clientSnippets } from '../snippets';
import type { Agent, ConnectResult, DetectedHarness, LocalInfo, WorkerStatus } from '../types';
import { useNow } from '../useRelay';
import { PathInput } from './PathPicker';
import { CodeBlock, errorMessage, Icon, Modal, useToast } from './ui';

const CUSTOM: DetectedHarness = { id: 'custom', name: 'Other command-line agent', canRun: true, extraDirs: true };

const STATE_LABEL: Record<WorkerStatus['state'], string> = {
  idle: 'Listening',
  running: 'Working',
  paused: 'Paused',
  disabled: 'Off',
  error: 'Error',
  limited: 'Hourly limit reached',
};

/** One line about an agent's worker, for its card. */
export function WorkerLine({ worker }: { worker: WorkerStatus }) {
  const now = useNow(15_000);
  return (
    <div className={`worker-line worker-${worker.state}`}>
      <span className="worker-state">
        <span className="worker-dot" aria-hidden="true" />
        Auto-run: {STATE_LABEL[worker.state]}
      </span>
      {worker.currentTask && (
        <a href={href({ view: 'board', taskId: worker.currentTask.id })} className="worker-detail">
          {worker.currentTask.title}
        </a>
      )}
      {!worker.currentTask && worker.state === 'error' && worker.error && <span className="worker-detail">{worker.error}</span>}
      {worker.state === 'limited' && worker.resumesAt && (
        <span className="worker-detail">
          {worker.maxRunsPerHour} runs in the last hour; takes tasks again at {new Date(worker.resumesAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      )}
      {!worker.currentTask && worker.state !== 'error' && worker.state !== 'limited' && worker.lastRun && (
        <span className="worker-detail muted">
          Last: {worker.lastRun.outcome === 'completed' ? 'finished' : 'blocked'} “{worker.lastRun.title}” {timeAgo(worker.lastRun.finishedAt, now)}
        </span>
      )}
    </div>
  );
}

/** Harnesses installed on the relay's computer, each one click away from connected and running. */
export function ThisComputer({ agents, operatorSlug }: { agents: Agent[]; operatorSlug?: string }) {
  const [info, setInfo] = useState<LocalInfo>();
  const [error, setError] = useState<string>();
  const [connecting, setConnecting] = useState<DetectedHarness>();

  useEffect(() => {
    api.local().then(setInfo, (failure: unknown) => setError(errorMessage(failure)));
  }, []);

  if (error) return null;
  if (!info) return <p className="muted">Looking for agent tools on this computer…</p>;

  const installed = info.harnesses.filter((harness) => harness.path);
  const missing = info.harnesses.filter((harness) => !harness.path);

  return (
    <section className="panel" aria-labelledby="this-computer-heading">
      <div>
        <h2 id="this-computer-heading">Agents on this computer</h2>
        <p className="muted small">
          Connect a tool installed on {info.hostname} in one step: Crosschat creates its agent, adds the relay to the tool's settings, and can run its tasks
          automatically, even when no chat is open.
        </p>
      </div>
      <ul className="harness-list">
        {[...installed, CUSTOM].map((harness) => (
          <li key={harness.id} className="harness-row">
            <div className="harness-main">
              <span className="harness-name">{harness.name}</span>
              <span className="muted small mono">{harness.path ?? 'Any program that takes a prompt and prints an answer'}</span>
              {harness.note && <span className="warning-text small">{harness.note}</span>}
            </div>
            <button type="button" className="button button-small button-primary" onClick={() => setConnecting(harness)}>
              Connect
            </button>
          </li>
        ))}
      </ul>
      {missing.length > 0 && <p className="muted small">Not found here: {missing.map((harness) => harness.name).join(', ')}. Install one and reload this page.</p>}
      {connecting && <ConnectHarnessDialog harness={connecting} info={info} agents={agents} {...(operatorSlug ? { operatorSlug } : {})} onClose={() => setConnecting(undefined)} />}
    </section>
  );
}

function ConnectHarnessDialog({
  harness,
  info,
  agents,
  operatorSlug,
  onClose,
}: {
  harness: DetectedHarness;
  info: LocalInfo;
  agents: Agent[];
  operatorSlug?: string;
  onClose: () => void;
}) {
  const baseSlug = `${harness.id === 'custom' ? 'agent' : harness.id}-${info.hostname}`.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').slice(0, 60);
  const [slug, setSlug] = useState(uniqueSlug(baseSlug, agents));
  const [displayName, setDisplayName] = useState(harness.id === 'custom' ? '' : `${harness.name} (${info.hostname})`);
  const [role, setRole] = useState('');
  const [configureClient, setConfigureClient] = useState(harness.id !== 'custom');
  const [autoRun, setAutoRun] = useState(harness.canRun);
  const [worker, setWorker] = useState<WorkerInput>(() => defaultWorker(harness, info, operatorSlug));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<ConnectResult>();

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const { harness: _harness, ...workerSettings } = worker;
      setResult(
        await api.connectLocal({
          harness: harness.id,
          slug: slug.trim().toLowerCase(),
          displayName: displayName.trim(),
          ...(role.trim() ? { role: role.trim() } : {}),
          configureClient,
          ...(autoRun ? { worker: workerSettings } : {}),
        }),
      );
    } catch (failure: unknown) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const senderName = (slug: string) => (slug === operatorSlug ? 'you' : (agents.find((agent) => agent.slug === slug)?.displayName ?? slug));
    return <ConnectDone result={result} harnessName={harness.name} mcpUrl={info.mcpUrl ?? ''} senderName={senderName} onClose={onClose} />;
  }

  return (
    <Modal
      title={`Connect ${harness.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="connect-harness"
            className="button button-primary"
            disabled={busy || !slug.trim() || !displayName.trim() || (autoRun && (!worker.workdir.trim() || worker.allowedSenders.length === 0))}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </>
      }
    >
      <form
        id="connect-harness"
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="field-row">
          <label className="field">
            <span>Display name</span>
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="For example: Image generator" required />
          </label>
          <label className="field">
            <span>Slug</span>
            <input value={slug} onChange={(event) => setSlug(event.target.value)} pattern="[a-z0-9][a-z0-9._:\-]{1,79}" required />
          </label>
        </div>
        <label className="field">
          <span>Role (optional)</span>
          <textarea rows={2} value={role} onChange={(event) => setRole(event.target.value)} maxLength={2000} placeholder="What it works on and which tasks to send it." />
        </label>

        {harness.id !== 'custom' && (
          <label className="check">
            <input type="checkbox" checked={configureClient} onChange={(event) => setConfigureClient(event.target.checked)} />
            Add the relay to {harness.name}'s own settings, so its chats can use Crosschat too
          </label>
        )}

        <fieldset className="field-group">
          <legend>Run tasks automatically</legend>
          <label className="check">
            <input type="checkbox" checked={autoRun} disabled={!harness.canRun} onChange={(event) => setAutoRun(event.target.checked)} />
            {harness.canRun ? 'Start a worker that runs its tasks in the background' : `${harness.name} can't run tasks headless; connect it for chats only`}
          </label>
          {autoRun && <WorkerFields value={worker} onChange={setWorker} harness={harness} agents={agents} {...(operatorSlug ? { operatorSlug } : {})} exclude={slug} />}
        </fieldset>
        {error && <p className="form-error">{error}</p>}
      </form>
    </Modal>
  );
}

function ConnectDone({
  result,
  harnessName,
  mcpUrl,
  senderName,
  onClose,
}: {
  result: ConnectResult;
  harnessName: string;
  mcpUrl: string;
  senderName: (slug: string) => string;
  onClose: () => void;
}) {
  const manual = !result.connection.configured;
  return (
    <Modal
      title={`${result.agent.displayName} is connected`}
      onClose={onClose}
      wide
      footer={
        <button type="button" className="button button-primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <ul className="done-list">
        <li>
          <Icon name="check" size={16} /> Created the agent <strong>{result.agent.slug}</strong> with its own token.
        </li>
        <li>
          {manual ? <Icon name="key" size={16} /> : <Icon name="check" size={16} />} {result.connection.message}
        </li>
        {result.worker && (
          <li>
            <Icon name="check" size={16} /> A worker is listening. Tasks from {result.worker.allowedSenders.map(senderName).join(', ')} now run with {harnessName} in{' '}
            <code>{result.worker.workdir}</code>.
          </li>
        )}
      </ul>
      {manual && result.token && (
        <>
          <div className="notice">
            <strong>Copy this now.</strong> The token is shown only once.
          </div>
          {result.connection.snippet ? (
            <CodeBlock label={result.connection.file ?? 'MCP settings'} code={result.connection.snippet} />
          ) : (
            <CodeBlock label="Claude Code" code={clientSnippets(mcpUrl, result.token)[0]!.code} />
          )}
        </>
      )}
      <p className="muted small">For its chats, add these working rules to the agent's instructions file (for example CLAUDE.md or AGENTS.md):</p>
      <CodeBlock label="Agent instructions" code={agentInstructions(result.agent.slug)} />
    </Modal>
  );
}

/** Set up, change, or remove the worker for an existing agent. */
export function WorkerDialog({
  agent,
  worker,
  agents,
  operatorSlug,
  onClose,
}: {
  agent: Agent;
  worker?: WorkerStatus;
  agents: Agent[];
  operatorSlug?: string;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<LocalInfo>();
  const [value, setValue] = useState<WorkerInput>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toast = useToast();

  useEffect(() => {
    api.local().then(
      (local) => {
        setInfo(local);
        const firstRunnable = local.harnesses.find((harness) => harness.path && harness.canRun) ?? CUSTOM;
        setValue(
          worker
            ? {
                harness: worker.harness,
                command: worker.command,
                args: worker.args,
                promptMode: worker.promptMode,
                workdir: worker.workdir,
                allowedSenders: worker.allowedSenders,
                timeoutMinutes: worker.timeoutMinutes,
                enabled: worker.enabled,
                extraDirs: worker.extraDirs,
                maxRunsPerHour: worker.maxRunsPerHour,
                exclusive: worker.exclusive,
              }
            : defaultWorker(firstRunnable, local, operatorSlug),
        );
      },
      (failure: unknown) => setError(errorMessage(failure)),
    );
  }, [worker, operatorSlug]);

  // Installed harnesses that can run headless, plus any command; keep a saved choice even if it's no longer detected.
  const harnesses = info
    ? [...info.harnesses.filter((harness) => harness.canRun && (harness.path || harness.id === worker?.harness)), CUSTOM]
    : [];
  const selected = harnesses.find((harness) => harness.id === value?.harness) ?? CUSTOM;

  async function save() {
    if (!value) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.saveWorker(agent.slug, value);
      toast(`Saved the worker for ${agent.displayName}.`);
      onClose();
    } catch (failure: unknown) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteWorker(agent.slug);
      toast(`Removed the worker for ${agent.displayName}.`);
      onClose();
    } catch (failure: unknown) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Run ${agent.displayName}'s tasks automatically`}
      onClose={onClose}
      wide
      footer={
        <>
          {worker && (
            <button type="button" className="button button-quiet-danger" disabled={busy} onClick={() => void remove()}>
              Remove worker
            </button>
          )}
          <span className="footer-spacer" />
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button button-primary" disabled={busy || !value} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      {!value && !error && <p className="muted">Looking for agent tools on this computer…</p>}
      {value && (
        <div className="form">
          <label className="field">
            <span>Harness</span>
            <select
              value={value.harness}
              onChange={(event) => {
                const next = harnesses.find((harness) => harness.id === event.target.value) ?? CUSTOM;
                setValue({ ...value, harness: next.id, ...(next.path ? { command: next.path } : {}), args: next.id === 'custom' ? ['{prompt_file}'] : [] });
              }}
            >
              {harnesses.map((harness) => (
                <option key={harness.id} value={harness.id}>
                  {harness.name}
                </option>
              ))}
            </select>
          </label>
          <WorkerFields value={value} onChange={setValue} harness={selected} agents={agents} {...(operatorSlug ? { operatorSlug } : {})} exclude={agent.slug} />
          <label className="check">
            <input type="checkbox" checked={value.enabled} onChange={(event) => setValue({ ...value, enabled: event.target.checked })} />
            Worker is on
          </label>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </Modal>
  );
}

/** The settings every worker has, plus the command details for custom harnesses. */
function WorkerFields({
  value,
  onChange,
  harness,
  agents,
  operatorSlug,
  exclude,
}: {
  value: WorkerInput;
  onChange: (value: WorkerInput) => void;
  harness: DetectedHarness;
  agents: Agent[];
  operatorSlug?: string;
  exclude: string;
}) {
  const senders = agents.filter((agent) => agent.slug !== exclude);
  const custom = harness.id === 'custom';
  return (
    <div className="subfields">
      {custom ? (
        <>
          <div className="field">
            <span>Program</span>
            <PathInput
              mode="file"
              value={value.command ?? ''}
              onChange={(command) => onChange({ ...value, command })}
              placeholder="For example C:\Tools\agent.exe or /usr/local/bin/aider"
              required
            />
          </div>
          <label className="field">
            <span>Arguments (one per line)</span>
            <textarea
              rows={3}
              value={(value.args ?? []).join('\n')}
              onChange={(event) => onChange({ ...value, args: event.target.value.split(/\r?\n/).filter((line) => line.trim() !== '') })}
              placeholder={'--message-file\n{prompt_file}'}
            />
            <small className="muted">
              Placeholders: {'{prompt_file}'} (the task), {'{result_file}'} (write the answer here instead of printing it), {'{workdir}'}, {'{mcp_url}'}, {'{mcp_config}'}. The token for
              this run is in the CROSSCHAT_TOKEN environment variable.
            </small>
          </label>
          <label className="field">
            <span>Send the task</span>
            <select value={value.promptMode ?? 'stdin'} onChange={(event) => onChange({ ...value, promptMode: event.target.value as WorkerInput['promptMode'] })}>
              <option value="stdin">On standard input</option>
              <option value="file">As a file ({'{prompt_file}'} in the arguments)</option>
              <option value="argument">As the last argument</option>
            </select>
          </label>
        </>
      ) : (
        <div className="field">
          <span>Program</span>
          <PathInput mode="file" value={value.command ?? harness.path ?? ''} onChange={(command) => onChange({ ...value, command })} />
        </div>
      )}
      <div className="field">
        <span>Working folder</span>
        <PathInput mode="dir" value={value.workdir} onChange={(workdir) => onChange({ ...value, workdir })} placeholder="A project folder" title="Choose the working folder" required />
        <small className="muted">The harness runs here and can change files in it. Use a project folder, not your whole home folder.</small>
      </div>
      <ExtraFolders value={value.extraDirs} onChange={(extraDirs) => onChange({ ...value, extraDirs })} supported={harness.extraDirs} custom={custom} />
      <fieldset className="field">
        <legend>Who picks up its tasks</legend>
        <div className="checks checks-column">
          <label className="check">
            <input type="radio" name="delivery" checked={value.exclusive} onChange={() => onChange({ ...value, exclusive: true })} />
            Only this worker
          </label>
          <label className="check">
            <input type="radio" name="delivery" checked={!value.exclusive} onChange={() => onChange({ ...value, exclusive: false })} />
            This worker or the agent's chat sessions, whichever asks first
          </label>
        </div>
        <small className="muted">With “only this worker”, chats connected as this agent don't receive its tasks while the worker is on, so the two never take each other's work.</small>
      </fieldset>
      <fieldset className="field">
        <legend>Run tasks automatically only from</legend>
        <div className="checks">
          {senders.map((agent) => (
            <label key={agent.slug} className="check">
              <input
                type="checkbox"
                checked={value.allowedSenders.includes(agent.slug)}
                onChange={(event) =>
                  onChange({
                    ...value,
                    allowedSenders: event.target.checked ? [...value.allowedSenders, agent.slug] : value.allowedSenders.filter((slug) => slug !== agent.slug),
                  })
                }
              />
              {agent.slug === operatorSlug ? 'You (dashboard)' : agent.displayName}
            </label>
          ))}
        </div>
        <small className="muted">Tasks from anyone else wait in the queue for you or the agent's chat to pick up.</small>
      </fieldset>
      <div className="field-row">
        <label className="field">
          <span>Time limit per task (minutes)</span>
          <input type="number" min={1} max={1440} value={value.timeoutMinutes} onChange={(event) => onChange({ ...value, timeoutMinutes: Number(event.target.value) || 30 })} />
        </label>
        <label className="field">
          <span>Most runs in an hour</span>
          <input type="number" min={1} max={500} value={value.maxRunsPerHour} onChange={(event) => onChange({ ...value, maxRunsPerHour: Number(event.target.value) || 20 })} />
        </label>
      </div>
      <p className="safety">
        <strong>What it may do:</strong> {harness.safety ?? 'Whatever the program itself allows. Crosschat adds no sandbox of its own, so only allow senders you trust.'}
      </p>
    </div>
  );
}

/** Folders besides the working folder that the harness may read and change. */
function ExtraFolders({ value, onChange, supported, custom }: { value: string[]; onChange: (value: string[]) => void; supported: boolean; custom: boolean }) {
  const [adding, setAdding] = useState('');
  if (!supported) {
    return value.length > 0 ? (
      <p className="muted">This tool can't be given extra folders, so the {value.length === 1 ? 'one saved here is' : 'ones saved here are'} not used.</p>
    ) : null;
  }
  const add = (path: string) => {
    const trimmed = path.trim();
    if (trimmed && !value.includes(trimmed)) onChange([...value, trimmed]);
    setAdding('');
  };
  return (
    <div className="field">
      <span>Extra folders</span>
      {value.length > 0 && (
        <ul className="extra-folders">
          {value.map((dir) => (
            <li key={dir}>
              <span className="mono" title={dir}>
                {dir}
              </span>
              <button type="button" className="icon-button" aria-label={`Remove ${dir}`} onClick={() => onChange(value.filter((item) => item !== dir))}>
                <Icon name="close" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <PathInput mode="dir" value={adding} onChange={setAdding} onPick={add} placeholder="Add a folder it may also read and change" title="Choose an extra folder" />
      {adding.trim() && (
        <button type="button" className="button button-small extra-add" onClick={() => add(adding)}>
          Add {adding.trim()}
        </button>
      )}
      <small className="muted">
        For work that reads or delivers outside the working folder, such as a game's asset folder.{' '}
        {custom ? 'Your command gets them in the CROSSCHAT_EXTRA_DIRS environment variable.' : 'The harness may read and change files in these too.'}
      </small>
    </div>
  );
}

function defaultWorker(harness: DetectedHarness, _info: LocalInfo, operatorSlug?: string): WorkerInput {
  return {
    harness: harness.id,
    ...(harness.path ? { command: harness.path } : {}),
    ...(harness.id === 'custom' ? { args: ['{prompt_file}'], promptMode: 'file' as const } : {}),
    // Chosen by the user: a harness can change files in its working folder.
    workdir: '',
    allowedSenders: operatorSlug ? [operatorSlug] : [],
    timeoutMinutes: 30,
    enabled: true,
    extraDirs: [],
    maxRunsPerHour: 20,
    // One place picks up this agent's tasks, so a chat session can't take them from under the worker.
    exclusive: true,
  };
}

function uniqueSlug(base: string, agents: Agent[]): string {
  const taken = new Set(agents.map((agent) => agent.slug));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) if (!taken.has(`${base}-${index}`)) return `${base}-${index}`;
}
