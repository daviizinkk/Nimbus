import type { CacheStats, ProviderId, StorageView } from '../../shared/types.js';
import { config } from './config.js';
import { openJson, sealJson } from './crypto.js';
import type { Database } from './db.js';
import { ApiError } from './utils.js';

export interface GithubConfig {
  token: string;
  owner: string;
  repo: string;
  releaseTag: string;
}

export interface WebdavConfig {
  url: string;
  username: string;
  password: string;
  folder: string;
}

export interface GithubConfigInput {
  token?: string;
  owner?: string;
  repo?: string;
  releaseTag?: string;
}

export interface WebdavConfigInput {
  url?: string;
  username?: string;
  password?: string;
  folder?: string;
}

export interface CacheConfig {
  encrypted: boolean;
  limitMB: number;
  autoCache: boolean;
}

const DEFAULT_RELEASE_TAG = 'nimbus-storage';
const DEFAULT_WEBDAV_FOLDER = 'nimbus';
const GITHUB_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

function cleanName(value: string | undefined): string {
  return (value ?? '').trim();
}

function sanitizeFolder(input: string | undefined): string {
  const raw = (input ?? DEFAULT_WEBDAV_FOLDER).trim().replace(/^\/+|\/+$/g, '');
  if (!raw) return DEFAULT_WEBDAV_FOLDER;
  const segments = raw
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..');
  if (segments.length === 0) return DEFAULT_WEBDAV_FOLDER;
  if (segments.length > 6) throw new ApiError(400, 'WebDAV folder path is too deep.');
  return segments.join('/');
}

function sanitizeReleaseTag(input: string | undefined): string {
  const value = (input ?? DEFAULT_RELEASE_TAG).trim();
  if (!value) return DEFAULT_RELEASE_TAG;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(value)) {
    throw new ApiError(400, 'Release tag may only contain letters, numbers, dots, dashes and underscores.');
  }
  return value;
}

/** Merges a GitHub form submission with an existing saved configuration. */
export function mergeGithubConfig(previous: GithubConfig | null, input: GithubConfigInput): GithubConfig {
  const token = cleanName(input.token);
  const owner = cleanName(input.owner) || previous?.owner || '';
  const repo = cleanName(input.repo) || previous?.repo || '';
  const releaseTag = sanitizeReleaseTag(input.releaseTag ?? previous?.releaseTag);
  const finalToken = !token || token.includes('•') ? previous?.token ?? '' : token;

  if (!finalToken) throw new ApiError(400, 'A GitHub access token is required.');
  if (!GITHUB_NAME.test(owner)) throw new ApiError(400, 'GitHub owner name is invalid.');
  if (!GITHUB_NAME.test(repo)) throw new ApiError(400, 'GitHub repository name is invalid.');
  return { token: finalToken, owner, repo, releaseTag };
}

/** Merges a WebDAV form submission with an existing saved configuration. */
export function mergeWebdavConfig(previous: WebdavConfig | null, input: WebdavConfigInput): WebdavConfig {
  const rawUrl = cleanName(input.url) || previous?.url || '';
  const url = rawUrl.replace(/\/+$/, '');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ApiError(400, 'Enter a valid WebDAV URL (for example https://cloud.example.com/remote.php/dav/files/me).');
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new ApiError(400, 'WebDAV URL must use http:// or https://.');
  }
  const username = input.username !== undefined ? input.username.trim() : previous?.username ?? '';
  const password =
    input.password !== undefined && !input.password.includes('•') ? input.password : previous?.password ?? '';
  const folder = sanitizeFolder(input.folder ?? previous?.folder);
  return { url, username, password, folder };
}

export function maskSecret(value: string): string | null {
  if (!value) return null;
  if (value.length <= 4) return '••••';
  return `••••${value.slice(-4)}`;
}

export class VaultSettings {
  constructor(
    private readonly db: Database,
    private readonly masterKey: Buffer,
  ) {}

  get vaultName(): string {
    return this.db.getSetting('vault.name') || 'My Nimbus';
  }

  set vaultName(value: string) {
    const name = value.trim().slice(0, 60);
    if (!name) throw new ApiError(400, 'Library name cannot be empty.');
    this.db.setSetting('vault.name', name);
  }

  get passwordHash(): string | null {
    return this.db.getSetting('password.hash');
  }

  set passwordHash(value: string) {
    this.db.setSetting('password.hash', value);
  }

  get onboarded(): boolean {
    return Boolean(this.passwordHash);
  }

  get activeProvider(): ProviderId {
    const value = this.db.getSetting('storage.active');
    return value === 'github' || value === 'webdav' || value === 'local' ? value : 'local';
  }

