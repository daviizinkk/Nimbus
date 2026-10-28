import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppSettingsView,
  AppStatus,
  FolderDTO,
  FolderPathSegment,
  ItemDTO,
  ItemQuery,
  SortMode,
  StorageStats,
} from '../../shared/types';
import { AlertCircle, CloudUpload, RefreshCw, UploadCloud } from 'lucide-react';
import { api, ApiError } from './api';
import { desktop } from './desktop';
import { titleForSection } from './format';
import {
  useBodyLock,
  useDebouncedValue,
  useDocumentTitle,
  useHashSection,
  useInterfaceStyle,
  useTheme,
} from './hooks';
import type { Section } from './hooks';
import { uploadManager, filesFromDataTransfer } from './uploadManager';
import { Login } from './components/Login';
import { Onboarding } from './components/Onboarding';
import { Sidebar, Topbar } from './components/Sidebar';
import { Gallery } from './components/Gallery';
import { Viewer } from './components/Viewer';
import { SettingsModal, type SettingsTab } from './components/SettingsModal';
import { UploadTray } from './components/UploadTray';
import { FolderNameDialog, MoveDialog } from './components/Folders';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { Toasts, useToasts } from './components/Toasts';
import { ConfirmDialog, Logo } from './components/ui';

const PAGE_SIZE = 60;
const PREFETCH_DELAY = 400;

interface ListContext {
  section: Section;
  q: string;
  sort: SortMode;
  folderId: string | null;
}

interface LibraryEntry {
  items: ItemDTO[];
  total: number;
  hasMore: boolean;
  scrollTop: number;
}

function listKeyOf(context: ListContext): string {
  return [context.section, context.q, context.sort, context.folderId ?? 'root'].join('\u0000');
}

function listQuery(
  context: ListContext,
  limit: number,
  offset: number,
): ItemQuery & { limit: number; offset: number } {
  const query: ItemQuery & { limit: number; offset: number } = {
    section: context.section,
    q: context.q,
    sort: context.sort,
    limit,
    offset,
  };
  if (context.section === 'files' && !context.q) {
    query.folder = context.folderId ?? 'root';
  }
  return query;
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Something went wrong.';
}

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files');
}

