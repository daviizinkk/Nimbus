import type {
  AccountDeletionStatus,
  AppSettingsView,
  AppStatus,
  CacheStats,
  FolderDTO,
  FolderListResponse,
  FolderTreeResponse,
  ItemDTO,
  ItemListResponse,
  ItemQuery,
  ProviderId,
  ProviderTestResult,
  SetupRequest,
  ShareDTO,
  ShareExpiry,
  ShareListResponse,
  StorageStats,
  TelemetryView,
  UploadCompleteRequest,
} from '../../shared/types';

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  skipUnauthorizedEvent?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    'x-nimbus-client': '1',
    ...options.headers,
  };
  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body,
      credentials: 'same-origin',
      signal: options.signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiError('Could not reach the Nimbus server. Is it running?', 0, 'network');
  }

  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : await response.text().catch(() => '');

  if (!response.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: { message?: string } }).error.message || 'Request failed.')
        : `Request failed (${response.status}).`;
    const code =
      payload && typeof payload === 'object' && 'error' in payload
        ? String((payload as { error: { code?: string } }).error.code || 'error')
        : 'error';
    if (response.status === 401 && !options.skipUnauthorizedEvent && !path.endsWith('/login')) {
      window.dispatchEvent(new CustomEvent('nimbus:auth-expired'));
    }
    throw new ApiError(message, response.status, code);
  }

  return payload as T;
}

export interface StatsResponse {
  storage: StorageStats;
  cache: CacheStats;
  activeProvider: ProviderId;
}

export interface UploadInitResponse {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: 'photo' | 'video' | 'file';
  uploadUrl: string;
  posterUrl: string;
  completeUrl: string;
}

export interface GithubRepoResult {
  owner: string;
  repo: string;
  private: boolean;
  created: boolean;
}

export interface AccountDeletionStart {
  deletion: AccountDeletionStatus;
  token: string;
}

export const api = {
  status: (): Promise<AppStatus> => request('/api/status', { skipUnauthorizedEvent: true }),

  setup: (body: SetupRequest): Promise<AppStatus> =>
    request('/api/setup', { method: 'POST', body, skipUnauthorizedEvent: true }),

  login: (password: string): Promise<{ status: AppStatus }> =>
    request('/api/login', { method: 'POST', body: { password }, skipUnauthorizedEvent: true }),

  logout: (): Promise<{ ok: true }> => request('/api/logout', { method: 'POST' }),

  changePassword: (currentPassword: string, newPassword: string): Promise<{ ok: true }> =>
    request('/api/account/password', {
      method: 'POST',
      body: { currentPassword, newPassword },
      // A wrong current password is a local validation error, not an expired
      // session. Keep the user signed in.
      skipUnauthorizedEvent: true,
    }),

  startAccountDeletion: (
    password: string,
    confirm: string,
    deleteRepository: boolean,
  ): Promise<AccountDeletionStart> =>
    request('/api/account/delete', {
      method: 'POST',
      body: { password, confirm, deleteRepository },
      skipUnauthorizedEvent: true,
    }),

  getAccountDeletion: (
    token: string,
    signal?: AbortSignal,
  ): Promise<{ deletion: AccountDeletionStatus }> =>
    request(`/api/account/deletion?token=${encodeURIComponent(token)}`, {
      signal,
      skipUnauthorizedEvent: true,
    }),

  listItems: (query: ItemQuery & { limit?: number; offset?: number }, signal?: AbortSignal): Promise<ItemListResponse> => {
    const params = new URLSearchParams();
    if (query.section) params.set('section', query.section);
    if (query.q) params.set('q', query.q);
    if (query.sort) params.set('sort', query.sort);
    if (query.folder !== undefined && query.folder !== null) params.set('folder', query.folder);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    return request(`/api/items?${params.toString()}`, { signal });
  },

  listFolders: (parentId: string | null, signal?: AbortSignal): Promise<FolderListResponse> => {
    const params = new URLSearchParams();
    params.set('parent', parentId ?? 'root');
    return request(`/api/folders?${params.toString()}`, { signal });
  },

  listFolderTree: (signal?: AbortSignal): Promise<FolderTreeResponse> =>
    request('/api/folders/tree', { signal }),

  createFolder: (name: string, parentId?: string | null): Promise<{ folder: FolderDTO }> =>
    request('/api/folders', { method: 'POST', body: { name, parentId: parentId ?? null } }),

  renameFolder: (id: string, name: string): Promise<{ folder: FolderDTO }> =>
    request(`/api/folders/${encodeURIComponent(id)}`, { method: 'PATCH', body: { name } }),

  deleteFolder: (id: string): Promise<{ ok: true; folders: number; trashedItems: number }> =>
    request(`/api/folders/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getItem: (id: string): Promise<{ item: ItemDTO }> => request(`/api/items/${encodeURIComponent(id)}`),

  updateItem: (id: string, patch: { name?: string; favorite?: boolean; folderId?: string | null }): Promise<{ item: ItemDTO }> =>
    request(`/api/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch }),

  trashItem: (id: string): Promise<{ item: ItemDTO }> =>
    request(`/api/items/${encodeURIComponent(id)}/trash`, { method: 'POST' }),

  restoreItem: (id: string): Promise<{ item: ItemDTO }> =>
    request(`/api/items/${encodeURIComponent(id)}/restore`, { method: 'POST' }),

  deleteItem: (id: string): Promise<{ ok: true }> =>
    request(`/api/items/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  emptyTrash: (): Promise<{ deleted: number; failed: number }> => request('/api/trash', { method: 'DELETE' }),

  batch: (
    ids: string[],
    action: 'trash' | 'restore' | 'favorite' | 'unfavorite' | 'move',
    folderId?: string | null,
  ): Promise<{ updated: number }> =>
    request('/api/items/batch', {
      method: 'POST',
      body: action === 'move' ? { ids, action, folderId: folderId ?? null } : { ids, action },
    }),

  retryUpload: (id: string): Promise<{ item: ItemDTO }> =>
    request(`/api/items/${encodeURIComponent(id)}/retry`, { method: 'POST' }),

  pinOffline: (id: string): Promise<{ item: ItemDTO }> =>
    request(`/api/items/${encodeURIComponent(id)}/offline`, { method: 'POST' }),

  unpinOffline: (id: string): Promise<{ item: ItemDTO }> =>
    request(`/api/items/${encodeURIComponent(id)}/offline`, { method: 'DELETE' }),

  stats: (): Promise<StatsResponse> => request('/api/stats'),

  listShares: (itemId: string): Promise<ShareListResponse> =>
    request(`/api/items/${encodeURIComponent(itemId)}/shares`),

  createShare: (itemId: string, expiry: ShareExpiry): Promise<{ share: ShareDTO }> =>
    request(`/api/items/${encodeURIComponent(itemId)}/shares`, {
      method: 'POST',
      body: { expiry },
    }),

  revokeShare: (shareId: string): Promise<{ ok: true }> =>
    request(`/api/shares/${encodeURIComponent(shareId)}/revoke`, { method: 'POST' }),

  setTelemetry: (enabled: boolean): Promise<{ telemetry: TelemetryView }> =>
    request('/api/settings/telemetry', { method: 'PATCH', body: { enabled } }),

  initUpload: (body: {
    name: string;
    size: number;
    mime: string;
    takenAt: number;
    folderId?: string | null;
  }): Promise<UploadInitResponse> => request('/api/uploads', { method: 'POST', body }),

  completeUpload: (id: string, body: UploadCompleteRequest): Promise<{ item: ItemDTO }> =>
    request(`/api/uploads/${encodeURIComponent(id)}/complete`, { method: 'POST', body }),

  cancelUpload: (id: string): Promise<{ ok: true }> =>
    request(`/api/uploads/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getSettings: (): Promise<AppSettingsView> => request('/api/settings'),

  updateVaultName: (vaultName: string): Promise<AppSettingsView> =>
    request('/api/settings', { method: 'PATCH', body: { vaultName } }),

  updateStorage: (body: {
    active?: ProviderId;
    github?: { token?: string; owner?: string; repo?: string; releaseTag?: string };
    webdav?: { url?: string; username?: string; password?: string; folder?: string };
  }): Promise<{ settings: AppSettingsView }> => request('/api/settings/storage', { method: 'PATCH', body }),

  testStorage: (
    provider: ProviderId,
    config?: Record<string, string | undefined>,
  ): Promise<ProviderTestResult> =>
    request('/api/storage/test', { method: 'POST', body: { provider, config } }),

  createGithubRepo: (token: string, name: string): Promise<GithubRepoResult> =>
    request('/api/storage/github/create-repo', { method: 'POST', body: { token, name } }),

  updateCache: (body: {
    limitMB?: number;
    encrypted?: boolean;
    autoCache?: boolean;
  }): Promise<{ cache: CacheStats }> => request('/api/settings/cache', { method: 'PATCH', body }),

  clearCache: (includePinned: boolean): Promise<{ cache: CacheStats }> =>
    request('/api/cache/clear', { method: 'POST', body: { includePinned } }),
};

