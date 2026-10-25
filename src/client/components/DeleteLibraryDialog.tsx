import { useEffect, useRef, useState } from 'react';
import type { AccountDeletionStatus } from '../../../shared/types';
import { AlertTriangle, CheckCircle2, Eye, EyeOff, GitBranch, HardDrive, Server, Trash2 } from 'lucide-react';
import { api } from '../api';
import { formatBytes } from '../format';
import { Field, Modal, Spinner } from './ui';

interface DeleteLibraryDialogProps {
  open: boolean;
  vaultName: string;
  itemCount: number;
  usedBytes: number;
  github: { configured: boolean; owner: string; repo: string };
  webdav: { configured: boolean };
  onClose: () => void;
  onDeleted: () => void;
  onDeletionStarted: () => void;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Could not start the deletion.';
}

export function DeleteLibraryDialog({
  open,
  vaultName,
  itemCount,
  usedBytes,
  github,
  webdav,
  onClose,
  onDeleted,
  onDeletionStarted,
}: DeleteLibraryDialogProps) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [deleteRepository, setDeleteRepository] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [starting, setStarting] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<AccountDeletionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const finishedRef = useRef(false);

  const running = status?.phase === 'running' || status?.phase === 'finalizing';
  const done = status?.phase === 'done';
  const failed = status?.failed ?? 0;
  const ready = password.length > 0 && confirmation === 'DELETE' && (!deleteRepository || github.configured);

  useEffect(() => {
    if (!open) {
      setPassword('');
      setConfirmation('');
      setDeleteRepository(false);
      setShowPassword(false);
      setStarting(false);
      setToken(null);
      setStatus(null);
      setError(null);
      finishedRef.current = false;
    }
  }, [open]);

  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    const controller = new AbortController();
    let timer: number | null = null;

    const poll = async (): Promise<void> => {
      try {
        const result = await api.getAccountDeletion(token, controller.signal);
        if (cancelled) return;
        setStatus(result.deletion);
        if (result.deletion.phase === 'done') {
          if (!finishedRef.current && result.deletion.failed === 0) {
            finishedRef.current = true;
            timer = window.setTimeout(() => {
              if (!cancelled) onDeleted();
            }, 900);
          }
          return;
        }
        if (result.deletion.phase === 'error') {
          setStarting(false);
          setError(result.deletion.error ? `Deletion stopped: ${result.deletion.error}` : 'Deletion could not finish.');
          setToken(null);
          return;
        }
        timer = window.setTimeout(() => void poll(), 900);
      } catch (caught) {
        if (cancelled || controller.signal.aborted) return;
        setError(errorText(caught));
        timer = window.setTimeout(() => void poll(), 2_500);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [open, token, onDeleted]);

  const start = async () => {
    if (!ready || starting) return;
    setStarting(true);
    setError(null);
    try {
      const result = await api.startAccountDeletion(password, confirmation, deleteRepository);
      setToken(result.token);
      setStatus(result.deletion);
      onDeletionStarted();
    } catch (caught) {
      setError(errorText(caught));
      setStarting(false);
    }
  };

  if (!open) return null;

  const close = () => {
    if (running || starting) return;
    onClose();
  };

  const progress = status
    ? status.phase === 'finalizing'
      ? 92
      : status.total > 0
        ? Math.min(100, Math.round((status.processed / status.total) * 100))
        : status.phase === 'done'
          ? 100
          : 4
    : 0;

  const footer = done ? (
    <>
      {failed > 0 ? (
        <button type="button" className="btn btn-ghost" onClick={onDeleted}>
          Continue to setup
        </button>
      ) : (
        <span className="deletion-auto-note">
          <Spinner size={14} /> Opening setup…
        </span>
      )}
    </>
  ) : running ? (
    <span className="deletion-auto-note">Deletion cannot be cancelled once it has started.</span>
  ) : (
    <>
      <button type="button" className="btn btn-ghost" onClick={close} disabled={starting}>
        Cancel
      </button>
      <button
        type="button"
        className="btn btn-danger"
        onClick={() => void start()}
        disabled={!ready || starting}
      >
        {starting ? <Spinner size={16} /> : <Trash2 size={16} />}
        {starting ? 'Starting…' : 'Delete everything'}
      </button>
    </>
  );

  return (
    <Modal
      title="Delete library & account"
      subtitle={vaultName ? `${vaultName} · This cannot be undone.` : 'This cannot be undone.'}
      onClose={close}
      size="md"
      footer={footer}
    >
      {status && status.phase !== 'error' ? (
        <div className="deletion-progress">
          <div className={`deletion-progress-icon${done && failed > 0 ? ' is-warning' : ''}`}>
            {done && failed === 0 ? <CheckCircle2 size={26} /> : <Trash2 size={26} />}
          </div>
          <h3>
            {done
              ? failed > 0
                ? 'Library deleted with warnings'
                : 'Your library has been deleted'
              : status.phase === 'finalizing'
                ? 'Finishing up'
                : 'Deleting your library'}
          </h3>
          <p>{status.message}</p>
          <div
            className={`deletion-bar${status.total === 0 && !done ? ' is-indeterminate' : ''}`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={done ? 100 : progress}
          >
            <span style={{ width: `${done ? 100 : progress}%` }} />
          </div>
          {status.total > 0 ? (
            <span className="deletion-count">
              {status.processed.toLocaleString()} of {status.total.toLocaleString()} items processed
              {failed > 0 ? ` · ${failed.toLocaleString()} failed` : ''}
            </span>
          ) : (
            <span className="deletion-count">This can take a moment for large libraries.</span>
          )}
          {status.repositoryDeleted ? (
            <p className="deletion-note">
              <GitBranch size={15} /> The GitHub repository {github.owner}/{github.repo} was deleted.
            </p>
          ) : null}
          {done && failed > 0 ? (
            <div className="form-error-banner" role="alert">
              <AlertTriangle size={16} />
              <span>
                {failed.toLocaleString()} {failed === 1 ? 'item could' : 'items could'} not be removed from cloud
                storage. The local library is gone, so remove those files from your provider manually.
                {status.error ? ` Last error: ${status.error}` : ''}
              </span>
            </div>
          ) : null}
          {running ? <span className="deletion-count">Keep this window open. Nimbus is removing data now.</span> : null}
        </div>
      ) : (
        <div className="deletion-confirm">
          <div className="deletion-warning">
            <span className="deletion-warning-icon" aria-hidden="true">
              <AlertTriangle size={22} />
            </span>
            <div>
              <strong>Everything in this library will be erased.</strong>
              <p>
                This removes your password, sessions, settings, folders, metadata, previews, cache and staged
                uploads. It cannot be undone.
              </p>
            </div>
          </div>

          <ul className="deletion-list">
            <li>
              <HardDrive size={16} />
              <span>
                {itemCount.toLocaleString()} {itemCount === 1 ? 'item' : 'items'} ({formatBytes(usedBytes)}) will
                be deleted from Nimbus and from your configured cloud storage.
              </span>
            </li>
            {github.configured ? (
              <li>
                <GitBranch size={16} />
                <span>
                  Nimbus deletes the assets it knows about in <strong>{github.owner}/{github.repo}</strong>.
                  {deleteRepository
                    ? ' The entire repository will also be permanently deleted.'
                    : ' Other files in that repository are left alone.'}
                </span>
              </li>
            ) : null}
            {webdav.configured ? (
              <li>
                <Server size={16} />
                <span>
                  Files Nimbus uploaded to your WebDAV folder are removed. Anything else on the server is left
                  alone.
                </span>
              </li>
            ) : null}
            <li>
              <Trash2 size={16} />
              <span>
                Encryption keys and the empty database file stay on disk so Nimbus can start a fresh library.
              </span>
            </li>
          </ul>

          {github.configured ? (
            <label className={`danger-check${deleteRepository ? ' is-checked' : ''}`}>
              <input
                type="checkbox"
                checked={deleteRepository}
                onChange={(event) => setDeleteRepository(event.target.checked)}
                disabled={starting}
              />
              <span>
                <strong>Also delete the GitHub repository</strong>
                <small>
                  Removes {github.owner}/{github.repo}, including anything else stored in it. Leave this off to
                  delete only Nimbus files.
                </small>
              </span>
            </label>
          ) : null}

          {error ? (
            <div className="form-error-banner" role="alert">
              <AlertTriangle size={16} /> {error}
            </div>
          ) : null}

          <Field
            label="Your password"
            htmlFor="deletion-password"
            hint="Confirms that you own this library."
          >
            <div className="input-with-action">
              <input
                id="deletion-password"
                className="input"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                disabled={starting}
              />
              <button
                type="button"
                className="input-action"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
          </Field>

          <Field
            label="Type DELETE to confirm"
            htmlFor="deletion-confirm"
            hint="This extra step prevents accidental clicks."
          >
            <input
              id="deletion-confirm"
              className="input"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder="DELETE"
              autoComplete="off"
              spellCheck={false}
              disabled={starting}
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}
