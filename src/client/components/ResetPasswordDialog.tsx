import { useState } from 'react';
import { AlertCircle, Eye, EyeOff, KeyRound, ShieldAlert } from 'lucide-react';
import { desktop } from '../desktop';
import { Field, Modal, Spinner } from './ui';

interface ResetPasswordDialogProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * Desktop-only recovery: replaces the local password without the old one.
 * The actual database write happens in the Electron main process, so it works
 * even though the user cannot sign in.
 */
export function ResetPasswordDialog({ open, onClose, onSuccess }: ResetPasswordDialogProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const close = () => {
    if (busy) return;
    setPassword('');
    setConfirm('');
    setShow(false);
    setError(null);
    onClose();
  };

  const submit = async () => {
    if (!desktop || busy) return;
    if (password.length < 8) {
      setError('The new password must be at least 8 characters long.');
      return;
    }
    if (password !== confirm) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await desktop.resetPassword(password);
      if (!result.ok) {
        setError(result.error ?? 'Could not reset the password.');
        return;
      }
      setPassword('');
      setConfirm('');
      setShow(false);
      onSuccess();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reset the password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Reset password"
      subtitle="Desktop recovery · no old password needed"
      onClose={close}
      size="sm"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void submit()}
            disabled={busy || !password || !confirm}
          >
            {busy ? <Spinner size={16} /> : <KeyRound size={16} />}
            {busy ? 'Resetting…' : 'Reset password'}
          </button>
        </>
      }
    >
      <div className="reset-password-copy">
        <div className="settings-callout inside">
          <ShieldAlert size={18} />
          <div>
            <strong>Local recovery</strong>
            <p>
              This replaces the password on this computer and signs out every existing session. Anyone
              with access to this PC can use it, so keep Windows sign-in and disk encryption enabled.
            </p>
          </div>
        </div>

        {error ? (
          <div className="form-error-banner" role="alert">
            <AlertCircle size={16} /> {error}
          </div>
        ) : null}

        <Field label="New password" htmlFor="reset-password-new" hint="At least 8 characters.">
          <div className="input-with-action">
            <input
              id="reset-password-new"
              className="input"
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              autoFocus
              placeholder="New password"
            />
            <button
              type="button"
              className="input-action"
              onClick={() => setShow((value) => !value)}
              aria-label={show ? 'Hide passwords' : 'Show passwords'}
            >
              {show ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
        </Field>

        <Field label="Confirm new password" htmlFor="reset-password-confirm">
          <input
            id="reset-password-confirm"
            className="input"
            type={show ? 'text' : 'password'}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
            placeholder="Repeat the new password"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </Field>
      </div>
    </Modal>
  );
}
