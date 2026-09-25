import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { api } from '../api';
import type { BrowseResult } from '../types';
import { errorMessage, Icon, Modal } from './ui';

type Mode = 'dir' | 'file';

/** A path text box with a Browse button that opens a picker for this computer's folders or programs. */
export function PathInput({
  value,
  onChange,
  mode,
  placeholder,
  required,
  title,
  onPick,
}: {
  value: string;
  onChange: (value: string) => void;
  mode: Mode;
  placeholder?: string;
  required?: boolean;
  title?: string;
  /** Called with a path chosen in the picker; without it, the picked path goes to onChange. */
  onPick?: (path: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="path-input">
      <input value={value} onChange={(event) => onChange(event.target.value)} className="mono" placeholder={placeholder} required={required} />
      <button type="button" className="button" onClick={() => setPicking(true)}>
        <Icon name={mode === 'dir' ? 'folder' : 'file'} size={16} />
        Browse…
      </button>
      {picking &&
        createPortal(
          <PathPicker
            mode={mode}
            start={value}
            title={title ?? (mode === 'dir' ? 'Choose a folder' : 'Choose a program')}
            onPick={(path) => {
              (onPick ?? onChange)(path);
              setPicking(false);
            }}
            onClose={() => setPicking(false)}
          />,
          document.body,
        )}
    </div>
  );
}

/**
 * Browse this computer's folders (the relay lists them, so the result is a
 * real full path). In program mode, it lists folders and the programs in them.
 */
function PathPicker({ mode, start, title, onPick, onClose }: { mode: Mode; start: string; title: string; onPick: (path: string) => void; onClose: () => void }) {
  const [listing, setListing] = useState<BrowseResult>();
  const [address, setAddress] = useState('');
  const [selected, setSelected] = useState<string>();
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const open = useCallback(
    async (path: string | undefined, fallbackToHome = false) => {
      setBusy(true);
      try {
        const result = await api.browse({ ...(path ? { path } : {}), mode, hidden });
        setListing(result);
        setAddress(result.path);
        setSelected(undefined);
        setError(undefined);
      } catch (failure: unknown) {
        if (fallbackToHome && path) return open(undefined);
        setError(errorMessage(failure));
      } finally {
        setBusy(false);
      }
    },
    [mode, hidden],
  );

  // Start where the current value points (a program's folder), or at home; stay in the same folder when "show hidden" changes.
  const shown = useRef<string | undefined>(undefined);
  shown.current = listing?.path;
  useEffect(() => {
    const current = start.trim();
    const folder = mode === 'file' ? current.replace(/[\\/][^\\/]*$/, '') : current;
    void open(shown.current ?? (folder || undefined), true);
  }, [open, start, mode]);

  const choice = mode === 'dir' ? listing?.path : selected;

  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="picker-choice mono" title={choice}>
            {choice ?? (mode === 'file' ? 'Select a program' : '')}
          </span>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button button-primary" disabled={!choice || busy} onClick={() => choice && onPick(choice)}>
            {mode === 'dir' ? 'Use this folder' : 'Use this program'}
          </button>
        </>
      }
    >
      <div className="picker">
        {listing && (
          <nav className="picker-places" aria-label="Places">
            {listing.places.map((place) => (
              <button key={place.path} type="button" className="picker-place" aria-current={place.path === listing.path ? 'location' : undefined} onClick={() => void open(place.path)}>
                {place.name}
              </button>
            ))}
          </nav>
        )}
        <form
          className="picker-address"
          onSubmit={(event) => {
            event.preventDefault();
            // React passes events up to the form that opened the picker, even through the portal.
            event.stopPropagation();
            void open(address.trim());
          }}
        >
          <button type="button" className="icon-button" disabled={!listing?.parent || busy} onClick={() => listing?.parent && void open(listing.parent)} aria-label="Up one folder" title="Up one folder">
            <Icon name="up" />
          </button>
          <input value={address} onChange={(event) => setAddress(event.target.value)} className="mono" aria-label="Folder path" spellCheck={false} />
          <button type="submit" className="button" disabled={busy}>
            Go
          </button>
        </form>
        {error && <p className="form-error">{error}</p>}
        <ul className="picker-list" aria-busy={busy}>
          {listing?.entries.length === 0 && <li className="picker-empty muted">{mode === 'file' ? 'No folders or programs here.' : 'No folders here.'}</li>}
          {listing?.entries.map((entry) => (
            <li key={entry.path}>
              <button
                type="button"
                className={`picker-entry ${entry.path === selected ? 'picker-entry-selected' : ''}`}
                aria-pressed={entry.kind === 'file' ? entry.path === selected : undefined}
                onClick={() => (entry.kind === 'dir' ? void open(entry.path) : setSelected(entry.path))}
                onDoubleClick={() => entry.kind === 'file' && onPick(entry.path)}
              >
                <Icon name={entry.kind === 'dir' ? 'folder' : 'file'} size={16} />
                <span>{entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="picker-options">
          <label className="check">
            <input type="checkbox" checked={hidden} onChange={(event) => setHidden(event.target.checked)} />
            Show hidden folders{mode === 'file' ? ' and files' : ''}
          </label>
          {listing?.truncated && <span className="muted">Only the first 3,000 items are shown. Type a path to go deeper.</span>}
          {mode === 'file' && <span className="muted">Shows programs you can run: .exe, .cmd and .bat files on Windows, executable files elsewhere, and Node.js scripts.</span>}
        </div>
      </div>
    </Modal>
  );
}