  set activeProvider(value: ProviderId) {
    if (value !== 'local' && value !== 'github' && value !== 'webdav') {
      throw new ApiError(400, 'Unknown storage provider.');
    }
    if (value === 'github' && !this.github) throw new ApiError(409, 'GitHub storage is not configured yet.');
    if (value === 'webdav' && !this.webdav) throw new ApiError(409, 'WebDAV storage is not configured yet.');
    this.db.setSetting('storage.active', value);
  }

  get github(): GithubConfig | null {
    const raw = this.db.getSetting('storage.github');
    const parsed = openJson<Partial<GithubConfig>>(raw, this.masterKey, 'storage.github');
    if (!parsed) return null;
    const token = typeof parsed.token === 'string' ? parsed.token : '';
    const owner = typeof parsed.owner === 'string' ? parsed.owner : '';
    const repo = typeof parsed.repo === 'string' ? parsed.repo : '';
    if (!token || !owner || !repo) return null;
    return {
      token,
      owner,
      repo,
      releaseTag: sanitizeReleaseTag(parsed.releaseTag),
    };
  }

  get webdav(): WebdavConfig | null {
    const raw = this.db.getSetting('storage.webdav');
    const parsed = openJson<Partial<WebdavConfig>>(raw, this.masterKey, 'storage.webdav');
    if (!parsed) return null;
    const url = typeof parsed.url === 'string' ? parsed.url.trim().replace(/\/+$/, '') : '';
    if (!url) return null;
    return {
      url,
      username: typeof parsed.username === 'string' ? parsed.username : '',
      password: typeof parsed.password === 'string' ? parsed.password : '',
      folder: sanitizeFolder(typeof parsed.folder === 'string' ? parsed.folder : undefined),
    };
  }

  saveGithub(input: GithubConfigInput): GithubConfig {
    const value = mergeGithubConfig(this.github, input);
    this.db.setSetting('storage.github', sealJson(value, this.masterKey, 'storage.github'));
    return value;
  }

  saveWebdav(input: WebdavConfigInput): WebdavConfig {
    const value = mergeWebdavConfig(this.webdav, input);
    this.db.setSetting('storage.webdav', sealJson(value, this.masterKey, 'storage.webdav'));
    return value;
  }

  get cache(): CacheConfig {
    const limitRaw = Number.parseInt(this.db.getSetting('cache.limit_mb') ?? '', 10);
    const limitMB = Number.isFinite(limitRaw) ? Math.max(0, Math.min(1024 * 1024, limitRaw)) : config.defaultCacheLimitMB;
    const encryptedRaw = this.db.getSetting('cache.encrypted');
    const autoRaw = this.db.getSetting('cache.auto');
    return {
      encrypted: encryptedRaw === null ? config.defaultCacheEncrypted : encryptedRaw === '1',
      limitMB,
      autoCache: autoRaw === null ? true : autoRaw === '1',
    };
  }

  setCache(patch: Partial<CacheConfig>): CacheConfig {
    const current = this.cache;
    const next: CacheConfig = {
      encrypted: patch.encrypted ?? current.encrypted,
      limitMB: patch.limitMB ?? current.limitMB,
      autoCache: patch.autoCache ?? current.autoCache,
    };
    if (!Number.isFinite(next.limitMB) || next.limitMB < 0) {
      throw new ApiError(400, 'Cache limit must be a positive number of megabytes.');
    }
    next.limitMB = Math.min(1024 * 1024, Math.floor(next.limitMB));
    this.db.setSetting('cache.encrypted', next.encrypted ? '1' : '0');
    this.db.setSetting('cache.limit_mb', String(next.limitMB));
    this.db.setSetting('cache.auto', next.autoCache ? '1' : '0');
    return next;
  }

  publicStorage(): StorageView {
    const github = this.github;
    const webdav = this.webdav;
    return {
      active: this.activeProvider,
      local: { configured: true, path: config.storageDir },
      github: {
        configured: Boolean(github),
        owner: github?.owner ?? '',
        repo: github?.repo ?? '',
        hasToken: Boolean(github?.token),
        tokenHint: github ? maskSecret(github.token) : null,
        releaseTag: github?.releaseTag ?? DEFAULT_RELEASE_TAG,
      },
      webdav: {
        configured: Boolean(webdav),
        url: webdav?.url ?? '',
        username: webdav?.username ?? '',
        folder: webdav?.folder ?? DEFAULT_WEBDAV_FOLDER,
        hasPassword: Boolean(webdav?.password),
      },
    };
  }

  cacheStats(): CacheStats {
    const cache = this.cache;
    const stats = this.db.getCacheStats(cache.limitMB);
    return { ...stats, encrypted: cache.encrypted, limitMB: cache.limitMB, autoCache: cache.autoCache };
  }

  getProviderConfig(provider: ProviderId): GithubConfig | WebdavConfig | null {
    if (provider === 'github') return this.github;
    if (provider === 'webdav') return this.webdav;
    return null;
  }
}