function uploadBody(
  url: string,
  blob: Blob,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('x-nimbus-client', '1');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        let message = `Upload failed (${xhr.status}).`;
        try {
          const parsed = JSON.parse(xhr.responseText) as { error?: { message?: string } };
          if (parsed.error?.message) message = parsed.error.message;
        } catch {
          // Keep generic message.
        }
        reject(new ApiError(message, xhr.status));
      }
    };
    xhr.onerror = () => reject(new ApiError('The upload connection was interrupted.', 0, 'network'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
      } else {
        signal.addEventListener('abort', () => xhr.abort(), { once: true });
      }
    }
    xhr.send(blob);
  });
}

export async function uploadFileBody(
  url: string,
  file: File,
  onProgress: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  await uploadBody(url, file, onProgress, signal);
}

export async function uploadPoster(
  url: string,
  poster: Blob,
  signal?: AbortSignal,
): Promise<void> {
  await uploadBody(url, poster, () => {}, signal);
}

export function contentUrl(id: string, download = false): string {
  return `/api/items/${encodeURIComponent(id)}/content${download ? '?download=1' : ''}`;
}

export function thumbUrl(id: string): string {
  return `/api/items/${encodeURIComponent(id)}/thumb`;
}

export async function fetchTextPreview(
  id: string,
  maxBytes = 512 * 1024,
): Promise<{ text: string; truncated: boolean }> {
  const response = await fetch(contentUrl(id), {
    headers: { range: `bytes=0-${maxBytes - 1}` },
    credentials: 'same-origin',
  });
  if (!response.ok && response.status !== 206) {
    throw new ApiError('Could not load this text file.', response.status);
  }
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - total;
    if (value.byteLength > remaining) {
      chunks.push(value.subarray(0, remaining));
      total += remaining;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  if (!truncated) {
    const range = response.headers.get('content-range');
    const totalHeader = range?.split('/')[1];
    if (totalHeader && Number(totalHeader) > total) truncated = true;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder('utf-8', { fatal: false }).decode(merged), truncated };
}
