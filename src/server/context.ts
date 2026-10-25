import type { FastifyInstance } from 'fastify';
import type { AuthService } from './auth.js';
import type { CacheManager } from './cache.js';
import type { Database } from './db.js';
import type { UploadQueue } from './queue.js';
import type { VaultSettings } from './settings.js';
import type { StorageProvider } from './storage/index.js';

export interface AppContext {
  app: FastifyInstance;
  db: Database;
  settings: VaultSettings;
  auth: AuthService;
  cache: CacheManager;
  queue: UploadQueue;
  getProvider: (provider: 'local' | 'github' | 'webdav') => StorageProvider;
}
