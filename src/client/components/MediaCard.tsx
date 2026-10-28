import { useState } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';
import type { ItemDTO } from '../../../shared/types';
import {
  AlertCircle,
  Check,
  Circle,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileVideo,
  HardDriveDownload,
  Heart,
  ImageOff,
  Play,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { fileExtension, formatBytes, formatDate, formatDuration } from '../format';
import { thumbUrl } from '../api';
import { Spinner } from './ui';

interface MediaCardProps {
  item: ItemDTO;
  selected: boolean;
  selectionMode: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onToggleFavorite: () => void;
  onRetry: () => void;
  onRestore?: () => void;
  onDeleteForever?: () => void;
}

function hueFor(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index++) {
    hash = (hash * 31 + name.charCodeAt(index)) % 360;
  }
  return hash;
}

function FileGlyph({ mime, name }: { mime: string; name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (mime.startsWith('audio/')) return <FileAudio size={30} />;
  if (mime.startsWith('video/')) return <FileVideo size={30} />;
  if (mime.includes('zip') || mime.includes('tar') || mime.includes('compressed') || ['zip', 'rar', '7z', 'gz', 'tar'].includes(ext)) {
    return <FileArchive size={30} />;
  }
  if (mime.includes('sheet') || mime === 'text/csv' || ['xls', 'xlsx', 'csv'].includes(ext)) {
    return <FileSpreadsheet size={30} />;
  }
  if (mime.includes('json') || mime.includes('javascript') || mime.includes('xml') || ['js', 'ts', 'html', 'css', 'py', 'go', 'rs', 'sql'].includes(ext)) {
    return <FileCode size={30} />;
  }
  if (mime.startsWith('text/') || ['txt', 'md', 'pdf', 'doc', 'docx'].includes(ext)) {
    return <FileText size={30} />;
  }
  return <File size={30} />;
}

export function MediaCard({
  item,
  selected,
  selectionMode,
  onOpen,
  onToggleSelect,
  onToggleFavorite,
  onRetry,
  onRestore,
  onDeleteForever,
}: MediaCardProps) {
  const [loaded, setLoaded] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const isPhoto = item.kind === 'photo';
  const isVideo = item.kind === 'video';
  const isFile = item.kind === 'file';
  const saving = item.status === 'queued' || item.status === 'uploading';
  const failed = item.status === 'error';
  const showThumb = item.hasThumb && !failed && !imageFailed && (isPhoto || isVideo);
  const ext = fileExtension(item.name);
  const hue = hueFor(item.name);

  const handleClick = () => {
    if (selectionMode) onToggleSelect();
    else onOpen();
  };

  const stop = (event: MouseEvent) => event.stopPropagation();

  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleClick();
    }
  };

  const tileStyle = isFile
    ? ({ '--file-hue': hue } as CSSProperties)
    : undefined;

  return (
    <div
      className={`media-card${selected ? ' is-selected' : ''}${selectionMode ? ' selection-mode' : ''}${isFile ? ' is-file' : ''}`}
      role="button"
      tabIndex={0}
      data-item-id={item.id}
      onClick={handleClick}
      onKeyDown={handleKey}
      aria-label={`${item.name}, ${formatBytes(item.size)}`}
      aria-pressed={selectionMode ? selected : undefined}
      title={item.name}
      style={tileStyle}
    >
      {isFile ? (
        <div className="file-tile">
          <span className="file-glow" aria-hidden="true" />
          <span className="file-glyph">
            <FileGlyph mime={item.mime} name={item.name} />
          </span>
          <span className="file-ext">{ext || 'FILE'}</span>
        </div>
      ) : showThumb ? (
        <>
          {!loaded ? <span className="tile-skeleton" aria-hidden="true" /> : null}
          <img
            className={`tile-image${loaded ? ' is-loaded' : ''}`}
            src={`${thumbUrl(item.id)}?v=${item.updatedAt}`}
            alt=""
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            draggable={false}
            onLoad={() => setLoaded(true)}
            onError={() => setImageFailed(true)}
          />
        </>
      ) : (
        <div className={`tile-fallback${isVideo ? ' is-video' : ''}`}>
          {isVideo ? <Play size={30} /> : <ImageOff size={30} />}
          <span>{isVideo ? 'Video' : 'Photo'}</span>
        </div>
      )}

      <div className="media-shade" aria-hidden="true" />
      <div className="media-caption">
        <span className="media-caption-name">{item.name}</span>
        <span className="media-caption-meta">
          {formatDate(item.takenAt ?? item.createdAt)}
          {item.kind === 'file' ? ` · ${formatBytes(item.size)}` : ''}
        </span>
      </div>

      {isVideo && item.duration ? (
        <span className="badge badge-duration">
          <Play size={10} fill="currentColor" aria-hidden="true" />
          {formatDuration(item.duration)}
        </span>
      ) : null}

      {item.pinned ? (
        <span className="badge badge-offline" title="Available offline">
          <HardDriveDownload size={12} aria-hidden="true" />
          <span className="badge-offline-label">Offline</span>
        </span>
      ) : null}

      {selectionMode ? (
        <button
          type="button"
          className={`select-check${selected ? ' is-on' : ''}`}
          onClick={(event) => {
            stop(event);
            onToggleSelect();
          }}
          aria-label={selected ? `Deselect ${item.name}` : `Select ${item.name}`}
          aria-pressed={selected}
        >
          {selected ? <Check size={15} strokeWidth={3} /> : <Circle size={16} />}
        </button>
      ) : null}

      <div className="card-actions">
        {item.trashedAt ? (
          <>
            {onRestore ? (
              <button
                type="button"
                className="card-action"
                onClick={(event) => {
                  stop(event);
                  onRestore();
                }}
                aria-label={`Restore ${item.name}`}
                title="Restore"
              >
                <RotateCcw size={16} />
              </button>
            ) : null}
            {onDeleteForever ? (
              <button
                type="button"
                className="card-action card-action-danger"
                onClick={(event) => {
                  stop(event);
                  onDeleteForever();
                }}
                aria-label={`Delete ${item.name} forever`}
                title="Delete forever"
              >
                <Trash2 size={16} />
              </button>
            ) : null}
          </>
        ) : (
          <button
            type="button"
            className={`card-action${item.favorite ? ' is-favorite' : ''}`}
            onClick={(event) => {
              stop(event);
              onToggleFavorite();
            }}
            aria-label={item.favorite ? `Remove ${item.name} from favorites` : `Add ${item.name} to favorites`}
            title={item.favorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            <Heart size={16} fill={item.favorite ? 'currentColor' : 'none'} />
          </button>
        )}
        {!selectionMode && !item.trashedAt ? (
          <button
            type="button"
            className="card-action card-action-select"
            onClick={(event) => {
              stop(event);
              onToggleSelect();
            }}
            aria-label={`Select ${item.name}`}
            title="Select"
          >
            <Circle size={16} />
          </button>
        ) : null}
      </div>

      {item.favorite && !item.trashedAt && !selectionMode ? (
        <span className="favorite-flag" title="Favorite" aria-hidden="true">
          <Heart size={12} fill="currentColor" />
        </span>
      ) : null}

      {saving ? (
        <div className="tile-status">
          <Spinner size={20} />
          <span>{item.status === 'queued' ? 'Waiting to save…' : 'Saving to cloud…'}</span>
        </div>
      ) : null}

      {failed ? (
        <div className="tile-status tile-status-error">
          <AlertCircle size={19} />
          <span className="tile-error-text">{item.error || 'This upload failed.'}</span>
          <button
            type="button"
            className="tile-retry"
            onClick={(event) => {
              stop(event);
              onRetry();
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {item.trashedAt && item.status === 'ready' ? (
        <span className="badge badge-trash">In trash</span>
      ) : null}
    </div>
  );
}
