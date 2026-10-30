import { useEffect, useState } from 'react';
import type { ItemDTO, ShareDTO, ShareExpiry } from '../../../shared/types';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Copy,
  Globe2,
  Link2,
  Loader2,
  Share2,
  ShieldOff,
  Trash2,
} from 'lucide-react';
import { api } from '../api';
import { formatDateTime } from '../format';
import { ConfirmDialog, Modal, Spinner } from './ui';

interface ShareDialogProps {
  item: ItemDTO;
  onClose: () => void;
  onNotify: (message: string, kind?: 'success' | 'error' | 'info') => void;
}

const EXPIRY_OPTIONS: Array<{ value: ShareExpiry; label: string }> = [
  { value: '1d', label: '24 hours' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'never', label: 'No expiry' },
];

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    // Clipboard API needs a secure context. Fall back for LAN/HTTP installs.
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function shareStatus(share: ShareDTO): string {
  if (share.revokedAt) return 'Revoked';
  if (!share.active) return 'Expired';
  if (share.expiresAt === null) return 'No expiry';
  return `Expires ${formatDateTime(share.expiresAt)}`;
}

export function ShareDialog({ item, onClose, onNotify }: ShareDialogProps) {
  const [shares, setShares] = useState<ShareDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [expiry, setExpiry] = useState<ShareExpiry>('7d');
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ShareDTO | null>(null);
  const [revoking, setRevoking] = useState(false);
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .listShares(item.id)
      .then((result) => {
        if (cancelled) return;
        setShares(result.shares);
        setLoadError(null);
      })
      .catch((error: Error) => {
        if (!cancelled) setLoadError(error.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  const create = async () => {
    setCreating(true);
    try {
      const result = await api.createShare(item.id, expiry);
      setShares((current) => [result.share, ...current]);
      const copied = await copyText(result.share.url);
      onNotify(copied ? 'Share link created and copied.' : 'Share link created.', 'success');
      if (copied) {
        setCopiedId(result.share.id);
        window.setTimeout(() => setCopiedId(null), 2000);
      }
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not create a share link.', 'error');
    } finally {
      setCreating(false);
    }
  };

  const copy = async (share: ShareDTO) => {
    const ok = await copyText(share.url);
    if (!ok) {
      onNotify('Could not copy the link. Select it and copy manually.', 'error');
      return;
    }
    setCopiedId(share.id);
    window.setTimeout(() => setCopiedId(null), 2000);
    onNotify('Share link copied.', 'success');
  };

  const nativeShare = async (share: ShareDTO) => {
    try {
      await navigator.share({ title: item.name, url: share.url });
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        onNotify('The share sheet is not available. Copy the link instead.', 'error');
      }
    }
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await api.revokeShare(revokeTarget.id);
      setShares((current) =>
        current.map((share) =>
          share.id === revokeTarget.id
            ? { ...share, revokedAt: Date.now(), active: false }
            : share,
        ),
      );
      onNotify('Share link revoked.', 'success');
      setRevokeTarget(null);
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not revoke the link.', 'error');
    } finally {
      setRevoking(false);
    }
  };

  const active = shares.filter((share) => share.active);
  const inactive = shares.filter((share) => !share.active);

  const row = (share: ShareDTO) => (
    <li key={share.id} className={`share-row${share.active ? '' : ' is-inactive'}`}>
      <div className="share-row-main">
        <div className="share-url-wrap">
          <Link2 size={15} aria-hidden="true" />
          <input
            className="share-url"
            value={share.url}
            readOnly
            aria-label="Public share link"
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
        <div className="share-row-meta">
          <span className={`share-status${share.active ? ' is-active' : ''}`}>
            {share.active ? <Globe2 size={13} /> : <ShieldOff size={13} />}
            {shareStatus(share)}
          </span>
          <span>
            <Clock3 size={13} /> {share.accessCount} {share.accessCount === 1 ? 'view' : 'views'}
          </span>
          <span>Created {formatDateTime(share.createdAt)}</span>
        </div>
      </div>
      <div className="share-row-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy(share)}>
          {copiedId === share.id ? <CheckCircle2 size={15} /> : <Copy size={15} />}
          {copiedId === share.id ? 'Copied' : 'Copy'}
        </button>
        {share.active && canNativeShare ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void nativeShare(share)}>
            <Share2 size={15} /> Share
          </button>
        ) : null}
        {share.active ? (
          <button
            type="button"
            className="btn btn-danger-ghost btn-sm"
            onClick={() => setRevokeTarget(share)}
          >
            <Trash2 size={15} /> Revoke
          </button>
        ) : null}
      </div>
    </li>
  );

  return (
    <Modal
      title="Share file"
      subtitle={item.name}
      onClose={onClose}
      size="lg"
      className="share-modal"
    >
      <div className="share-dialog">
        <div className="share-callout">
          <Globe2 size={18} />
          <div>
            <strong>Anyone with the link can view this file.</strong>
            <p>
              Links are unguessable and can be revoked at any time. They are not indexed by search
              engines. Expired or revoked links stop working immediately.
            </p>
          </div>
        </div>

        <div className="share-create">
          <div>
            <span className="field-label" id="share-expiry-label">
              Link expiry
            </span>
            <select
              className="input"
              value={expiry}
              onChange={(event) => setExpiry(event.target.value as ShareExpiry)}
              aria-labelledby="share-expiry-label"
              disabled={creating}
            >
              {EXPIRY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => void create()} disabled={creating}>
            {creating ? <Loader2 size={16} className="spin" /> : <Link2 size={16} />}
            {creating ? 'Creating…' : 'Create link'}
          </button>
        </div>

        {loading ? (
          <div className="share-loading">
            <Spinner size={20} /> Loading links…
          </div>
        ) : loadError ? (
          <div className="share-error">
            <AlertCircle size={17} /> {loadError}
          </div>
        ) : active.length === 0 && inactive.length === 0 ? (
          <div className="share-empty">
            <Link2 size={22} />
            <p>No links yet. Create one above to share this file outside Nimbus.</p>
          </div>
        ) : (
          <>
            {active.length > 0 ? <ul className="share-list">{active.map(row)}</ul> : null}
            {inactive.length > 0 ? (
              <details className="share-history">
                <summary>
                  {inactive.length} expired or revoked {inactive.length === 1 ? 'link' : 'links'}
                </summary>
                <ul className="share-list">{inactive.map(row)}</ul>
              </details>
            ) : null}
          </>
        )}
      </div>

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke this link?"
        description={
          <span>
            The public link will stop working immediately. Anyone who already opened or downloaded the
            file keeps their copy.
          </span>
        }
        confirmLabel="Revoke link"
        tone="danger"
        busy={revoking}
        onCancel={() => {
          if (!revoking) setRevokeTarget(null);
        }}
        onConfirm={() => void revoke()}
      />
    </Modal>
  );
}
