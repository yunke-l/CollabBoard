import {
  useEffect,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { Link } from 'react-router';
import { AlertCircle, Moon, Sun, X } from 'lucide-react';

export function Brand() {
  return (
    <Link to="/" className="brand" aria-label="CollabBoard home">
      <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
        <rect x="1" y="1" width="30" height="30" rx="8" fill="var(--primary)" />
        <g fill="var(--bg)">
          <rect x="8" y="8" width="4" height="16" rx="1.4" />
          <rect x="14" y="8" width="4" height="11" rx="1.4" />
          <rect x="20" y="8" width="4" height="7" rx="1.4" />
        </g>
      </svg>
      <span>CollabBoard</span>
    </Link>
  );
}
const avatarHues = [24, 175, 320, 150, 355, 222, 270, 195, 48];

function avatarHue(key: string) {
  let hash = 2166136261;
  for (const char of key) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  }
  return avatarHues[(hash >>> 0) % avatarHues.length];
}

export function Avatar({
  name,
  userId,
}: {
  name: string | null;
  userId?: string | null | undefined;
}) {
  const displayName = name?.trim();
  const key = userId || displayName?.normalize('NFC').toLowerCase();

  return (
    <span
      className={key ? 'avatar avatar-person' : 'avatar'}
      style={
        key ? ({ '--avatar-hue': avatarHue(key) } as CSSProperties) : undefined
      }
      title={displayName || 'Unassigned'}
      aria-label={displayName || 'Unassigned'}
    >
      {displayName
        ? displayName
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => Array.from(part)[0])
            .join('')
        : '—'}
    </span>
  );
}
const appearanceEvent = 'collabboard:appearance';
function subscribeToAppearance(onChange: () => void) {
  window.addEventListener(appearanceEvent, onChange);
  return () => window.removeEventListener(appearanceEvent, onChange);
}
function currentAppearance() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}
export function ThemeSwitch() {
  const theme = useSyncExternalStore(subscribeToAppearance, currentAppearance);
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${nextTheme} mode`;
  const Icon = theme === 'dark' ? Sun : Moon;
  function toggleTheme() {
    document.documentElement.dataset.theme = nextTheme;
    try {
      localStorage.setItem('collabboard.appearance', nextTheme);
    } catch {
      /* Preference remains available for this page. */
    }
    window.dispatchEvent(new Event(appearanceEvent));
  }
  return (
    <button
      className="theme-switch"
      type="button"
      aria-label={label}
      title={label}
      onClick={toggleTheme}
    >
      <Icon size={18} aria-hidden="true" />
    </button>
  );
}
export function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="notice">
      <AlertCircle size={18} aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}
export function LoadingState() {
  return (
    <div role="status" className="loading">
      <span className="skeleton" />
      <span className="skeleton" />
      <span className="skeleton" />
      <span className="sr-only">Loading…</span>
    </div>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error: Error;
  retry: () => void;
}) {
  return (
    <div className="empty" role="alert">
      <AlertCircle size={28} />
      <h2>Unable to load this view</h2>
      <p>{error.message}</p>
      <button className="button" onClick={retry}>
        Try again
      </button>
    </div>
  );
}
export function Dialog({
  title,
  children,
  onClose,
  drawer = false,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  drawer?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const element = ref.current;
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    element?.showModal();
    return () => {
      element?.close();
      trigger?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={drawer ? 'dialog drawer' : 'dialog'}
      aria-label={title}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) closeRef.current();
      }}
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) closeRef.current();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            disabled={busy}
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
