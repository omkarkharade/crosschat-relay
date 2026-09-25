import { useState } from 'react';

import { api } from '../api';
import { navigate } from '../route';
import type { Agent, Priority } from '../types';
import { errorMessage, Modal, useToast } from './ui';

export function NewTaskDialog({ agents, operatorSlug, onClose }: { agents: Agent[]; operatorSlug?: string; onClose: () => void }) {
  const recipients = agents.filter((agent) => agent.slug !== operatorSlug);
  const [recipientSlug, setRecipientSlug] = useState(recipients.find((agent) => agent.availability === 'online')?.slug ?? recipients[0]?.slug ?? '');
  const [title, setTitle] = useState('');
  const [instructions, setInstructions] = useState('');
  const [priority, setPriority] = useState<Priority>(2);
  const [required, setRequired] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toast = useToast();
  const recipient = recipients.find((agent) => agent.slug === recipientSlug);

  async function submit() {
    setBusy(true);
    setError(undefined);
    try {
      const task = await api.postTask({ recipientSlug, title, instructions, priority, requiredCapabilities: required });
      toast(`Task sent to ${recipient?.displayName ?? recipientSlug}.`);
      onClose();
      navigate({ view: 'board', taskId: task.id });
    } catch (failure: unknown) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return (
    <Modal
      title="New task"
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="new-task" className="button button-primary" disabled={busy || !recipientSlug || !title.trim() || !instructions.trim()}>
            {busy ? 'Sending…' : 'Send task'}
          </button>
        </>
      }
    >
      {recipients.length === 0 ? (
        <p className="muted">There are no agents to send tasks to yet. Add one on the Agents page first.</p>
      ) : (
        <form
          id="new-task"
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="field">
            <span>Send to</span>
            <select
              value={recipientSlug}
              onChange={(event) => {
                setRecipientSlug(event.target.value);
                setRequired([]);
              }}
            >
              {recipients.map((agent) => (
                <option key={agent.slug} value={agent.slug}>
                  {agent.displayName} ({agent.slug}){agent.availability === 'online' ? ' · online' : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Title</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={500} placeholder="What should get done?" required />
          </label>

          <label className="field">
            <span>Instructions</span>
            <textarea
              rows={8}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
              maxLength={40_000}
              placeholder="Everything the agent needs: context, constraints, and what a good result looks like."
              required
            />
          </label>

          <fieldset className="field">
            <legend>Priority</legend>
            <div className="segmented">
              {([1, 2, 3] as Priority[]).map((value) => (
                <label key={value} className={priority === value ? 'segment segment-active' : 'segment'}>
                  <input type="radio" name="priority" value={value} checked={priority === value} onChange={() => setPriority(value)} />
                  {value === 1 ? 'Low' : value === 2 ? 'Normal' : 'Urgent'}
                </label>
              ))}
            </div>
          </fieldset>

          {recipient && recipient.capabilities.length > 0 && (
            <fieldset className="field">
              <legend>Required capabilities (optional)</legend>
              <div className="checks">
                {recipient.capabilities.map((capability) => (
                  <label key={capability} className="check">
                    <input
                      type="checkbox"
                      checked={required.includes(capability)}
                      onChange={(event) =>
                        setRequired((current) => (event.target.checked ? [...current, capability] : current.filter((item) => item !== capability)))
                      }
                    />
                    {capability}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {error && <p className="form-error">{error}</p>}
        </form>
      )}
    </Modal>
  );
}
