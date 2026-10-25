import { useEffect, useMemo, useState } from 'react';
import type { FolderDTO, FolderPathSegment, ItemDTO } from '../../../shared/types';
import {
  ChevronRight,
  Folder,
  FolderPlus,
  Pencil,
  Search,
  Trash2,
} from 'lucide-react';
import { formatBytes } from '../format';
import { Field, Modal, Spinner } from './ui';

/** A folder tile in the Files grid. */
export function FolderCard({
  folder,
  onOpen,
  onRename,
  onDelete,
}: {
  folder: FolderDTO;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const meta = [
    `${folder.itemCount.toLocaleString()} ${folder.itemCount === 1 ? 'file' : 'files'}`,
    folder.folderCount > 0
      ? `${folder.folderCount.toLocaleString()} ${folder.folderCount === 1 ? 'folder' : 'folders'}`
      : null,
    folder.size > 0 ? formatBytes(folder.size) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="folder-card">
      <button type="button" className="folder-card-open" onClick={onOpen}>
        <span className="folder-card-icon" aria-hidden="true">
          <Folder size={23} />
        </span>
        <span className="folder-card-copy">
          <span className="folder-card-name" title={folder.name}>
            {folder.name}
          </span>
          <span className="folder-card-meta">{meta}</span>
        </span>
      </button>
      <div className="folder-card-actions">
        <button type="button" className="folder-card-action" onClick={onRename} aria-label={`Rename ${folder.name}`} title="Rename folder">
          <Pencil size={14} />
        </button>
        <button type="button" className="folder-card-action is-danger" onClick={onDelete} aria-label={`Delete ${folder.name}`} title="Delete folder">
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

/** Folder path navigation shown inside a folder. */
export function FolderBreadcrumbs({
  path,
  onNavigate,
}: {
  path: FolderPathSegment[];
  onNavigate: (id: string | null) => void;
}) {
  if (path.length === 0) return null;
  return (
    <nav className="folder-breadcrumb" aria-label="Folder path">
      <button type="button" className="folder-crumb" onClick={() => onNavigate(null)}>
        <Folder size={14} aria-hidden="true" />
        Files
      </button>
      {path.map((segment, index) => (
        <span className="folder-crumb-wrap" key={segment.id ?? index}>
          <ChevronRight size={14} className="folder-crumb-sep" aria-hidden="true" />
          <button
            type="button"
            className={`folder-crumb${index === path.length - 1 ? ' is-current' : ''}`}
            onClick={() => onNavigate(segment.id)}
            aria-current={index === path.length - 1 ? 'page' : undefined}
          >
            {segment.name}
          </button>
        </span>
      ))}
    </nav>
  );
}

/** Create/rename dialog. The parent owns the request so errors stay in context. */
export function FolderNameDialog({
  open,
  mode,
  initialName = '',
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  mode: 'create' | 'rename';
  initialName?: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initialName);

  useEffect(() => {
    if (open) setName(initialName);
  }, [open, initialName]);

  if (!open) return null;

  const submit = () => {
    const value = name.trim();
    if (!value || busy) return;
    onSubmit(value);
  };

  return (
    <Modal
      title={mode === 'create' ? 'New folder' : 'Rename folder'}
      subtitle={mode === 'create' ? 'Folders keep your files organised in the Files section.' : undefined}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !name.trim()}>
            {busy ? <Spinner size={16} /> : null}
            {mode === 'create' ? 'Create folder' : 'Save name'}
          </button>
        </>
      }
    >
      <Field label="Folder name" error={error}>
        <input
          className="input"
          value={name}
          autoFocus
          maxLength={120}
          placeholder="e.g. Invoices"
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
        />
      </Field>
    </Modal>
  );
}

/** Move-to-folder picker used by selection and the viewer. */
export function MoveDialog({
  open,
  items,
  folders,
  loading,
  busy,
  error,
  currentFolderId,
  mixedLocations,
  onClose,
  onSubmit,
}: {
  open: boolean;
  items: ItemDTO[];
  folders: FolderDTO[];
  loading: boolean;
  busy: boolean;
  error: string | null;
  currentFolderId: string | null;
  mixedLocations: boolean;
  onClose: () => void;
  onSubmit: (folderId: string | null) => void;
}) {
  const [target, setTarget] = useState<string | null>(currentFolderId);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (open) {
      setTarget(mixedLocations ? null : currentFolderId);
      setFilter('');
    }
  }, [open, currentFolderId, mixedLocations]);

  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return folders;
    return folders.filter((folder) => (folder.path ?? folder.name).toLowerCase().includes(term));
  }, [folders, filter]);

  if (!open) return null;

  const unchanged = !mixedLocations && target === currentFolderId;
  const fileCount = items.length;

  const option = (folder: FolderDTO | null) => {
    const id = folder?.id ?? null;
    const selected = target === id;
    const current = !mixedLocations && id === currentFolderId;
    const label = folder?.path ?? folder?.name ?? 'Files (top level)';
    const depth = folder?.path ? folder.path.split(' / ').length - 1 : 0;
    return (
      <button
        key={folder?.id ?? 'root'}
        type="button"
        className={`folder-picker-option${selected ? ' is-selected' : ''}${current ? ' is-current' : ''}`}
        style={{ paddingLeft: `${12 + Math.min(depth, 12) * 16}px` }}
        onClick={() => setTarget(id)}
        aria-pressed={selected}
      >
        <span className="folder-picker-icon" aria-hidden="true">
          <Folder size={17} />
        </span>
        <span className="folder-picker-name">{label}</span>
        {current ? <span className="folder-picker-badge">Current</span> : null}
        <span className="folder-picker-check" aria-hidden="true">
          {selected ? '✓' : ''}
        </span>
      </button>
    );
  };

  return (
    <Modal
      title={fileCount === 1 ? 'Move file' : `Move ${fileCount} files`}
      subtitle="Choose where these files should live. Photos and videos always stay in their sections."
      onClose={onClose}
      size="md"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onSubmit(target)}
            disabled={busy || loading || unchanged}
          >
            {busy ? <Spinner size={16} /> : null}
            {unchanged ? 'Choose a folder' : 'Move here'}
          </button>
        </>
      }
    >
      <div className="folder-picker">
        {folders.length > 6 ? (
          <div className="folder-picker-search">
            <Search size={15} aria-hidden="true" />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Find a folder…"
              aria-label="Find a folder"
            />
          </div>
        ) : null}
        {loading ? (
          <div className="folder-picker-loading">
            <Spinner size={18} /> Loading folders…
          </div>
        ) : (
          <div className="folder-picker-list" role="listbox" aria-label="Destination folder">
            {option(null)}
            {visible.map((folder) => option(folder))}
          </div>
        )}
        {!loading && folders.length === 0 ? (
          <p className="folder-picker-empty">
            <FolderPlus size={15} aria-hidden="true" /> No folders yet. Files moved to the top level appear in Files.
          </p>
        ) : null}
        {error ? <p className="field-error">{error}</p> : null}
      </div>
    </Modal>
  );
}
