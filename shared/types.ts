export type ProviderId = 'local' | 'github' | 'webdav';
export type ItemKind = 'photo' | 'video' | 'file';
export type ItemStatus = 'receiving' | 'queued' | 'uploading' | 'ready' | 'error';
export type SortMode = 'newest' | 'oldest' | 'name' | 'largest';

export interface ItemDTO {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: ItemKind;
  status: ItemStatus;
  error: string | null;
  provider: ProviderId;
  folderId: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  takenAt: number | null;
  createdAt: number;
  updatedAt: number;
  favorite: boolean;
  trashedAt: number | null;
  hasThumb: boolean;
  cached: boolean;
  pinned: boolean;
  cacheError: string | null;
}

export interface ItemListResponse {
  items: ItemDTO[];
  total: number;
  hasMore: boolean;
}

export interface FolderDTO {
  id: string;
  name: string;
  parentId: string | null;
  itemCount: number;
  folderCount: number;
  size: number;
  createdAt: number;
  updatedAt: number;
  /** Human-readable path for pickers, for example "Work / Invoices". */
  path?: string;
}

export interface FolderPathSegment {
  id: string | null;
  name: string;
}

export interface FolderListResponse {
  folders: FolderDTO[];
  path: FolderPathSegment[];
}

export interface FolderTreeResponse {
  folders: FolderDTO[];
}

export interface AccountDeletionStatus {
  phase: 'idle' | 'running' | 'finalizing' | 'done' | 'error';
  message: string;
  processed: number;
  total: number;
  failed: number;
  repositoryDeleted: boolean;
  error: string | null;
}

export interface DesktopDiscordConfig {
  enabled: boolean;
  applicationId: string;
  /** Shares the current file name. Off by default. */
  showActivity: boolean;
}

export type DesktopDiscordState = 'off' | 'connecting' | 'connected' | 'disconnected' | 'error';

export interface DesktopDiscordStatus {
  state: DesktopDiscordState;
  message: string;
  user: string | null;
}

export interface DesktopInfo {
  version: string;
  platform: string;
  electron: string;
  packaged: boolean;
  /** Local library directory (database, keys, originals and cache). */
  dataDir: string;
  /** Folder containing desktop and server logs. */
  logsDir: string;
  /** True when the installed Windows uninstaller is available. */
  canUninstall: boolean;
}

export interface DesktopActionResult {
  ok: boolean;
  error?: string;
  path?: string;
}

export interface DesktopActivity {
  view: string;
  item?: string | null;
}

export interface StorageStats {
  usedBytes: number;
  itemCount: number;
  photoCount: number;
  videoCount: number;
  fileCount: number;
  favorites: number;
  trashBytes: number;
  trashCount: number;
}

export interface CacheStats {
  encrypted: boolean;
  limitMB: number;
  autoCache: boolean;
  blobBytes: number;
  blobCount: number;
  previewBytes: number;
  pinnedBytes: number;
  pinnedCount: number;
}

export interface LocalStorageView {
  configured: true;
  path: string;
}

export interface GithubStorageView {
  configured: boolean;
  owner: string;
  repo: string;
  hasToken: boolean;
  tokenHint: string | null;
  releaseTag: string;
}

export interface WebdavStorageView {
  configured: boolean;
  url: string;
  username: string;
  folder: string;
  hasPassword: boolean;
}

export interface StorageView {
  active: ProviderId;
  local: LocalStorageView;
  github: GithubStorageView;
  webdav: WebdavStorageView;
}

export interface AppSettingsView {
  vaultName: string;
  version: string;
  storage: StorageView;
  cache: CacheStats;
}

export interface AppStatus {
  onboarded: boolean;
  authenticated: boolean;
  vaultName: string;
  version: string;
}

export interface SetupRequest {
  vaultName: string;
  password: string;
  storage?: {
    active: ProviderId;
    github?: {
      token: string;
      owner?: string;
      repo?: string;
      releaseTag?: string;
    };
    webdav?: {
      url: string;
      username?: string;
      password?: string;
      folder?: string;
    };
  };
}

export interface ItemQuery {
  section?: 'all' | 'photos' | 'videos' | 'files' | 'favorites' | 'trash';
  q?: string;
  sort?: SortMode;
  limit?: number;
  offset?: number;
  /** Files only: a folder ID, or "root" for unfiled files. Omit for everything. */
  folder?: string | null;
}

export interface UploadCompleteRequest {
  width?: number | null;
  height?: number | null;
  duration?: number | null;
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  warning?: string;
  details?: Record<string, string | number | boolean | null>;
}
