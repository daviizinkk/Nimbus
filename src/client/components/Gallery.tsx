import { useEffect, useMemo, useRef } from 'react';
import type { FolderDTO, FolderPathSegment, ItemDTO, SortMode } from '../../../shared/types';
import type { Section } from '../hooks';
import {
  AlertCircle,
  ArrowUpDown,
  CloudUpload,
  DownloadCloud,
  Film,
  FolderInput,
  FolderPlus,
  Heart,
  Image,
  Images,
  RotateCcw,
  SearchX,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { MediaCard } from './MediaCard';
import { FolderBreadcrumbs, FolderCard } from './Folders';
import { Spinner } from './ui';
import { DATE_LOCALE, titleForSection } from '../format';

const SORT_LABELS: Array<{ value: SortMode; label: string }> = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'name', label: 'Name (A–Z)' },
  { value: 'largest', label: 'Largest first' },
];

interface GalleryProps {
  section: Section;
  items: ItemDTO[];
  total: number;
  query: string;
  sort: SortMode;
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: string | null;
  selection: Set<string>;
  selectionMode: boolean;
  selectionBusy: boolean;
  onSortChange: (sort: SortMode) => void;
  onReload: () => void;
  onOpenItem: (id: string) => void;
  onToggleFavorite: (item: ItemDTO) => void;
  onRetry: (item: ItemDTO) => void;
  onRestore: (item: ItemDTO) => void;
  onDeleteForever: (item: ItemDTO) => void;
  onToggleSelect: (id: string) => void;
  onClearSelection: () => void;
  onSelectAll: () => void;
  onBatch: (action: 'favorite' | 'unfavorite' | 'trash' | 'restore' | 'delete') => void;
  onMoveSelection: () => void;
  onEmptyTrash: () => void;
  onUpload: () => void;
  onClearSearch: () => void;
  onLoadMore: () => void;
  folders: FolderDTO[];
  folderPath: FolderPathSegment[];
  folderId: string | null;
  foldersLoading: boolean;
  onOpenFolder: (folder: FolderDTO) => void;
  onCreateFolder: () => void;
  onRenameFolder: (folder: FolderDTO) => void;
  onDeleteFolder: (folder: FolderDTO) => void;
  onNavigateFolder: (id: string | null) => void;
}

function SectionIcon({ section }: { section: Section }) {
  if (section === 'photos') return <Image size={20} />;
  if (section === 'videos') return <Film size={20} />;
  if (section === 'favorites') return <Heart size={20} />;
  if (section === 'trash') return <Trash2 size={20} />;
  if (section === 'files') return <DownloadCloud size={20} />;
  return <Images size={20} />;
}

