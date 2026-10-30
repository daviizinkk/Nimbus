import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ItemDTO } from '../../../shared/types';
import {
  AlertCircle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cloud,
  Copy,
  Database,
  Download,
  ExternalLink,
  File,
  FolderInput,
  HardDriveDownload,
  Heart,
  ImageOff,
  Info,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  RotateCcw,
  Share2,
  ShieldCheck,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { api, contentUrl, fetchTextPreview, thumbUrl } from '../api';
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  isTextPreviewable,
  kindLabel,
  providerLabel,
} from '../format';
import { useBodyLock, useClickOutside } from '../hooks';
import { ShareDialog } from './ShareDialog';
import { ConfirmDialog, Field, IconButton, Modal, Spinner } from './ui';

interface ViewerProps {
  item: ItemDTO;
  items: ItemDTO[];
  onClose: () => void;
  onNavigate: (id: string) => void;
  onItemUpdated: (item: ItemDTO) => void;
  onRequestDelete: (item: ItemDTO) => void;
  onMove: (item: ItemDTO) => void;
  onNotify: (message: string, kind?: 'success' | 'error' | 'info') => void;
}

function IconAction({
  label,
  onClick,
  active = false,
  disabled = false,
  children,
}: {
  label: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`viewer-icon-btn${active ? ' is-active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function InfoRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="info-row">
      <span className="info-icon" aria-hidden="true">
        {icon}
      </span>
      <div>
        <span className="info-label">{label}</span>
        <span className="info-value">{children}</span>
      </div>
    </div>
  );
}

export function Viewer({
  item,
  items,
  onClose,
  onNavigate,
  onItemUpdated,
  onRequestDelete,
  onMove,
  onNotify,
}: ViewerProps) {
  const [current, setCurrent] = useState(item);
  const [infoOpen, setInfoOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState(item.name);
  const [renaming, setRenaming] = useState(false);
  const [trashConfirm, setTrashConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [offlinePolling, setOfflinePolling] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [mediaLoaded, setMediaLoaded] = useState(false);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [text, setText] = useState<{ loading: boolean; value: string; truncated: boolean; error: string | null }>({
    loading: false,
    value: '',
    truncated: false,
    error: null,
  });

  const menuRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const currentRef = useRef(current);
  const pollToken = useRef(0);
  useBodyLock(true);
  useClickOutside(menuRef, () => setMenuOpen(false), menuOpen);

  useEffect(
    () => () => {
      pollToken.current += 1;
    },
    [],
  );

  useEffect(() => {
    setCurrent(item);
  }, [item]);

  useEffect(() => {
    currentRef.current = current;
  }, [current]);

  useEffect(() => {
    setInfoOpen(false);
    setMenuOpen(false);
    setRenameOpen(false);
    setTrashConfirm(false);
    setZoomed(false);
    setMediaLoaded(false);
    setMediaFailed(false);
    setText({ loading: false, value: '', truncated: false, error: null });
    pollToken.current += 1;
    setOfflinePolling(false);
  }, [current.id]);

  const index = items.findIndex((entry) => entry.id === current.id);
  const prev = index > 0 ? items[index - 1] : null;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : null;
  const isText = current.kind === 'file' && isTextPreviewable(current.mime, current.name);
  const isPdf = current.mime === 'application/pdf';
  const isAudio = current.mime.startsWith('audio/');
  const isImage = current.kind === 'photo';
  const isVideo = current.kind === 'video';
  const ready = current.status === 'ready';
  const isLocal = current.provider === 'local';

  const apply = useCallback(
    (updated: ItemDTO) => {
      setCurrent(updated);
      onItemUpdated(updated);
    },
    [onItemUpdated],
  );

  useEffect(() => {
    if (!isText || !ready) return;
    let cancelled = false;
    setText({ loading: true, value: '', truncated: false, error: null });
    fetchTextPreview(current.id)
      .then((result) => {
        if (cancelled) return;
        setText({ loading: false, value: result.text, truncated: result.truncated, error: null });
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setText({ loading: false, value: '', truncated: false, error: error.message });
      });
    return () => {
      cancelled = true;
    };
  }, [current.id, isText, ready]);

  useEffect(() => {
    // Neighbouring *thumbnails* are tiny and make the next photo feel instant.
    // The original is only warmed after the current image has decoded.
    for (const neighbor of [next, prev]) {
      if (neighbor && neighbor.hasThumb && (neighbor.kind === 'photo' || neighbor.kind === 'video')) {
        const image = new Image();
        image.decoding = 'async';
        image.src = thumbUrl(neighbor.id);
      }
    }
  }, [next, prev]);

  useEffect(() => {
    if (!mediaLoaded || !ready || !isImage) return;
    const neighbor = next?.kind === 'photo' ? next : prev?.kind === 'photo' ? prev : null;
    if (!neighbor || neighbor.status !== 'ready') return;
    const timer = window.setTimeout(() => {
      const image = new Image();
      image.decoding = 'async';
      image.src = contentUrl(neighbor.id);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [isImage, mediaLoaded, next, prev, ready]);

  const navigateTo = useCallback(
    (target: ItemDTO | null) => {
      if (!target) return;
      onNavigate(target.id);
    },
    [onNavigate],
  );

  const toggleFavorite = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await api.updateItem(current.id, { favorite: !current.favorite });
      apply(result.item);
      onNotify(result.item.favorite ? 'Added to favorites.' : 'Removed from favorites.', 'success');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not update favorites.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const pollOffline = async (id: string, token: number): Promise<void> => {
    for (let attempt = 0; attempt < 180; attempt++) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_800));
      if (pollToken.current !== token) return;
      try {
        const fresh = (await api.getItem(id)).item;
        onItemUpdated(fresh);
        if (currentRef.current.id === id) setCurrent(fresh);
        if (fresh.cached && fresh.pinned) {
          if (pollToken.current === token) setOfflinePolling(false);
          onNotify('Available offline.', 'success');
          return;
        }
        if (fresh.cacheError) {
          if (pollToken.current === token) setOfflinePolling(false);
          onNotify(`Could not save offline: ${fresh.cacheError}`, 'error');
          return;
        }
      } catch {
        // Keep polling through transient network failures.
      }
    }
    if (pollToken.current === token) {
      setOfflinePolling(false);
      onNotify('Still saving offline. Check back shortly.', 'info');
    }
  };

  const toggleOffline = async () => {
    if (busy || offlinePolling) return;
    setBusy(true);
    try {
      if (current.pinned) {
        const result = await api.unpinOffline(current.id);
        apply(result.item);
        onNotify('Offline copy removed. The original is still in your cloud.', 'success');
      } else {
        const result = await api.pinOffline(current.id);
        apply(result.item);
        setOfflinePolling(true);
        onNotify('Saving a copy for offline use…', 'info');
        const token = ++pollToken.current;
        void pollOffline(current.id, token);
      }
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not change the offline copy.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const trash = async () => {
    setBusy(true);
    try {
      const result = await api.trashItem(current.id);
      onItemUpdated(result.item);
      onNotify('Moved to trash. It will be deleted after 30 days.', 'success');
      onClose();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not move this item to trash.', 'error');
    } finally {
      setBusy(false);
      setTrashConfirm(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    try {
      const result = await api.restoreItem(current.id);
      apply(result.item);
      onNotify('Restored to your library.', 'success');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not restore this item.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    const name = renameValue.trim();
    if (!name) return;
    setRenaming(true);
    try {
      const result = await api.updateItem(current.id, { name });
      apply(result.item);
      setRenameOpen(false);
      onNotify('File renamed.', 'success');
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Could not rename this file.', 'error');
    } finally {
      setRenaming(false);
    }
  };

  const copyName = async () => {
    try {
      await navigator.clipboard.writeText(current.name);
      onNotify('File name copied.', 'success');
    } catch {
      onNotify('Could not copy the file name.', 'error');
    }
    setMenuOpen(false);
  };

  const mediaErrorBlock = mediaFailed || current.status === 'error';

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)
      ) {
        return;
      }
      if (document.querySelector('.modal-backdrop')) return;
      const key = event.key;
      if (key === 'Escape') {
        if (menuOpen) {
          setMenuOpen(false);
        } else if (infoOpen) {
          setInfoOpen(false);
        } else {
          onClose();
        }
        return;
      }
      if (key === 'ArrowLeft') {
        event.preventDefault();
        navigateTo(prev);
        return;
      }
      if (key === 'ArrowRight') {
        event.preventDefault();
        navigateTo(next);
        return;
      }
      if (key.toLowerCase() === 'f' && !current.trashedAt) {
        event.preventDefault();
        void toggleFavorite();
        return;
      }
      if (key.toLowerCase() === 'i') {
        event.preventDefault();
        setInfoOpen((value) => !value);
        return;
      }
      if (key.toLowerCase() === 'd' && ready) {
        event.preventDefault();
        const link = document.createElement('a');
        link.href = contentUrl(current.id, true);
        link.download = current.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        return;
      }
      if ((key === 'Delete' || key === 'Backspace') && !current.trashedAt) {
        event.preventDefault();
        setTrashConfirm(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    current.id,
    current.name,
    current.trashedAt,
    infoOpen,
    menuOpen,
    navigateTo,
    next,
    onClose,
    prev,
    ready,
    toggleFavorite,
  ]);

  return (
    <div className="viewer" role="dialog" aria-modal="true" aria-label={`Viewing ${current.name}`}>
      <header className="viewer-head">
        <div className="viewer-head-left">
          <IconButton label="Close viewer" tone="light" onClick={onClose}>
            <X size={21} />
          </IconButton>
          <div className="viewer-heading">
            <h2 title={current.name}>{current.name}</h2>
            <span>
              {formatBytes(current.size)} · {formatDateTime(current.takenAt ?? current.createdAt)}
              {current.width && current.height ? ` · ${current.width}×${current.height}` : ''}
            </span>
          </div>
        </div>

        <div className="viewer-head-actions">
          {ready ? (
            <a
              className="viewer-icon-btn"
              href={contentUrl(current.id, true)}
              download={current.name}
              aria-label="Download original"
              title="Download original"
            >
              <Download size={19} />
            </a>
          ) : null}
          {!current.trashedAt ? (
            <IconAction
              label={current.favorite ? 'Remove from favorites' : 'Add to favorites'}
              onClick={() => void toggleFavorite()}
              active={current.favorite}
              disabled={busy}
            >
              <Heart size={19} fill={current.favorite ? 'currentColor' : 'none'} />
            </IconAction>
          ) : null}
          {ready && !current.trashedAt ? (
            <IconAction label="Share public link" onClick={() => setShareOpen(true)} active={shareOpen}>
              <Share2 size={19} />
            </IconAction>
          ) : null}
          {ready && !isLocal ? (
            <IconAction
              label={
                offlinePolling
                  ? 'Saving offline copy'
                  : current.pinned
                    ? 'Remove offline copy'
                    : 'Make available offline'
              }
              onClick={() => void toggleOffline()}
              active={current.pinned}
              disabled={busy || offlinePolling}
            >
              {offlinePolling ? <Loader2 size={19} className="spin" /> : <HardDriveDownload size={19} />}
            </IconAction>
          ) : null}
          <IconAction label="File information" onClick={() => setInfoOpen((value) => !value)} active={infoOpen}>
            <Info size={19} />
          </IconAction>
          <div className="viewer-menu-wrap" ref={menuRef}>
            <IconAction label="More actions" onClick={() => setMenuOpen((value) => !value)} active={menuOpen}>
              <MoreHorizontal size={20} />
            </IconAction>
            {menuOpen ? (
              <div className="menu viewer-menu" role="menu">
                {current.trashedAt ? (
                  <button type="button" className="menu-item" onClick={() => { setMenuOpen(false); void restore(); }}>
                    <RotateCcw size={16} /> Restore
                  </button>
                ) : (
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      setRenameOpen(true);
                      setRenameValue(current.name);
                    }}
                  >
                    <Pencil size={16} /> Rename
                  </button>
                )}
                {!current.trashedAt && current.kind === 'file' ? (
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onMove(current);
                    }}
                  >
                    <FolderInput size={16} /> Move to folder
                  </button>
                ) : null}
                {ready && !current.trashedAt ? (
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      setShareOpen(true);
                    }}
                  >
                    <Share2 size={16} /> Share public link
                  </button>
                ) : null}
                <button
                  type="button"
                  className="menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    setInfoOpen(true);
                  }}
                >
                  <Info size={16} /> Details
                </button>
                <button type="button" className="menu-item" onClick={() => void copyName()}>
                  <Copy size={16} /> Copy file name
                </button>
                {ready && (isImage || isVideo || isPdf) ? (
                  <a
                    className="menu-item"
                    href={contentUrl(current.id)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => setMenuOpen(false)}
                  >
                    <ExternalLink size={16} /> Open preview in new tab
                  </a>
                ) : null}
                <div className="menu-separator" />
                {current.trashedAt ? (
                  <button
                    type="button"
                    className="menu-item is-danger"
                    onClick={() => {
                      setMenuOpen(false);
                      onRequestDelete(current);
                    }}
                  >
                    <Trash2 size={16} /> Delete forever
                  </button>
                ) : (
                  <button
                    type="button"
                    className="menu-item is-danger"
                    onClick={() => {
                      setMenuOpen(false);
                      setTrashConfirm(true);
                    }}
                  >
                    <Trash2 size={16} /> Move to trash
                  </button>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="viewer-main">
        <div
          ref={stageRef}
          className={`viewer-stage${infoOpen ? ' with-info' : ''}`}
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          {!ready ? (
            <div className="viewer-file-card">
              <span className={`viewer-file-icon ${current.status === 'error' ? 'is-error' : ''}`}>
                {current.status === 'error' ? <AlertCircle size={38} /> : <Spinner size={38} />}
              </span>
              <h3>
                {current.status === 'error' ? 'This upload could not be saved' : 'Your file is on its way'}
              </h3>
              <p>
                {current.status === 'error'
                  ? current.error || 'The storage provider rejected this upload.'
                  : 'Nimbus is saving the original to your cloud. The preview will be available as soon as it lands.'}
              </p>
            </div>
          ) : isImage ? (
            <div className={`viewer-canvas${zoomed ? ' is-zoomed' : ''}`}>
              {!mediaLoaded && !mediaFailed ? (
                <span className="viewer-loading">
                  <Spinner size={28} />
                </span>
              ) : null}
              {mediaErrorBlock ? (
                <div className="viewer-file-card">
                  <span className="viewer-file-icon is-error">
                    <ImageOff size={38} />
                  </span>
                  <h3>Preview unavailable</h3>
                  <p>The image could not be displayed, but the original is safe. Try downloading it.</p>
                  <a className="btn btn-light" href={contentUrl(current.id, true)} download={current.name}>
                    <Download size={17} /> Download original
                  </a>
                </div>
              ) : (
                <>
                  {current.hasThumb && !mediaLoaded ? (
                    <img
                      className="viewer-photo-preview"
                      src={thumbUrl(current.id)}
                      alt=""
                      aria-hidden="true"
                      decoding="async"
                      draggable={false}
                    />
                  ) : null}
                  <img
                    key={current.id}
                    src={contentUrl(current.id)}
                    alt={current.name}
                    className={`viewer-photo${zoomed ? ' is-zoomed' : ''}${mediaLoaded ? ' is-loaded' : ''}`}
                    loading="eager"
                    decoding="async"
                    fetchPriority="high"
                    onLoad={() => setMediaLoaded(true)}
                    onError={() => setMediaFailed(true)}
                    onDoubleClick={() => setZoomed((value) => !value)}
                    draggable={false}
                  />
                </>
              )}
            </div>
          ) : isVideo ? (
            <div className="viewer-video-wrap">
              {mediaErrorBlock ? (
                <div className="viewer-file-card">
                  <span className="viewer-file-icon is-error">
                    <AlertCircle size={38} />
                  </span>
                  <h3>This video cannot be played here</h3>
                  <p>Your browser may not support this codec. The original is safe and can be downloaded.</p>
                  <a className="btn btn-light" href={contentUrl(current.id, true)} download={current.name}>
                    <Download size={17} /> Download video
                  </a>
                </div>
              ) : (
                <video
                  key={current.id}
                  className="viewer-video"
                  src={contentUrl(current.id)}
                  poster={current.hasThumb ? thumbUrl(current.id) : undefined}
                  controls
                  playsInline
                  autoPlay
                  onError={() => setMediaFailed(true)}
                >
                  Your browser cannot play this video.
                </video>
              )}
            </div>
          ) : isAudio ? (
            <div className="viewer-file-card viewer-audio">
              <span className="viewer-audio-art">
                <Play size={36} fill="currentColor" />
              </span>
              <h3>{current.name}</h3>
              <p>Audio · {formatDuration(current.duration)}</p>
              <audio controls autoPlay src={contentUrl(current.id)} className="audio-player">
                Your browser cannot play this audio file.
              </audio>
            </div>
          ) : isPdf ? (
            <iframe className="viewer-pdf" src={contentUrl(current.id)} title={current.name} />
          ) : isText ? (
            <div className="viewer-text-wrap">
              <div className="viewer-text-head">
                <span>
                  {text.loading ? 'Loading text preview…' : text.truncated ? 'Showing the first 512 KB' : 'Text preview'}
                </span>
                <div>
                  <button
                    type="button"
                    className="link-button light"
                    onClick={() => {
                      void navigator.clipboard
                        .writeText(text.value)
                        .then(() => onNotify('Copied to clipboard.', 'success'))
                        .catch(() => onNotify('Could not copy text.', 'error'));
                    }}
                    disabled={!text.value}
                  >
                    <Copy size={14} /> Copy
                  </button>
                  <a className="link-button light" href={contentUrl(current.id, true)} download={current.name}>
                    <Download size={14} /> Download
                  </a>
                </div>
              </div>
              {text.loading ? (
                <div className="text-preview-loading">
                  <Spinner size={20} /> Reading file…
                </div>
              ) : text.error ? (
                <div className="text-preview-loading">
                  <AlertCircle size={18} /> {text.error}
                </div>
              ) : (
                <pre className="viewer-text">{text.value}</pre>
              )}
            </div>
          ) : (
            <div className="viewer-file-card">
              <span className="viewer-file-icon">
                <File size={38} />
              </span>
              <h3>{current.name}</h3>
              <p>
                {formatBytes(current.size)} · {current.mime || 'Unknown file type'}
              </p>
              <a className="btn btn-light" href={contentUrl(current.id, true)} download={current.name}>
                <Download size={17} /> Download file
              </a>
              <span className="viewer-file-note">This file type has no in-browser preview.</span>
            </div>
          )}

          {ready && isImage ? (
            <div className="viewer-stage-tools">
              <IconAction label={zoomed ? 'Fit to screen' : 'Actual size'} onClick={() => setZoomed((value) => !value)}>
                {zoomed ? <ZoomOut size={19} /> : <ZoomIn size={19} />}
              </IconAction>
            </div>
          ) : null}
        </div>

        {infoOpen ? (
          <aside className="viewer-info" aria-label="File information">
            <div className="viewer-info-head">
              <h3>Details</h3>
              <IconAction label="Close details" onClick={() => setInfoOpen(false)}>
                <X size={18} />
              </IconAction>
            </div>
            <div className="viewer-info-scroll">
              <div className="info-preview">
                {current.hasThumb && (isImage || isVideo) ? (
                  <img src={thumbUrl(current.id)} alt="" />
                ) : (
                  <span>
                    <File size={28} />
                  </span>
                )}
              </div>
              <h4 className="info-name">{current.name}</h4>
              <p className="info-kind">
                {kindLabel(current.kind)} {current.favorite ? ' · Favorite' : ''}
              </p>

              <div className="info-rows">
                <InfoRow icon={<File size={15} />} label="Type">
                  {current.mime || 'Unknown'}
                </InfoRow>
                <InfoRow icon={<Database size={15} />} label="Size">
                  {formatBytes(current.size)}
                </InfoRow>
                {current.width && current.height ? (
                  <InfoRow icon={<ImageOff size={15} />} label="Dimensions">
                    {current.width} × {current.height} px
                  </InfoRow>
                ) : null}
                {current.duration ? (
                  <InfoRow icon={<Clock size={15} />} label="Duration">
                    {formatDuration(current.duration)}
                  </InfoRow>
                ) : null}
                <InfoRow icon={<CalendarDays size={15} />} label="Taken / added">
                  {formatDateTime(current.takenAt ?? current.createdAt)}
                </InfoRow>
                <InfoRow icon={<Cloud size={15} />} label="Stored in">
                  {providerLabel(current.provider)}
                </InfoRow>
                <InfoRow icon={<HardDriveDownload size={15} />} label="Offline copy">
                  {isLocal
                    ? 'On this device'
                    : current.pinned
                      ? 'Pinned for offline use'
                      : current.cached
                        ? 'Cached locally'
                        : 'Not cached'}
                </InfoRow>
                <InfoRow icon={<ShieldCheck size={15} />} label="Integrity">
                  SHA-256 verified on download
                </InfoRow>
                {current.trashedAt ? (
                  <InfoRow icon={<Trash2 size={15} />} label="In trash">
                    Deletes automatically on {formatDateTime(current.trashedAt + 30 * 24 * 60 * 60 * 1000)}
                  </InfoRow>
                ) : null}
              </div>

              {current.cacheError ? (
                <div className="info-warning">
                  <AlertCircle size={15} />
                  <span>{current.cacheError}</span>
                </div>
              ) : null}

              {!current.trashedAt ? (
                <div className="viewer-info-actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setRenameOpen(true); setRenameValue(current.name); }}>
                    <Pencil size={15} /> Rename
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger-ghost btn-sm"
                    onClick={() => setTrashConfirm(true)}
                    disabled={busy}
                  >
                    <Trash2 size={15} /> Move to trash
                  </button>
                </div>
              ) : (
                <div className="viewer-info-actions">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void restore()} disabled={busy}>
                    <RotateCcw size={15} /> Restore
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger-ghost btn-sm"
                    onClick={() => onRequestDelete(current)}
                    disabled={busy}
                  >
                    <Trash2 size={15} /> Delete forever
                  </button>
                </div>
              )}
              <p className="info-footnote">
                {isLocal
                  ? 'This original lives in Nimbus\u2019s local storage. Previews also live on this device.'
                  : 'Originals stay in your cloud. Previews and offline copies live in Nimbus\u2019s local cache.'}
              </p>
            </div>
          </aside>
        ) : null}
      </div>

      {prev ? (
        <button type="button" className="viewer-nav is-prev" onClick={() => navigateTo(prev)} aria-label="Previous item">
          <ChevronLeft size={26} />
        </button>
      ) : null}
      {next ? (
        <button type="button" className="viewer-nav is-next" onClick={() => navigateTo(next)} aria-label="Next item">
          <ChevronRight size={26} />
        </button>
      ) : null}
      {items.length > 1 && index >= 0 ? (
        <div className="viewer-counter">
          {index + 1} / {items.length}
        </div>
      ) : null}

      {shareOpen ? (
        <ShareDialog item={current} onClose={() => setShareOpen(false)} onNotify={onNotify} />
      ) : null}

      {renameOpen ? (
        <Modal
          title="Rename file"
          onClose={() => setRenameOpen(false)}
          size="sm"
          footer={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setRenameOpen(false)} disabled={renaming}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void rename()} disabled={renaming || !renameValue.trim()}>
                {renaming ? <Spinner size={16} /> : null}
                Save name
              </button>
            </>
          }
        >
          <Field label="File name" htmlFor="viewer-rename">
            <input
              id="viewer-rename"
              className="input"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              maxLength={240}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === 'Enter') void rename();
              }}
            />
          </Field>
          <p className="form-note">Changing the name does not move or re-upload the original file.</p>
        </Modal>
      ) : null}

      <ConfirmDialog
        open={trashConfirm}
        title="Move to trash?"
        description={
          <span>
            <strong>{current.name}</strong> can be restored from Trash for 30 days. After that it is
            permanently removed from {providerLabel(current.provider)}.
          </span>
        }
        confirmLabel="Move to trash"
        tone="danger"
        busy={busy}
        onCancel={() => setTrashConfirm(false)}
        onConfirm={() => void trash()}
      />
    </div>
  );
}