export default function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [section, navigate] = useHashSection();
  const [search, setSearch] = useState('');
  const query = useDebouncedValue(search.trim(), 260);
  const effectiveSection: Section = query ? 'all' : section;
  const [sort, setSort] = useState<SortMode>('newest');
  const [items, setItems] = useState<ItemDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderDTO[]>([]);
  const [folderPath, setFolderPath] = useState<FolderPathSegment[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  const [folderRevision, setFolderRevision] = useState(0);
  const [folderDialog, setFolderDialog] = useState<{ mode: 'create' | 'rename'; folder?: FolderDTO } | null>(null);
  const [folderDialogError, setFolderDialogError] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderDeleteRequest, setFolderDeleteRequest] = useState<FolderDTO | null>(null);
  const [folderDeleteBusy, setFolderDeleteBusy] = useState(false);
  const [moveRequest, setMoveRequest] = useState<ItemDTO[] | null>(null);
  const [moveTree, setMoveTree] = useState<FolderDTO[]>([]);
  const [moveTreeLoading, setMoveTreeLoading] = useState(false);
  const [moveBusy, setMoveBusy] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [activeProvider, setActiveProvider] = useState<'local' | 'github' | 'webdav'>('local');
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [mobileNav, setMobileNav] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [deleteRequest, setDeleteRequest] = useState<ItemDTO[] | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);
  const [emptyTrashBusy, setEmptyTrashBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [chordArmed, setChordArmed] = useState(false);
  const { theme, resolved, setTheme } = useTheme();
  const [uiStyle, setUiStyle] = useInterfaceStyle();
  const { toasts, notify, dismiss } = useToasts();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const itemsRef = useRef<ItemDTO[]>([]);
  const hasMoreRef = useRef(false);
  const loadingRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const listVersion = useRef(0);
  const cacheRef = useRef(new Map<string, LibraryEntry>());
  const folderCacheRef = useRef(new Map<string, { folders: FolderDTO[]; path: FolderPathSegment[] }>());
  const scrollMemory = useRef(new Map<string, number>());
  const currentKeyRef = useRef('');
  const viewedRef = useRef(false);
  const deletionStartedRef = useRef(false);
  const uploadSessionRef = useRef(false);
  const chordArmedRef = useRef(false);
  const chordTimerRef = useRef<number | null>(null);

  const authenticated = Boolean(status?.authenticated);
  const folderView = effectiveSection === 'files' && !query;
  const activeFolderId = folderView ? folderId : null;
  const listContext: ListContext = { section: effectiveSection, q: query, sort, folderId: activeFolderId };
  const listKey = listKeyOf(listContext);
  const ctxRef = useRef(listContext);
  ctxRef.current = listContext;
  currentKeyRef.current = listKey;
  const currentFolderName = folderPath[folderPath.length - 1]?.name ?? null;

  useBodyLock(mobileNav);
  useDocumentTitle(
    viewerId && items.find((item) => item.id === viewerId)
      ? items.find((item) => item.id === viewerId)!.name
      : status?.authenticated
        ? currentFolderName ?? titleForSection(effectiveSection)
        : status?.onboarded
          ? status.vaultName
          : 'Welcome',
  );

  const loadStatus = useCallback(async () => {
    setStatusError(null);
    setStatus(null);
    try {
      const next = await api.status();
      setStatus(next);
    } catch (caught) {
      setStatusError(messageOf(caught));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    if (!authenticated) {
      setItems([]);
      setTotal(0);
      setHasMore(false);
      itemsRef.current = [];
      hasMoreRef.current = false;
      setLoading(false);
      loadingRef.current = false;
      return;
    }

    const context = ctxRef.current;
    const key = listKeyOf(context);
    const version = ++listVersion.current;
    const controller = new AbortController();
    const cached = cacheRef.current.get(key);

    setLoadingMore(false);
    loadingMoreRef.current = false;
    setError(null);

    if (cached) {
      // Show the previous result for this tab immediately, then revalidate in
      // the background. Tabs feel instant and never flash an empty skeleton.
      setItems(cached.items);
      itemsRef.current = cached.items;
      setTotal(cached.total);
      setHasMore(cached.hasMore);
      hasMoreRef.current = cached.hasMore;
      setLoading(false);
      loadingRef.current = false;
      const scrollTop = scrollMemory.current.get(key) ?? cached.scrollTop;
      window.requestAnimationFrame(() => {
        const element = contentRef.current;
        if (element && currentKeyRef.current === key) element.scrollTop = scrollTop;
      });
    } else {
      setItems([]);
      itemsRef.current = [];
      setTotal(0);
      setHasMore(false);
      hasMoreRef.current = false;
      setLoading(true);
      loadingRef.current = true;
    }

    api
      .listItems(listQuery(context, PAGE_SIZE, 0), controller.signal)
      .then((result) => {
        const entry: LibraryEntry = {
          items: result.items,
          total: result.total,
          hasMore: result.hasMore,
          scrollTop: scrollMemory.current.get(key) ?? cached?.scrollTop ?? 0,
        };
        cacheRef.current.set(key, entry);
        if (version !== listVersion.current) return;
        setItems(entry.items);
        itemsRef.current = entry.items;
        setTotal(entry.total);
        setHasMore(entry.hasMore);
        hasMoreRef.current = entry.hasMore;
        setError(null);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || version !== listVersion.current) return;
        setError(messageOf(caught));
      })
      .finally(() => {
        if (controller.signal.aborted || version !== listVersion.current) return;
        setLoading(false);
        loadingRef.current = false;
      });

    return () => controller.abort();
  }, [authenticated, listKey]);

  // Keep a small view cache warm so switching sections is a paint, not a wait.
  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    const controller = new AbortController();
    const sections: Section[] = ['all', 'photos', 'videos', 'files', 'favorites', 'trash'];
    const timer = window.setTimeout(() => {
      void (async () => {
        for (const section of sections) {
          if (cancelled) return;
          const context: ListContext = { section, q: '', sort, folderId: null };
          const key = listKeyOf(context);
          if (key === currentKeyRef.current || cacheRef.current.has(key)) continue;
          try {
            const result = await api.listItems(listQuery(context, PAGE_SIZE, 0), controller.signal);
            if (cancelled) return;
            cacheRef.current.set(key, {
              items: result.items,
              total: result.total,
              hasMore: result.hasMore,
              scrollTop: 0,
            });
          } catch {
            if (controller.signal.aborted) return;
          }
        }
      })();
    }, PREFETCH_DELAY);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [authenticated, sort]);

  // Remember the scroll position of each tab and restore it when returning.
  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const onScroll = () => {
      const key = currentKeyRef.current;
      scrollMemory.current.set(key, element.scrollTop);
      const entry = cacheRef.current.get(key);
      if (entry) entry.scrollTop = element.scrollTop;
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [authenticated]);

  useEffect(() => {
    setSelection(new Set());
    setSelectionMode(false);
  }, [effectiveSection, query, folderId]);

  useEffect(() => {
    if (!authenticated || !folderView) {
      setFolders([]);
      setFolderPath([]);
      setFoldersLoading(false);
      return;
    }
    const key = folderId ?? 'root';
    const cached = folderCacheRef.current.get(key);
    if (cached) {
      setFolders(cached.folders);
      setFolderPath(cached.path);
      setFoldersLoading(false);
    } else {
      setFolders([]);
      setFoldersLoading(true);
    }
    const controller = new AbortController();
    api
      .listFolders(folderId, controller.signal)
      .then((result) => {
        folderCacheRef.current.set(key, { folders: result.folders, path: result.path });
        setFolders(result.folders);
        setFolderPath(result.path);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiError && caught.status === 404) {
          setFolderId(null);
          setFolderPath([]);
          setFolders([]);
          notify('That folder no longer exists.', 'info');
        } else {
          notify(messageOf(caught), 'error');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setFoldersLoading(false);
      });
    return () => controller.abort();
  }, [authenticated, folderView, folderId, folderRevision, notify]);

  const refresh = useCallback(async (): Promise<void> => {
    const context = ctxRef.current;
    const key = listKeyOf(context);
    const cached = cacheRef.current.get(key);
    const limit = Math.min(200, Math.max(PAGE_SIZE, cached?.items.length || itemsRef.current.length || PAGE_SIZE));
    const result = await api.listItems(listQuery(context, limit, 0));
    const entry: LibraryEntry = {
      items: result.items,
      total: result.total,
      hasMore: result.hasMore,
      scrollTop: scrollMemory.current.get(key) ?? cached?.scrollTop ?? 0,
    };
    cacheRef.current.set(key, entry);
    if (currentKeyRef.current !== key) return;
    setItems(entry.items);
    itemsRef.current = entry.items;
    setTotal(entry.total);
    setHasMore(entry.hasMore);
    hasMoreRef.current = entry.hasMore;
    setError(null);
  }, []);

  const loadMore = useCallback(async (): Promise<void> => {
    if (loadingRef.current || loadingMoreRef.current || !hasMoreRef.current) return;
    const version = listVersion.current;
    const context = ctxRef.current;
    const key = listKeyOf(context);
    const offset = itemsRef.current.length;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const result = await api.listItems(listQuery(context, PAGE_SIZE, offset));
      const cached = cacheRef.current.get(key);
      if (cached) {
        cached.items = [...cached.items, ...result.items];
        cached.total = result.total;
        cached.hasMore = result.hasMore;
      }
      if (version !== listVersion.current || currentKeyRef.current !== key) return;
      const merged = [...itemsRef.current, ...result.items];
      setItems(merged);
      itemsRef.current = merged;
      setTotal(result.total);
      setHasMore(result.hasMore);
      hasMoreRef.current = result.hasMore;
    } catch (caught) {
      notify(messageOf(caught), 'error');
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [notify]);

  const loadStats = useCallback(async (): Promise<void> => {
    try {
      const result = await api.stats();
      setStats(result.storage);
      setActiveProvider(result.activeProvider);
    } catch {
      // Stats are non-critical; keep the last known values.
    }
  }, []);

  useEffect(() => {
    if (authenticated) void loadStats();
  }, [authenticated, loadStats]);

  useEffect(() => {
    if (!authenticated) return;
    let timer: number | null = null;
    const trigger = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void refresh().catch(() => {});
        void loadStats();
      }, 500);
    };
    window.addEventListener('nimbus:library-changed', trigger);
    return () => {
      window.removeEventListener('nimbus:library-changed', trigger);
      if (timer) window.clearTimeout(timer);
    };
  }, [authenticated, loadStats, refresh]);

  useEffect(() => {
    const onExpired = () => {
      // Account deletion intentionally clears every session at the end. The
      // progress dialog keeps polling with its one-time token, so don't replace
      // the app with the login screen while that job is finishing.
      if (deletionStartedRef.current) return;
      setStatus((current) => (current ? { ...current, authenticated: false } : current));
      setViewerId(null);
      setSettingsOpen(false);
      setSelection(new Set());
      setSelectionMode(false);
      cacheRef.current.clear();
      folderCacheRef.current.clear();
      scrollMemory.current.clear();
      setFolderId(null);
      setFolders([]);
      setFolderPath([]);
      notify('Your session expired. Sign in again to continue.', 'error');
    };
    window.addEventListener('nimbus:auth-expired', onExpired);
    return () => window.removeEventListener('nimbus:auth-expired', onExpired);
  }, [notify]);

  const pending = useMemo(
    () => items.some((item) => item.status === 'queued' || item.status === 'uploading'),
    [items],
  );

  useEffect(() => {
    if (!authenticated || !pending) return;
    const timer = window.setInterval(() => {
      void refresh().catch(() => {});
    }, 3_500);
    return () => window.clearInterval(timer);
  }, [authenticated, pending, refresh]);

  // Native upload notifications. The desktop main process decides whether the
  // window is actually out of the way, so toasts stay in charge while Nimbus is
  // focused and Windows notifications take over in the tray.
  useEffect(() => {
    if (!desktop) return;
    const bridge = desktop;
    let settleTimer: number | null = null;
    const unsubscribe = uploadManager.subscribe(() => {
      const tasks = uploadManager.getSnapshot();
      const running = tasks.some(
        (task) =>
          task.phase === 'preparing' ||
          task.phase === 'uploading' ||
          task.phase === 'poster' ||
          task.phase === 'finishing' ||
          task.phase === 'processing',
      );
      if (running) {
        uploadSessionRef.current = true;
        if (settleTimer !== null) {
          window.clearTimeout(settleTimer);
          settleTimer = null;
        }
        return;
      }
      if (!uploadSessionRef.current) return;
      uploadSessionRef.current = false;
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        const finished = uploadManager
          .getSnapshot()
          .filter((task) => task.phase === 'done' || task.phase === 'error');
        if (finished.length === 0) return;
        const failed = finished.filter((task) => task.phase === 'error').length;
        void bridge
          .notifyUpload({
            count: finished.length,
            failed,
            names: finished
              .filter((task) => task.phase === 'done')
              .slice(0, 3)
              .map((task) => task.name),
          })
          .catch(() => {});
      }, 900);
    });
    return () => {
      unsubscribe();
      if (settleTimer !== null) window.clearTimeout(settleTimer);
    };
  }, []);

  // Commands from the tray menu (Upload files… / Settings…) re-enter the
  // renderer through this bridge once the window is visible again.
  useEffect(() => {
    if (!desktop) return;
    return desktop.onCommand((command) => {
      if (command === 'upload') {
        fileInputRef.current?.click();
      } else if (command === 'settings') {
        setSettingsTab('desktop');
        setSettingsOpen(true);
      }
    });
  }, []);

  useEffect(() => {
    const was = viewedRef.current;
    viewedRef.current = Boolean(viewerId);
    if (was && !viewerId) {
      void refresh().catch(() => {});
      void loadStats();
    }
  }, [loadStats, refresh, viewerId]);

  const selectedItems = useMemo(
    () => items.filter((item) => selection.has(item.id)),
    [items, selection],
  );
  const viewerItem = viewerId ? items.find((item) => item.id === viewerId) ?? null : null;

  // Only the desktop app has a Rich Presence bridge. The main process decides
  // whether file names may be shared, based on the privacy toggle in Settings.
  useEffect(() => {
    if (!desktop || !authenticated) return;
    const view = query
      ? 'Search results'
      : currentFolderName ?? titleForSection(effectiveSection);
    desktop.rpc.setActivity({ view, item: viewerItem?.name ?? null });
  }, [authenticated, currentFolderName, effectiveSection, query, viewerItem?.name]);

  const showSelect = items.length > 0;
  const moveCurrentFolderId =
    moveRequest && moveRequest.length > 0 && moveRequest.every((item) => item.folderId === moveRequest[0].folderId)
      ? moveRequest[0].folderId
      : null;
  const moveMixedLocations = Boolean(
    moveRequest && moveRequest.some((item) => item.folderId !== moveRequest[0].folderId),
  );

  const openFilePicker = useCallback(() => {
    setMobileNav(false);
    fileInputRef.current?.click();
  }, []);

  const handleFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      const added = uploadManager.addFiles(files, activeFolderId);
      if (added > 0) {
        const destination = activeFolderId && currentFolderName ? ` · files go to ${currentFolderName}` : '';
        notify(`${added} ${added === 1 ? 'file' : 'files'} added to the upload queue${destination}.`, 'info');
      }
    },
    [activeFolderId, currentFolderName, notify],
  );

  const dragEnabled = authenticated && !settingsOpen && !viewerId;

  useEffect(() => {
    if (!dragEnabled) {
      setDragActive(false);
      return;
    }
    let depth = 0;
    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setDragActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragActive(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragActive(false);
      const transfer = event.dataTransfer;
      if (!transfer) return;
      void filesFromDataTransfer(transfer)
        .then((files) => handleFiles(files))
        .catch((caught: unknown) => notify(messageOf(caught), 'error'));
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [dragEnabled, handleFiles, notify]);

  const openFolder = useCallback((folder: FolderDTO) => {
    setFolderId(folder.id);
    setFolderPath((current) => [...current, { id: folder.id, name: folder.name }]);
  }, []);

  const navigateFolder = useCallback((id: string | null) => {
    setFolderId(id);
    if (id === null) {
      setFolderPath([]);
      return;
    }
    setFolderPath((current) => {
      const index = current.findIndex((segment) => segment.id === id);
      return index >= 0 ? current.slice(0, index + 1) : current;
    });
  }, []);

  const openCreateFolder = useCallback(() => {
    setFolderDialogError(null);
    setFolderDialog({ mode: 'create' });
  }, []);

  const openRenameFolder = useCallback((folder: FolderDTO) => {
    setFolderDialogError(null);
    setFolderDialog({ mode: 'rename', folder });
  }, []);

  const submitFolder = async (name: string) => {
    if (!folderDialog || folderBusy) return;
    setFolderBusy(true);
    setFolderDialogError(null);
    try {
      if (folderDialog.mode === 'create') {
        await api.createFolder(name, folderId);
        notify(`Folder “${name}” created.`, 'success');
      } else if (folderDialog.folder) {
        await api.renameFolder(folderDialog.folder.id, name);
        notify(`Folder renamed to “${name}”.`, 'success');
      }
      setFolderDialog(null);
      folderCacheRef.current.clear();
      setFolderRevision((value) => value + 1);
    } catch (caught) {
      setFolderDialogError(messageOf(caught));
    } finally {
      setFolderBusy(false);
    }
  };

  const confirmDeleteFolder = async () => {
    if (!folderDeleteRequest || folderDeleteBusy) return;
    setFolderDeleteBusy(true);
    try {
      const result = await api.deleteFolder(folderDeleteRequest.id);
      const moved = result.trashedItems;
      notify(
        moved > 0
          ? `Folder deleted. ${moved} ${moved === 1 ? 'file was' : 'files were'} moved to Trash.`
          : 'Folder deleted.',
        'success',
      );
      setFolderDeleteRequest(null);
      folderCacheRef.current.clear();
      setFolderRevision((value) => value + 1);
      await Promise.allSettled([refresh(), loadStats()]);
    } catch (caught) {
      notify(messageOf(caught), 'error');
    } finally {
      setFolderDeleteBusy(false);
    }
  };

  const openMoveDialog = useCallback((targets: ItemDTO[]) => {
    const movable = targets.filter((item) => item.kind === 'file' && !item.trashedAt);
    if (movable.length === 0) {
      notify('Only files can be moved into folders.', 'info');
      return;
    }
    setMoveError(null);
    setMoveRequest(movable);
  }, [notify]);

  useEffect(() => {
    if (!moveRequest) {
      setMoveTree([]);
      return;
    }
    const controller = new AbortController();
    setMoveTreeLoading(true);
    setMoveError(null);
    api
      .listFolderTree(controller.signal)
      .then((result) => setMoveTree(result.folders))
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setMoveError(messageOf(caught));
        setMoveTree([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setMoveTreeLoading(false);
      });
    return () => controller.abort();
  }, [moveRequest]);

  const submitMove = async (target: string | null) => {
    if (!moveRequest || moveBusy) return;
    setMoveBusy(true);
    setMoveError(null);
    try {
      const movedIds = moveRequest.map((item) => item.id);
      const result = await api.batch(movedIds, 'move', target);
      notify(
        `${result.updated} ${result.updated === 1 ? 'file' : 'files'} moved${
          target ? ' to the selected folder' : ' to the top level'
        }.`,
        'success',
      );
      setMoveRequest(null);
      // The moved files may have left the current folder. Drop the selection
      // so the action bar cannot linger over an empty view.
      clearSelection();
      folderCacheRef.current.clear();
      setFolderRevision((value) => value + 1);
      await Promise.allSettled([refresh(), loadStats()]);
      setViewerId((current) =>
        current && movedIds.includes(current) && !itemsRef.current.some((item) => item.id === current)
          ? null
          : current,
      );
    } catch (caught) {
      setMoveError(messageOf(caught));
    } finally {
      setMoveBusy(false);
    }
  };

  const handleAccountDeleted = useCallback(() => {
    deletionStartedRef.current = false;
    cacheRef.current.clear();
    folderCacheRef.current.clear();
    scrollMemory.current.clear();
    setSettingsOpen(false);
    setViewerId(null);
    // A reload asks the server for a fresh status. The library was reset, so
    // this lands on the onboarding screen without stale in-memory data.
    window.location.reload();
  }, []);

  const openSettings = (tab: SettingsTab = 'general') => {
    setSettingsTab(tab);
    setSettingsOpen(true);
    setMobileNav(false);
  };

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // The local session state is cleared regardless.
    }
    setStatus((current) => (current ? { ...current, authenticated: false } : current));
    setSettingsOpen(false);
    setViewerId(null);
    setSelection(new Set());
    setSelectionMode(false);
    setItems([]);
    setSearch('');
    cacheRef.current.clear();
    folderCacheRef.current.clear();
    scrollMemory.current.clear();
    setFolderId(null);
    setFolders([]);
    setFolderPath([]);
    setFolderDialog(null);
    setFolderDeleteRequest(null);
    setMoveRequest(null);
  };

  const handleSettingsChanged = (view: AppSettingsView) => {
    setStatus((current) => (current ? { ...current, vaultName: view.vaultName } : current));
    setActiveProvider(view.storage.active);
    void refresh().catch(() => {});
    void loadStats();
  };

  const toggleSelect = (id: string) => {
    const next = new Set(selection);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelection(next);
    setSelectionMode(next.size > 0);
  };

  const selectAll = () => {
    setSelection(new Set(items.map((item) => item.id)));
    setSelectionMode(true);
  };

  const clearSelection = () => {
    setSelection(new Set());
    setSelectionMode(false);
  };

  const toggleSelectionMode = () => {
    if (selectionMode) clearSelection();
    else setSelectionMode(true);
  };

  const toggleFavorite = async (item: ItemDTO) => {
    try {
      const result = await api.updateItem(item.id, { favorite: !item.favorite });
      setItems((current) => {
        const next = current.map((entry) => (entry.id === result.item.id ? result.item : entry));
        itemsRef.current = next;
        return next;
      });
      if (effectiveSection === 'favorites' && !result.item.favorite) {
        setItems((current) => {
          const next = current.filter((entry) => entry.id !== item.id);
          itemsRef.current = next;
          return next;
        });
        setTotal((value) => Math.max(0, value - 1));
      }
      void loadStats();
    } catch (caught) {
      notify(messageOf(caught), 'error');
    }
  };

  const retryItem = async (item: ItemDTO) => {
    try {
      const result = await api.retryUpload(item.id);
      setItems((current) => current.map((entry) => (entry.id === result.item.id ? result.item : entry)));
      notify('Retrying the upload in the background.', 'info');
    } catch (caught) {
      notify(messageOf(caught), 'error');
    }
  };

  const restoreItem = async (item: ItemDTO) => {
    try {
      await api.restoreItem(item.id);
      setItems((current) => {
        const next = current.filter((entry) => entry.id !== item.id);
        itemsRef.current = next;
        return next;
      });
      setTotal((value) => Math.max(0, value - 1));
      notify('Restored to your library.', 'success');
      void loadStats();
    } catch (caught) {
      notify(messageOf(caught), 'error');
    }
  };

  const requestDelete = (itemsToDelete: ItemDTO[]) => {
    if (itemsToDelete.length === 0) return;
    setDeleteRequest(itemsToDelete);
  };

  const confirmDelete = async () => {
    if (!deleteRequest) return;
    setDeleteBusy(true);
    const ids = new Set<string>();
    let failed = 0;
    let firstError: string | null = null;
    for (const item of deleteRequest) {
      try {
        await api.deleteItem(item.id);
        ids.add(item.id);
      } catch (caught) {
        failed += 1;
        firstError = firstError ?? messageOf(caught);
      }
    }
    if (ids.size > 0) {
      setItems((current) => {
        const next = current.filter((entry) => !ids.has(entry.id));
        itemsRef.current = next;
        return next;
      });
      setTotal((value) => Math.max(0, value - ids.size));
      setViewerId((current) => (current && ids.has(current) ? null : current));
      clearSelection();
    }
    setDeleteBusy(false);
    setDeleteRequest(null);
    notify(
      failed > 0
        ? `Deleted ${ids.size} ${ids.size === 1 ? 'item' : 'items'}, ${failed} failed${firstError ? `: ${firstError}` : '.'}`
        : `Permanently deleted ${ids.size} ${ids.size === 1 ? 'item' : 'items'}.`,
      failed > 0 ? 'error' : 'success',
    );
    void loadStats();
    void refresh().catch(() => {});
  };

  const handleBatch = async (action: 'favorite' | 'unfavorite' | 'trash' | 'restore' | 'delete') => {
    if (selectedItems.length === 0 || selectionBusy) return;
    if (action === 'delete') {
      requestDelete(selectedItems);
      return;
    }
    setSelectionBusy(true);
    try {
      const result = await api.batch(
        selectedItems.map((item) => item.id),
        action,
      );
      const messages: Record<string, string> = {
        favorite: 'Added to favorites.',
        unfavorite: 'Removed from favorites.',
        trash: 'Moved to trash.',
        restore: 'Restored to your library.',
        delete: 'Deleted permanently.',
      };
      notify(`${result.updated} ${result.updated === 1 ? 'item' : 'items'} · ${messages[action]}`, 'success');
      clearSelection();
      await Promise.allSettled([refresh(), loadStats()]);
    } catch (caught) {
      notify(messageOf(caught), 'error');
    } finally {
      setSelectionBusy(false);
    }
  };

  const emptyTrash = async () => {
    setEmptyTrashBusy(true);
    try {
      const result = await api.emptyTrash();
      setItems([]);
      itemsRef.current = [];
      setTotal(0);
      setHasMore(false);
      hasMoreRef.current = false;
      setViewerId(null);
      notify(
        result.failed > 0
          ? `Deleted ${result.deleted} items; ${result.failed} could not be removed.`
          : `Trash emptied. ${result.deleted} ${result.deleted === 1 ? 'item' : 'items'} permanently deleted.`,
        result.failed > 0 ? 'error' : 'success',
      );
      void loadStats();
    } catch (caught) {
      notify(messageOf(caught), 'error');
    } finally {
      setEmptyTrashBusy(false);
      setEmptyTrashOpen(false);
    }
  };

  const selectionCount = selectedItems.length;

  useEffect(() => {
    const focusSearch = () => {
      const input = document.getElementById('nimbus-search') as HTMLInputElement | null;
      input?.focus();
      input?.select();
    };
    const disarmChord = () => {
      chordArmedRef.current = false;
      setChordArmed(false);
      if (chordTimerRef.current !== null) {
        window.clearTimeout(chordTimerRef.current);
        chordTimerRef.current = null;
      }
    };
    const armChord = () => {
      chordArmedRef.current = true;
      setChordArmed(true);
      if (chordTimerRef.current !== null) window.clearTimeout(chordTimerRef.current);
      chordTimerRef.current = window.setTimeout(() => {
        chordArmedRef.current = false;
        setChordArmed(false);
        chordTimerRef.current = null;
      }, 1_600);
    };

    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT' ||
            target.isContentEditable),
      );
      const modalOpen = Boolean(document.querySelector('.modal-backdrop'));
      const viewerOpen = Boolean(viewerId);
      const mod = event.metaKey || event.ctrlKey;
      if (!authenticated) return;

      if (mod && event.key.toLowerCase() === 'k') {
        if (viewerOpen) return;
        event.preventDefault();
        focusSearch();
        return;
      }

      if (mod && event.key === ',') {
        if (modalOpen) return;
        event.preventDefault();
        setSettingsTab('general');
        setSettingsOpen(true);
        return;
      }

      if (event.key === '?' && !typing) {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      if (modalOpen) return;

      if (mod && event.key.toLowerCase() === 'u' && !viewerOpen) {
        event.preventDefault();
        fileInputRef.current?.click();
        return;
      }

      if (event.key === '/' && !typing && !viewerOpen) {
        event.preventDefault();
        focusSearch();
        return;
      }

      if (mod && event.key.toLowerCase() === 'a' && !typing && !viewerOpen) {
        if (items.length === 0) return;
        event.preventDefault();
        selectAll();
        return;
      }

      if (event.key === 'Escape') {
        if (typing) {
          target?.blur();
          return;
        }
        if (viewerOpen) return; // The viewer owns Escape while it is open.
        if (chordArmedRef.current) {
          disarmChord();
          return;
        }
        if (selectionMode) {
          clearSelection();
          return;
        }
        if (search) {
          setSearch('');
          return;
        }
        return;
      }

      if (typing || viewerOpen) return;

      if (chordArmedRef.current) {
        const destinations: Record<string, Section> = {
          a: 'all',
          p: 'photos',
          v: 'videos',
          d: 'files',
          f: 'favorites',
          t: 'trash',
        };
        const destination = destinations[event.key.toLowerCase()];
        disarmChord();
        if (destination) {
          event.preventDefault();
          navigate(destination);
          setSearch('');
          setFolderId(null);
          setFolderPath([]);
        }
        return;
      }

      if (event.key.toLowerCase() === 'g' && !mod && !event.altKey) {
        event.preventDefault();
        armChord();
        return;
      }

      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedItems.length > 0) {
        event.preventDefault();
        if (section === 'trash') handleBatch('delete');
        else handleBatch('trash');
        return;
      }

      if (event.key.toLowerCase() === 'f' && !mod && !event.altKey) {
        if (selectedItems.length === 1) {
          event.preventDefault();
          void toggleFavorite(selectedItems[0]);
          return;
        }
        const focused = document.activeElement as HTMLElement | null;
        const card = focused?.closest<HTMLElement>('.media-card');
        const id = card?.dataset.itemId;
        const item = id ? items.find((entry) => entry.id === id) : null;
        if (item) {
          event.preventDefault();
          void toggleFavorite(item);
        }
        return;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    authenticated,
    handleBatch,
    items,
    navigate,
    search,
    section,
    selectedItems,
    selectionMode,
    toggleFavorite,
    viewerId,
  ]);

  useEffect(
    () => () => {
      if (chordTimerRef.current !== null) window.clearTimeout(chordTimerRef.current);
    },
    [],
  );

  if (!status) {
    if (statusError) {
      return (
        <div className="splash-screen">
          <div className="splash-card">
            <span className="splash-error-icon">
              <AlertCircle size={24} />
            </span>
            <h1>Nimbus is not reachable</h1>
            <p>{statusError}</p>
            <button type="button" className="btn btn-primary" onClick={() => void loadStatus()}>
              <RefreshCw size={17} /> Try again
            </button>
            <span className="splash-note">Make sure the Nimbus server is running, then reload this page.</span>
          </div>
        </div>
      );
    }
    return (
      <div className="splash-screen">
        <div className="splash-mark">
          <Logo size={46} wordmark={false} />
          <span className="splash-pulse" />
        </div>
        <p>Starting Nimbus…</p>
        <span className="splash-bar">
          <span />
        </span>
      </div>
    );
  }

  if (!status.onboarded) {
    return (
      <>
        <Onboarding onComplete={(next) => setStatus(next)} />
        <Toasts toasts={toasts} onDismiss={dismiss} />
      </>
    );
  }

  if (!status.authenticated) {
    return (
      <>
        <Login
          vaultName={status.vaultName}
          version={status.version}
          onSuccess={(next) => setStatus(next)}
        />
        <Toasts toasts={toasts} onDismiss={dismiss} />
      </>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar
        section={section}
        vaultName={status.vaultName}
        stats={stats}
        activeProvider={activeProvider}
        theme={theme}
        resolved={resolved}
        onThemeChange={setTheme}
        onNavigate={(next) => {
          navigate(next);
          setSearch('');
          setFolderId(null);
          setFolderPath([]);
          setMobileNav(false);
        }}
        onUpload={openFilePicker}
        onOpenSettings={() => openSettings('general')}
        onLogout={() => void logout()}
        mobileOpen={mobileNav}
        onCloseMobile={() => setMobileNav(false)}
      />

      <div className="app-main">
        <Topbar
          search={search}
          onSearchChange={setSearch}
          onMenu={() => setMobileNav(true)}
          onOpenSettings={() => openSettings('general')}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onUpload={openFilePicker}
          selectionMode={selectionMode}
          onToggleSelection={toggleSelectionMode}
          showSelect={showSelect}
        />

        <main className="content" ref={contentRef}>
          <Gallery
            section={effectiveSection}
            items={items}
            total={total}
            query={query}
            sort={sort}
            loading={loading}
            loadingMore={loadingMore}
            hasMore={hasMore}
            error={error}
            selection={selection}
            selectionMode={selectionMode}
            selectionBusy={selectionBusy}
            onSortChange={setSort}
            onReload={() => {
              void refresh().catch((caught: unknown) => notify(messageOf(caught), 'error'));
            }}
            onOpenItem={setViewerId}
            onToggleFavorite={(item) => void toggleFavorite(item)}
            onRetry={(item) => void retryItem(item)}
            onRestore={(item) => void restoreItem(item)}
            onDeleteForever={(item) => requestDelete([item])}
            onToggleSelect={toggleSelect}
            onClearSelection={clearSelection}
            onSelectAll={selectAll}
            onBatch={(action) => void handleBatch(action)}
            onMoveSelection={() => openMoveDialog(selectedItems)}
            onEmptyTrash={() => setEmptyTrashOpen(true)}
            onUpload={openFilePicker}
            onClearSearch={() => setSearch('')}
            onLoadMore={() => void loadMore()}
            folders={folders}
            folderPath={folderPath}
            folderId={activeFolderId}
            foldersLoading={foldersLoading}
            onOpenFolder={openFolder}
            onCreateFolder={openCreateFolder}
            onRenameFolder={openRenameFolder}
            onDeleteFolder={setFolderDeleteRequest}
            onNavigateFolder={navigateFolder}
          />
        </main>
      </div>

      <UploadTray onNotify={notify} />

      {viewerItem ? (
        <Viewer
          key={viewerItem.id}
          item={viewerItem}
          items={items}
          onClose={() => setViewerId(null)}
          onNavigate={setViewerId}
          onItemUpdated={(updated) => {
            setItems((current) => {
              const next = current.map((entry) => (entry.id === updated.id ? updated : entry));
              itemsRef.current = next;
              return next;
            });
          }}
          onRequestDelete={(item) => requestDelete([item])}
          onMove={(item) => openMoveDialog([item])}
          onNotify={notify}
        />
      ) : null}

      {settingsOpen ? (
        <SettingsModal
          vaultName={status.vaultName}
          activeProvider={activeProvider}
          stats={stats}
          theme={theme}
          uiStyle={uiStyle}
          initialTab={settingsTab}
          onThemeChange={setTheme}
          onUiStyleChange={setUiStyle}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onClose={() => setSettingsOpen(false)}
          onSettingsChanged={handleSettingsChanged}
          onCacheChanged={() => {
            void loadStats();
          }}
          onLogout={() => void logout()}
          onAccountDeleted={handleAccountDeleted}
          onDeletionStarted={() => {
            deletionStartedRef.current = true;
          }}
          notify={notify}
        />
      ) : null}

      <FolderNameDialog
        open={folderDialog !== null}
        mode={folderDialog?.mode ?? 'create'}
        initialName={folderDialog?.mode === 'rename' ? folderDialog.folder?.name ?? '' : ''}
        busy={folderBusy}
        error={folderDialogError}
        onClose={() => {
          if (folderBusy) return;
          setFolderDialog(null);
          setFolderDialogError(null);
        }}
        onSubmit={(name) => void submitFolder(name)}
      />

      <MoveDialog
        open={moveRequest !== null}
        items={moveRequest ?? []}
        folders={moveTree}
        loading={moveTreeLoading}
        busy={moveBusy}
        error={moveError}
        currentFolderId={moveCurrentFolderId}
        mixedLocations={moveMixedLocations}
        onClose={() => {
          if (moveBusy) return;
          setMoveRequest(null);
          setMoveError(null);
        }}
        onSubmit={(target) => void submitMove(target)}
      />

      <ConfirmDialog
        open={folderDeleteRequest !== null}
        title="Delete folder?"
        description={
          <span>
            <strong>{folderDeleteRequest?.name}</strong> and any subfolders will be deleted. Files inside will
            move to Trash, where they stay for 30 days before being permanently removed.
          </span>
        }
        confirmLabel="Delete folder"
        tone="danger"
        busy={folderDeleteBusy}
        onCancel={() => {
          if (!folderDeleteBusy) setFolderDeleteRequest(null);
        }}
        onConfirm={() => void confirmDeleteFolder()}
      />

      <ConfirmDialog
        open={deleteRequest !== null}
        title="Delete permanently?"
        description={
          deleteRequest && deleteRequest.length === 1 ? (
            <span>
              <strong>{deleteRequest[0].name}</strong> will be removed from{' '}
              {deleteRequest[0].provider === 'local'
                ? 'this device'
                : deleteRequest[0].provider === 'github'
                  ? 'GitHub'
                  : 'WebDAV'}{' '}
              and the Nimbus cache. This cannot be undone.
            </span>
          ) : (
            <span>
              {deleteRequest?.length ?? 0} items will be permanently removed from their cloud storage and the
              local cache. This cannot be undone.
            </span>
          )
        }
        confirmLabel={deleteRequest && deleteRequest.length === 1 ? 'Delete forever' : 'Delete all forever'}
        tone="danger"
        busy={deleteBusy}
        onCancel={() => setDeleteRequest(null)}
        onConfirm={() => void confirmDelete()}
      />

      <ConfirmDialog
        open={emptyTrashOpen}
        title="Empty trash?"
        description={
          <span>
            All {total.toLocaleString()} {total === 1 ? 'item' : 'items'} in Trash will be permanently deleted
            from their storage provider. This cannot be undone.
          </span>
        }
        confirmLabel="Empty trash"
        tone="danger"
        busy={emptyTrashBusy}
        onCancel={() => setEmptyTrashOpen(false)}
        onConfirm={() => void emptyTrash()}
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          handleFiles(files);
        }}
      />

      {dragActive ? (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-card">
            <span className="drop-icon">
              <CloudUpload size={38} />
            </span>
            <h2>Drop to add to your library</h2>
            <p>
              {activeFolderId && currentFolderName
                ? `Files will be added to ${currentFolderName}. Photos and videos still go to their sections.`
                : 'Photos, videos and any other files — folders work too.'}
            </p>
            <span className="drop-badge">
              <UploadCloud size={14} /> Originals go to your cloud
            </span>
          </div>
        </div>
      ) : null}

      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {chordArmed ? (
        <div className="chord-hud" role="status" aria-live="polite">
          <span className="chord-hud-label">Go to</span>
          <span><kbd>A</kbd> All</span>
          <span><kbd>P</kbd> Photos</span>
          <span><kbd>V</kbd> Videos</span>
          <span><kbd>D</kbd> Files</span>
          <span><kbd>F</kbd> Favorites</span>
          <span><kbd>T</kbd> Trash</span>
        </div>
      ) : null}

      <Toasts toasts={toasts} onDismiss={dismiss} />

      {selectionCount > 0 && !viewerItem ? (
        <span className="sr-only" aria-live="polite">
          {selectionCount} items selected
        </span>
      ) : null}
    </div>
  );
}