function EmptyState({
  section,
  query,
  inFolder,
  onUpload,
  onCreateFolder,
  onClearSearch,
}: {
  section: Section;
  query: string;
  inFolder: boolean;
  onUpload: () => void;
  onCreateFolder: () => void;
  onClearSearch: () => void;
}) {
  if (query) {
    return (
      <div className="empty-state">
        <span className="empty-icon">
          <SearchX size={30} />
        </span>
        <h2>No matches for “{query}”</h2>
        <p>Try a different file name, or clear the search to see everything in this section.</p>
        <button type="button" className="btn btn-ghost" onClick={onClearSearch}>
          Clear search
        </button>
      </div>
    );
  }

  if (inFolder && section === 'files') {
    return (
      <div className="empty-state">
        <span className="empty-icon">
          <DownloadCloud size={30} />
        </span>
        <h2>This folder is empty</h2>
        <p>Drop files here, upload them below, or add a subfolder to keep things tidy.</p>
        <div className="empty-actions">
          <button type="button" className="btn btn-primary" onClick={onUpload}>
            <UploadCloud size={18} />
            Upload files
          </button>
          <button type="button" className="btn btn-ghost" onClick={onCreateFolder}>
            <FolderPlus size={18} />
            New folder
          </button>
        </div>
      </div>
    );
  }

  if (section === 'trash') {
    return (
      <div className="empty-state">
        <span className="empty-icon">
          <Trash2 size={30} />
        </span>
        <h2>Trash is empty</h2>
        <p>Deleted items stay here for 30 days before they are permanently removed.</p>
      </div>
    );
  }

  if (section === 'favorites') {
    return (
      <div className="empty-state">
        <span className="empty-icon">
          <Heart size={30} />
        </span>
        <h2>No favorites yet</h2>
        <p>Tap the heart on a photo, video, or file to keep the things you love close at hand.</p>
      </div>
    );
  }

  if (section === 'photos' || section === 'videos' || section === 'files') {
    const label = section === 'photos' ? 'photos' : section === 'videos' ? 'videos' : 'files';
    const Icon = section === 'photos' ? Image : section === 'videos' ? Film : DownloadCloud;
    return (
      <div className="empty-state">
        <span className="empty-icon">
          <Icon size={30} />
        </span>
        <h2>No {label} yet</h2>
        <p>Anything you upload appears here in beautiful, full-resolution quality.</p>
        <div className="empty-actions">
          <button type="button" className="btn btn-primary" onClick={onUpload}>
            <UploadCloud size={18} />
            Upload {label}
          </button>
          {section === 'files' ? (
            <button type="button" className="btn btn-ghost" onClick={onCreateFolder}>
              <FolderPlus size={18} />
              New folder
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="empty-state empty-state-hero">
      <span className="empty-icon empty-icon-hero">
        <CloudUpload size={34} />
      </span>
      <h2>Your private cloud starts here</h2>
      <p>
        Upload photos, videos and any other file. Nimbus stores the originals in your own cloud and
        keeps a fast, private copy close by.
      </p>
      <button type="button" className="btn btn-primary btn-lg" onClick={onUpload}>
        <UploadCloud size={19} />
        Add your first files
      </button>
      <span className="empty-note">or drop files anywhere on this window</span>
    </div>
  );
}

export function Gallery({
  section,
  items,
  total,
  query,
  sort,
  loading,
  loadingMore,
  hasMore,
  error,
  selection,
  selectionMode,
  selectionBusy,
  onSortChange,
  onReload,
  onOpenItem,
  onToggleFavorite,
  onRetry,
  onRestore,
  onDeleteForever,
  onToggleSelect,
  onClearSelection,
  onSelectAll,
  onBatch,
  onMoveSelection,
  onEmptyTrash,
  onUpload,
  onClearSearch,
  onLoadMore,
  folders,
  folderPath,
  folderId,
  foldersLoading,
  onOpenFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onNavigateFolder,
}: GalleryProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const folderView = section === 'files' && !query;
  const currentFolderName = folderPath[folderPath.length - 1]?.name ?? null;
  const hasMovableSelection = items.some((item) => selection.has(item.id) && item.kind === 'file');

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { rootMargin: '700px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore, items.length]);

  const groups = useMemo(() => {
    const shouldGroup = sort === 'newest' || sort === 'oldest' || section === 'trash';
    if (!shouldGroup) return [{ label: null as string | null, items }];
    const result: Array<{ label: string | null; items: ItemDTO[] }> = [];
    for (const item of items) {
      const date = new Date(item.trashedAt ?? item.takenAt ?? item.createdAt);
      const label = date.toLocaleDateString(DATE_LOCALE, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
      });
      const last = result[result.length - 1];
      if (last && last.label === label) last.items.push(item);
      else result.push({ label, items: [item] });
    }
    return result;
  }, [items, section, sort]);

  const selectionCount = selection.size;
  const heading = query
    ? 'Search results'
    : folderView && currentFolderName
      ? currentFolderName
      : titleForSection(section);
  const subtitle = (() => {
    if (query) {
      return `${total.toLocaleString()} ${total === 1 ? 'item' : 'items'} matching “${query}”`;
    }
    if (section === 'trash') {
      return total > 0
        ? `${total.toLocaleString()} ${total === 1 ? 'item' : 'items'} · permanently deleted after 30 days`
        : 'Items are permanently deleted after 30 days';
    }
    if (section === 'all') {
      return total > 0 ? `${total.toLocaleString()} ${total === 1 ? 'item' : 'items'} in your library` : 'Your photos, videos and files';
    }
    return total > 0 ? `${total.toLocaleString()} ${total === 1 ? 'item' : 'items'}` : 'Nothing here yet';
  })();

  const showInitialLoading = loading && items.length === 0;
  const showFolders = folderView && (folders.length > 0 || (foldersLoading && items.length === 0));
  const showEmpty =
    !loading && !error && items.length === 0 && !(folderView && folders.length > 0);

  return (
    <div className="gallery" aria-busy={loading || loadingMore}>
      <FolderBreadcrumbs path={folderPath} onNavigate={onNavigateFolder} />

      <div className="gallery-head">
        <div className="gallery-heading">
          <span className={`gallery-heading-icon section-${section}`}>
            <SectionIcon section={section} />
          </span>
          <div>
            <h1>{heading}</h1>
            <p>{subtitle}</p>
          </div>
        </div>
        <div className="gallery-tools">
          {folderView ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onCreateFolder}>
              <FolderPlus size={16} />
              New folder
            </button>
          ) : null}
          {section === 'trash' && total > 0 ? (
            <button type="button" className="btn btn-danger-ghost btn-sm" onClick={onEmptyTrash}>
              <Trash2 size={16} />
              Empty trash
            </button>
          ) : null}
          <label className="sort-control">
            <ArrowUpDown size={15} aria-hidden="true" />
            <span className="sr-only">Sort by</span>
            <select value={sort} onChange={(event) => onSortChange(event.target.value as SortMode)}>
              {SORT_LABELS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {selectionCount > 0 ? (
        <div className="selection-bar" role="toolbar" aria-label="Selected items">
          <span className="selection-count">
            <span className="selection-checkmark">✓</span>
            {selectionCount.toLocaleString()} selected
          </span>
          <span className="selection-divider" aria-hidden="true" />
          <button type="button" className="selection-action" onClick={onSelectAll}>
            Select all
          </button>
          {section === 'trash' ? (
            <>
              <button type="button" className="selection-action" onClick={() => onBatch('restore')} disabled={selectionBusy}>
                <RotateCcw size={15} />
                Restore
              </button>
              <button
                type="button"
                className="selection-action is-danger"
                onClick={() => onBatch('delete')}
                disabled={selectionBusy}
              >
                <Trash2 size={15} />
                Delete forever
              </button>
            </>
          ) : (
            <>
              <button type="button" className="selection-action" onClick={() => onBatch('favorite')} disabled={selectionBusy}>
                <Heart size={15} />
                Favorite
              </button>
              <button type="button" className="selection-action" onClick={() => onBatch('unfavorite')} disabled={selectionBusy}>
                <Heart size={15} />
                Unfavorite
              </button>
              {hasMovableSelection ? (
                <button type="button" className="selection-action" onClick={onMoveSelection} disabled={selectionBusy}>
                  <FolderInput size={15} />
                  Move
                </button>
              ) : null}
              <button type="button" className="selection-action is-danger" onClick={() => onBatch('trash')} disabled={selectionBusy}>
                <Trash2 size={15} />
                Move to trash
              </button>
            </>
          )}
          <span className="selection-spacer" />
          <button type="button" className="selection-action selection-cancel" onClick={onClearSelection} disabled={selectionBusy}>
            Cancel
          </button>
        </div>
      ) : null}

      {showFolders ? (
        <div className="folder-grid" aria-label="Folders">
          {folders.map((folder) => (
            <FolderCard
              key={folder.id}
              folder={folder}
              onOpen={() => onOpenFolder(folder)}
              onRename={() => onRenameFolder(folder)}
              onDelete={() => onDeleteFolder(folder)}
            />
          ))}
          {foldersLoading
            ? Array.from({ length: folders.length > 0 ? 2 : 4 }).map((_, index) => (
                <div className="folder-card folder-card-skeleton" key={`folder-skeleton-${index}`} aria-hidden="true">
                  <span className="shimmer" />
                </div>
              ))
            : null}
        </div>
      ) : null}

      {showInitialLoading ? (
        <div className="media-grid" aria-label="Loading library">
          {Array.from({ length: 18 }).map((_, index) => (
            <div className="tile-skeleton-card" key={index}>
              <div className="shimmer" />
            </div>
          ))}
        </div>
      ) : error && items.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon empty-icon-error">
            <AlertCircle size={30} />
          </span>
          <h2>Could not load your library</h2>
          <p>{error}</p>
          <button type="button" className="btn btn-primary" onClick={onReload}>
            Try again
          </button>
        </div>
      ) : showEmpty ? (
        <EmptyState
          section={section}
          query={query}
          inFolder={folderId !== null}
          onUpload={onUpload}
          onCreateFolder={onCreateFolder}
          onClearSearch={onClearSearch}
        />
      ) : (
        <div className="gallery-groups">
          {groups.map((group, groupIndex) => (
            <section className="date-group" key={`${group.label ?? 'all'}-${groupIndex}`}>
              {group.label ? <h2 className="date-heading">{group.label}</h2> : null}
              <div className="media-grid">
                {group.items.map((item) => (
                  <MediaCard
                    key={item.id}
                    item={item}
                    selected={selection.has(item.id)}
                    selectionMode={selectionMode}
                    onOpen={() => onOpenItem(item.id)}
                    onToggleSelect={() => onToggleSelect(item.id)}
                    onToggleFavorite={() => onToggleFavorite(item)}
                    onRetry={() => onRetry(item)}
                    onRestore={section === 'trash' ? () => onRestore(item) : undefined}
                    onDeleteForever={section === 'trash' ? () => onDeleteForever(item) : undefined}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {error && items.length > 0 ? (
        <div className="inline-error">
          <AlertCircle size={16} />
          <span>{error}</span>
          <button type="button" className="link-button" onClick={onReload}>
            Retry
          </button>
        </div>
      ) : null}

      <div ref={sentinelRef} className="gallery-sentinel">
        {loadingMore ? (
          <span className="loading-more">
            <Spinner size={18} /> Loading more…
          </span>
        ) : hasMore ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onLoadMore}>
            Load more
          </button>
        ) : items.length > 40 ? (
          <span className="end-note">You have reached the end of this view.</span>
        ) : null}
      </div>
    </div>
  );
}
