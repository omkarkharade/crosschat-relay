import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { PRIORITY_LABEL, STATUS_LABEL } from '../format';
import type { Priority, TaskStatus } from '../types';

// ------------------------------------------------------------------- icons

const ICON_PATHS = {
  board: 'M4 5h4v14H4zM10 5h4v9h-4zM16 5h4v6h-4z',
  agents: 'M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 19c0-3 3-5 6-5s6 2 6 5M16 11a2.5 2.5 0 1 0 0-5M18 14c2 .5 3 2 3 5',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  plus: 'M12 5v14M5 12h14',
  play: 'M7 5l12 7-12 7z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13 7l4 4',
  close: 'M6 6l12 12M18 6L6 18',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  check: 'M5 12l5 5 9-10',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  key: 'M14 10a4 4 0 1 0-3.5 4L12 16h2v2h2v2h3v-3l-5-5a4 4 0 0 0 0-2z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  folder: 'M3 6h6l2 2h10v11H3z',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  up: 'M12 19V5M6 11l6-6 6 6',
} as const;

export function Icon({ name, size = 18 }: { name: keyof typeof ICON_PATHS; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

// ------------------------------------------------------------------ badges

export function StatusBadge({ status }: { status: TaskStatus }) {
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  if (priority === 2) return null;
  return <span className={`badge priority-${priority}`}>{PRIORITY_LABEL[priority]}</span>;
}

export function AvailabilityDot({ online }: { online: boolean }) {
  return <span className={`dot ${online ? 'dot-online' : 'dot-offline'}`} title={online ? 'Online' : 'Offline'} />;
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="chip">{children}</span>;
}

/** Initials in a coloured square; the colour is stable per slug so agents are easy to tell apart. */
export function Avatar({ slug, name, size = 'medium' }: { slug: string; name: string; size?: 'small' | 'medium' | 'large' }) {
  return (
    <span className={`avatar avatar-${size} avatar-hue-${hue(slug)}`} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

/** An agent's avatar and name, with an online dot when availability is known. */
export function AgentLabel({ slug, agent }: { slug: string; agent: { displayName: string; availability: 'online' | 'offline' } | undefined }) {
  const name = agent?.displayName ?? slug;
  return (
    <span className="agent-label" title={`${name} (${slug})${agent ? `, ${agent.availability}` : ''}`}>
      <Avatar slug={slug} name={name} size="small" />
      <span className="agent-label-name">{name}</span>
      {agent && <span className={`dot ${agent.availability === 'online' ? 'dot-online' : 'dot-offline'}`} />}
    </span>
  );
}

export function initials(name: string): string {
  const letters = name
    .split(/[\s()_-]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase());
  return (letters[0] ?? '?') + (letters[1] ?? '');
}

function hue(slug: string): number {
  let hash = 0;
  for (const character of slug) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 6;
}

// ------------------------------------------------------------------- modal

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Callers usually pass a new onClose on every render; read the latest one
  // so the effect below runs only when the dialog opens. Re-running it would
  // move focus back to the first field on every keystroke.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const firstField = dialogRef.current?.querySelector<HTMLElement>('input, textarea, select, button:not(.modal-close)');
    (firstField ?? dialogRef.current)?.focus();
    // With a dialog opened from another (such as a folder picker), Escape closes only the top one.
    const onKey = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('.modal');
      if (event.key === 'Escape' && dialogs[dialogs.length - 1] === dialogRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button modal-close" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ copy + code

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="button button-small"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
      {copied ? 'Copied' : label}
    </button>
  );
}

export function CodeBlock({ code, label }: { code: string; label?: string }) {
  return (
    <div className="code-block">
      <div className="code-block-bar">
        <span>{label}</span>
        <CopyButton text={code} />
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: T; label: string }>;
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={tab.id === active}
          className={`tab ${tab.id === active ? 'tab-active' : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ toasts

interface ToastAction {
  label: string;
  href: string;
}

interface Toast {
  id: number;
  message: string;
  tone: 'error' | 'success' | 'info';
  action?: ToastAction;
}

type ShowToast = (message: string, tone?: Toast['tone'], action?: ToastAction) => void;

const ToastContext = createContext<ShowToast>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  const show = useCallback<ShowToast>(
    (message, tone = 'success', action) => {
      const id = Date.now() + Math.random();
      setToasts((current) => [...current.slice(-3), { id, message, tone, ...(action ? { action } : {}) }]);
      // Alerts with an action stay long enough to act on.
      setTimeout(() => dismiss(id), action ? 10_000 : tone === 'error' ? 6000 : 3000);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            <span>{toast.message}</span>
            {toast.action && (
              <a className="toast-action" href={toast.action.href} onClick={() => dismiss(toast.id)}>
                {toast.action.label}
              </a>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.';
}
