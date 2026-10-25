import type { ProviderId } from '../../../shared/types.js';
import { config } from '../config.js';
import type { VaultSettings } from '../settings.js';
import { ApiError } from '../utils.js';
import { GithubProvider } from './github.js';
import { LocalProvider } from './local.js';
import type { StorageProvider } from './types.js';
import { WebdavProvider } from './webdav.js';

export function createProvider(id: ProviderId, settings: VaultSettings): StorageProvider {
  if (id === 'local') return new LocalProvider(config.storageDir);
  if (id === 'github') {
    const github = settings.github;
    if (!github) throw new ApiError(409, 'GitHub storage is not configured. Add it in Settings → Cloud storage.');
    return new GithubProvider(github);
  }
  if (id === 'webdav') {
    const webdav = settings.webdav;
    if (!webdav) throw new ApiError(409, 'WebDAV storage is not configured. Add it in Settings → Cloud storage.');
    return new WebdavProvider(webdav);
  }
  throw new ApiError(400, 'Unknown storage provider.');
}

export { LocalProvider, GithubProvider, WebdavProvider };
export { storageAgent } from './http.js';
export type { StorageProvider } from './types.js';
export { ProviderError } from './types.js';
