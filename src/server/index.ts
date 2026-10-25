import { mkdir } from 'node:fs/promises';
import { config } from './config.js';
import { buildApp } from './app.js';
import { AuthService } from './auth.js';
import { CacheManager } from './cache.js';
import { loadOrCreateKey } from './crypto.js';
import { Database } from './db.js';
import type { AppContext } from './context.js';
import { purgeItem } from './items-service.js';
import { UploadQueue } from './queue.js';
import { VaultSettings } from './settings.js';
import { createProvider, storageAgent } from './storage/index.js';

async function main(): Promise<void> {
  await Promise.all([
    mkdir(config.dataDir, { recursive: true }),
    mkdir(config.storageDir, { recursive: true }),
    mkdir(config.tmpDir, { recursive: true }),
    mkdir(config.cacheDir, { recursive: true }),
  ]);

  const masterKey = await loadOrCreateKey(config.masterKeyPath);
  const cacheKey = await loadOrCreateKey(config.cacheKeyPath);

  const db = new Database(config.dbPath);
  const settings = new VaultSettings(db, masterKey);
  const auth = new AuthService(db, settings);
  const getProvider = (provider: 'local' | 'github' | 'webdav') => createProvider(provider, settings);
  const cache = new CacheManager(db, settings, cacheKey, getProvider);
  const queue = new UploadQueue(db, getProvider);

  await cache.initialize();
  await queue.resume();
  await cache.resumePins();

  const ctx: AppContext = {
    app: undefined as unknown as AppContext['app'],
    db,
    settings,
    auth,
    cache,
    queue,
    getProvider,
  };
  const app = await buildApp(ctx);

  const host = config.host;
  await app.listen({ host, port: config.port });
  const displayHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const url = config.publicUrl || `http://${displayHost}:${config.port}`;
  console.log('');
  console.log(`  ${config.brand} ${config.version}`);
  console.log(`  Local library at ${url}`);
  console.log(`  Data directory: ${config.dataDir}`);
  if (!settings.onboarded) {
    console.log('  First launch — open the URL above to create your library.');
  }
  console.log('');

  const purgeExpired = async (): Promise<void> => {
    const rows = db.listPurgeableTrash(Date.now() - 30 * 24 * 60 * 60 * 1000);
    for (const item of rows) {
      try {
        await purgeItem(item, db, cache, getProvider);
        console.log(`[trash] auto-removed ${item.name}`);
      } catch (error) {
        console.warn(`[trash] could not auto-remove ${item.id}: ${(error as Error).message}`);
      }
    }
    await queue.cleanupStale();
  };

  const purgeTimer = setInterval(() => void purgeExpired(), 6 * 60 * 60 * 1000);
  const sessionTimer = setInterval(() => auth.pruneSessions(), 24 * 60 * 60 * 1000);
  purgeTimer.unref();
  sessionTimer.unref();
  setTimeout(() => void purgeExpired(), 10_000).unref();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] ${signal} received, shutting down…`);
    clearInterval(purgeTimer);
    clearInterval(sessionTimer);
    try {
      await app.close();
      await queue.shutdown();
      await cache.shutdown();
      await storageAgent.close().catch(() => {});
      db.close();
    } catch (error) {
      console.error('[server] shutdown error:', error);
      process.exitCode = 1;
    }
    process.exit();
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Nimbus failed to start.');
  console.error(error);
  process.exit(1);
});
