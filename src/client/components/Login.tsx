import { useState } from 'react';
import type { AppStatus } from '../../../shared/types';
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react';
import { api } from '../api';
import { isDesktop } from '../desktop';
import { ResetPasswordDialog } from './ResetPasswordDialog';
import { Logo, Spinner } from './ui';

interface LoginProps {
  vaultName: string;
  version: string;
  onSuccess: (status: AppStatus) => void;
}

export function Login({ vaultName, version, onSuccess }: LoginProps) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetNotice, setResetNotice] = useState<string | null>(null);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(password);
      onSuccess(result.status);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not sign in.');
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-orb login-orb-a" aria-hidden="true" />
      <div className="login-orb login-orb-b" aria-hidden="true" />
      <div className="login-wrap">
        <div className="login-brand">
          <Logo size={36} />
        </div>
        <div className="login-card">
          <span className="login-lock" aria-hidden="true">
            <LockKeyhole size={24} />
          </span>
          <h1>{vaultName}</h1>
          <p className="login-subtitle">This library is private. Enter your password to continue.</p>

          {resetNotice ? (
            <div className="form-success-banner" role="status">
              <CheckCircle2 size={17} /> {resetNotice}
            </div>
          ) : null}

          {error ? (
            <div className="form-error-banner" role="alert">
              <AlertCircle size={17} /> {error}
            </div>
          ) : null}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="field-label" htmlFor="login-password">
              Password
            </label>
            <div className="input-with-action">
              <input
                id="login-password"
                className="input input-lg"
                type={show ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                autoFocus
                placeholder="Your library password"
              />
              <button
                type="button"
                className="input-action"
                onClick={() => setShow((value) => !value)}
                aria-label={show ? 'Hide password' : 'Show password'}
              >
                {show ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            <button type="submit" className="btn btn-primary btn-lg login-submit" disabled={!password || busy}>
              {busy ? <Spinner size={18} /> : <LockKeyhole size={18} />}
              {busy ? 'Unlocking…' : 'Unlock library'}
              {!busy ? <ArrowRight size={17} /> : null}
            </button>
          </form>

          {isDesktop ? (
            <button
              type="button"
              className="login-forgot"
              onClick={() => {
                setError(null);
                setResetOpen(true);
              }}
            >
              Forgot password?
            </button>
          ) : null}

          <div className="login-foot">
            <ShieldCheck size={15} />
            <span>Self-hosted · No tracking · Your storage</span>
          </div>
        </div>
        <p className="login-version">Nimbus {version}</p>
      </div>

      <ResetPasswordDialog
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        onSuccess={() => {
          setPassword('');
          setError(null);
          setResetNotice('Password updated. Sign in with your new password.');
        }}
      />
    </div>
  );
}
