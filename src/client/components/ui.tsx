import { useEffect, useId, useRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { useBodyLock } from '../hooks';

const modalStack: symbol[] = [];

export function Logo({ size = 32, wordmark = true }: { size?: number; wordmark?: boolean }) {
  const gradientId = useId().replace(/:/g, '');
  return (
    <span className="logo-lockup" aria-label="Nimbus">
      <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#6366f1" />
            <stop offset="1" stopColor="#06b6d4" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="17" fill={`url(#${gradientId})`} />
        <path
          d="M20 40.5h24a7.5 7.5 0 0 0 .9-14.95A11.5 11.5 0 0 0 22.6 24.6 7.5 7.5 0 0 0 20 40.5Z"
          fill="#fff"
          opacity=".96"
        />
        <path d="M25 45.5h14" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" opacity=".7" />
      </svg>
      {wordmark ? <span className="logo-wordmark">Nimbus</span> : null}
    </span>
  );
}

export function Spinner({ size = 18, label }: { size?: number; label?: string }) {
  return (
    <span className="spinner" role="status" aria-label={label ?? 'Loading'}>
      <Loader2 size={size} className="spin" aria-hidden="true" />
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: 'sm' | 'md' | 'lg';
  tone?: 'default' | 'danger' | 'light';
  active?: boolean;
}

export function IconButton({
  label,
  size = 'md',
  tone = 'default',
  active = false,
  className = '',
  children,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-btn icon-btn-${size} icon-btn-${tone}${active ? ' is-active' : ''} ${className}`}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
    </button>
  );
}

interface ModalProps {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  headerExtra?: ReactNode;
  closeLabel?: string;
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  size = 'md',
  className = '',
  headerExtra,
  closeLabel = 'Close',
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  const stackIdRef = useRef<symbol | null>(null);
  if (!stackIdRef.current) stackIdRef.current = Symbol('nimbus-modal');
  useBodyLock(true);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const modalId = stackIdRef.current!;
    modalStack.push(modalId);
    const previous = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => panelRef.current?.focus(), 20);
    const onKey = (event: KeyboardEvent) => {
      // Only the top-most modal reacts, so Escape closes a confirmation rather
      // than the settings dialog behind it.
      if (modalStack[modalStack.length - 1] !== modalId) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      const index = modalStack.lastIndexOf(modalId);
      if (index >= 0) modalStack.splice(index, 1);
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, []);

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className={`modal-panel modal-${size} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="modal-header">
          <div className="modal-heading">
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <div className="modal-header-actions">
            {headerExtra}
            <IconButton label={closeLabel} onClick={onClose}>
              <X size={19} />
            </IconButton>
          </div>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;
  return (
    <Modal
      title={title}
      onClose={onCancel}
      size="sm"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Spinner size={16} /> : null}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className={`confirm-copy${tone === 'danger' ? ' is-danger' : ''}`}>
        <span className="confirm-icon" aria-hidden="true">
          <AlertTriangle size={20} />
        </span>
        <div>{description}</div>
      </div>
    </Modal>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className={`field${error ? ' has-error' : ''}`}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? <p className="field-error">{error}</p> : hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle-row${disabled ? ' is-disabled' : ''}`}>
      <span className="toggle-copy">
        <span className="toggle-label">{label}</span>
        {description ? <span className="toggle-description">{description}</span> : null}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
    </label>
  );
}
