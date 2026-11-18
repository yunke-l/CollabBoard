import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AlertCircle, Monitor, Moon, Sun, X } from 'lucide-react';

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
export function Avatar({ name }: { name: string | null }) {
  return (
    <span
      className="avatar"
      title={name ?? 'Unassigned'}
      aria-label={name ?? 'Unassigned'}
    >
      {name
        ? name
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => Array.from(part)[0])
            .join('')
        : '—'}
    </span>
  );
}
export function ThemeSwitch() {
  const [preference, setPreference] = useState(() => {
    try {
      return localStorage.getItem('collabboard.appearance') ?? 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      document.documentElement.dataset.theme =
        preference === 'dark' || (preference === 'system' && media.matches)
          ? 'dark'
          : 'light';
    };
    update();
    media.addEventListener('change', update);
    try {
      localStorage.setItem('collabboard.appearance', preference);
    } catch {
      /* Preference remains available for this page. */
    }
    return () => media.removeEventListener('change', update);
  }, [preference]);
  return (
    <div className="theme-switch" role="group" aria-label="Appearance">
      {(['light', 'dark', 'system'] as const).map((value) => {
        const Icon =
          value === 'light' ? Sun : value === 'dark' ? Moon : Monitor;
        return (
          <button
            key={value}
            type="button"
            aria-label={`${value[0]!.toUpperCase()}${value.slice(1)} theme`}
            aria-pressed={preference === value}
            onClick={() => setPreference(value)}
          >
            <Icon size={18} />
            <span className="sr-only">{value}</span>
          </button>
        );
      })}
    </div>
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
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  drawer?: boolean;
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
      onCancel={(event) => {
        event.preventDefault();
        closeRef.current();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <div className="dialog-inner">
        <div className="dialog-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
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
