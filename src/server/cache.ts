import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CacheStats } from '../../shared/types.js';
import { config } from './config.js';
import {
  cacheFileInfo,
  readEncryptedAll,
  readEncryptedRange,
  writeEncryptedBuffer,
  writeEncryptedFile,
} from './cache-crypto.js';
import type { CacheEntryRow, Database, DbItem } from './db.js';
import type { VaultSettings } from './settings.js';
import type { StorageProvider } from './storage/index.js';
import { ProviderError } from './storage/index.js';
import { ApiError, truncate, uid } from './utils.js';

const SAFE_ID = /^[a-f0-9-]{36}$/i;

export interface CachedContent {
  stream: Readable;
  size: number;
  start: number;
  end: number;
  status: 200 | 206;
  contentLength: number;
}

interface PrefetchJob {
  item: DbItem;
  pinned: boolean;
  generation: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

function thumbnailKey(id: string): string {
  return `thumb:${id}`;
}

function parseLocator(raw: string | null): Record<string, unknown> {
  if (!raw) throw new ProviderError('This item has no storage location yet.', 409);
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ProviderError('The stored file location is invalid.', 500);
  }
}

export class CacheManager {
  private readonly blobDir = path.join(config.cacheDir, 'blobs');
  private readonly previewDir = path.join(config.cacheDir, 'previews');
  private readonly tmpDir = path.join(config.cacheDir, 'tmp');
  private migration: Promise<void> | null = null;
  private generation = 0;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly queue: PrefetchJob[] = [];
  private active = 0;
  private readonly maxConcurrent = 2;
  private readonly touches = new Map<string, number>();
  private closed = false;

  constructor(
    private readonly db: Database,
    private readonly settings: VaultSettings,
    private readonly cacheKey: Buffer,
    private readonly getProvider: (id: DbItem['provider']) => StorageProvider,
  ) {}

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.blobDir, { recursive: true }),
      mkdir(this.previewDir, { recursive: true }),
      mkdir(this.tmpDir, { recursive: true }),
    ]);
    await this.reconcile();
    await this.evict();
    await this.cleanTemp();
  }

  private assertId(id: string): void {
    if (!SAFE_ID.test(id)) throw new Error('Invalid item identifier');
  }

  private blobPath(id: string): string {
    this.assertId(id);
    return path.join(this.blobDir, `${id}.bin`);
  }

  private previewPath(id: string): string {
    this.assertId(id);
    return path.join(this.previewDir, `${id}.webp`);
  }

  private async awaitReady(): Promise<void> {
    if (this.migration) await this.migration;
  }

  // --------------------------------------------------------------- lifecycle

  private async reconcile(): Promise<void> {
    const entries = this.db.listCacheEntries();
    for (const entry of entries) {
      const id = entry.kind === 'preview' ? entry.key.slice('thumb:'.length) : entry.key;
      if (!SAFE_ID.test(id)) {
        this.db.deleteCacheEntry(entry.key);
        continue;
      }
      const file = entry.kind === 'preview' ? this.previewPath(id) : this.blobPath(id);
      try {
        const info = await cacheFileInfo(file);
        if (entry.complete === 1) {
          if (info.size !== entry.size) {
            this.db.upsertCacheEntry({
              key: entry.key,
              kind: entry.kind,
              size: info.size,
              complete: true,
              pinned: entry.pinned === 1,
            });
          }
        }
        if (!entry.complete) {
          await unlink(file).catch(() => {});
          // Incomplete auto-cache entries are worthless after a restart; pinned
          // entries are kept so resumePins() can retry them.
          if (entry.pinned !== 1) this.db.deleteCacheEntry(entry.key);
        }
      } catch {
        this.db.deleteCacheEntry(entry.key);
        await unlink(file).catch(() => {});
      }
    }
    await this.evict();
  }

  private async cleanTemp(): Promise<void> {
    try {
      const files = await readdir(this.tmpDir);
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const file of files) {
        const full = path.join(this.tmpDir, file);
        try {
          const info = await stat(full);
          if (info.mtimeMs < cutoff) await unlink(full);
        } catch {
          // Ignore.
        }
      }
    } catch {
      // Ignore.
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      job.reject(new Error('Server shutting down'));
    }
    // Active downloads still need the database to record completion. Give them
    // a moment to settle so closing the database does not cause stray errors.
    const deadline = Date.now() + 5000;
    while (this.active > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Stops background prefetches before an account deletion wipes the cache. */
  async suspendForDeletion(): Promise<void> {
    this.closed = true;
    this.generation += 1;
    for (const job of this.queue.splice(0)) {
      job.reject(new Error('Library deletion in progress'));
    }
    const deadline = Date.now() + 20_000;
    while (this.active > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Removes every cache and preview file after `suspendForDeletion`. */
  async wipeForDeletion(): Promise<void> {
    this.touches.clear();
    this.inFlight.clear();
    await rm(config.cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    await Promise.all([
      mkdir(this.blobDir, { recursive: true }),
      mkdir(this.previewDir, { recursive: true }),
      mkdir(this.tmpDir, { recursive: true }),
    ]);
  }

  /** Allows the fresh, post-deletion library to use the cache again. */
  reopen(): void {
    this.closed = false;
  }

  // ------------------------------------------------------------------ reading

  isCached(id: string): boolean {
    const entry = this.db.getCacheEntry(id);
    if (!entry || entry.kind !== 'blob' || entry.complete !== 1) return false;
    return true;
  }

  touch(id: string): void {
    const last = this.touches.get(id) ?? 0;
    if (Date.now() - last < 5 * 60_000) return;
    this.touches.set(id, Date.now());
    this.db.touchCacheEntry(id);
  }

  async openCached(id: string, range?: { start: number; end: number }): Promise<CachedContent> {
    await this.awaitReady();
    const file = this.blobPath(id);
    const info = await cacheFileInfo(file);
    if (info.size === 0) {
      return {
        stream: Readable.from([]),
        size: 0,
        start: 0,
        end: 0,
        status: range ? 206 : 200,
        contentLength: 0,
      };
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? info.size - 1;
    if (start < 0 || end >= info.size || start > end) throw new ApiError(416, 'Requested range is not available.');
    const stream = info.encrypted
      ? Readable.from(readEncryptedRange(file, this.cacheKey, start, end), { objectMode: false })
      : createReadStream(file, { start, end });
    this.touch(id);
    return {
      stream,
      size: info.size,
      start,
      end,
      status: range ? 206 : 200,
      contentLength: end - start + 1,
    };
  }

  async hasPreview(id: string): Promise<boolean> {
    const entry = this.db.getCacheEntry(thumbnailKey(id));
    if (!entry || entry.complete !== 1) return false;
    try {
      await stat(this.previewPath(id));
      return true;
    } catch {
      return false;
    }
  }

  async readPreview(id: string): Promise<Buffer | null> {
    await this.awaitReady();
    const file = this.previewPath(id);
    try {
      const info = await cacheFileInfo(file);
      const buffer = info.encrypted ? await readEncryptedAll(file, this.cacheKey) : await readFile(file);
      return buffer;
    } catch {
      await this.removePreview(id);
      return null;
    }
  }

  async savePreview(id: string, buffer: Buffer): Promise<void> {
    await this.awaitReady();
    const file = this.previewPath(id);
    const temporary = path.join(this.tmpDir, `preview-${id}-${uid()}.part`);
    try {
      if (this.settings.cache.encrypted) {
        await writeEncryptedBuffer(buffer, temporary, this.cacheKey);
      } else {
        await writeFile(temporary, buffer, { mode: 0o600 });
      }
      await unlink(file).catch(() => {});
      await rename(temporary, file);
      this.db.upsertCacheEntry({
        key: thumbnailKey(id),
        kind: 'preview',
        size: buffer.length,
        complete: true,
      });
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async removePreview(id: string): Promise<void> {
    const file = this.previewPath(id);
    await unlink(file).catch(() => {});
    this.db.deleteCacheEntry(thumbnailKey(id));
  }

  async removeForItem(id: string): Promise<void> {
    await unlink(this.blobPath(id)).catch(() => {});
    this.db.deleteCacheEntry(id);
    this.touches.delete(id);
    await this.removePreview(id);
  }

  async invalidateBlob(id: string): Promise<void> {
    await unlink(this.blobPath(id)).catch(() => {});
    this.db.deleteCacheEntry(id);
    this.touches.delete(id);
  }

  // ------------------------------------------------------------------- cache

  private async writeDownload(
    item: DbItem,
    download: Awaited<ReturnType<StorageProvider['get']>>,
    temporary: string,
    encrypted: boolean,
  ): Promise<void> {
    const hash = createHash('sha256');
    async function* hashing(): AsyncGenerator<Buffer> {
      for await (const chunk of download.stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(buffer);
        yield buffer;
      }
    }

    try {
      if (encrypted) {
        await writeEncryptedFile(hashing(), temporary, item.size, this.cacheKey);
      } else {
        const tap = new Transform({
          transform(chunk, _encoding, callback) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            hash.update(buffer);
            callback(null, buffer);
          },
        });
        await pipeline(download.stream, tap, createWriteStream(temporary, { mode: 0o600 }));
        const info = await stat(temporary);
        if (info.size !== item.size) throw new Error(`Cached size mismatch (${info.size} vs ${item.size})`);
      }
    } catch (error) {
      download.stream.destroy();
      throw error;
    }

    const digest = hash.digest('hex');
    if (item.hash && digest !== item.hash) {
      throw new Error('Downloaded file failed its integrity check.');
    }
  }

  private schedulePrefetch(item: DbItem, pinned: boolean, generation: number): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Cache is shutting down'));
    const existing = this.inFlight.get(item.id);
    if (existing) return existing;
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ item, pinned, generation, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (!this.closed && this.active < this.maxConcurrent && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.active += 1;
      const promise = this.runPrefetch(job).finally(() => {
        this.active -= 1;
        this.inFlight.delete(job.item.id);
        this.pump();
      });
      this.inFlight.set(job.item.id, promise);
    }
  }

  private async runPrefetch(job: PrefetchJob): Promise<void> {
    const { item, pinned, generation } = job;
    try {
      if (job.generation !== this.generation) return job.resolve();
      const entry = this.db.getCacheEntry(item.id);
      if (!entry) {
        // The item was unpinned/removed while queued.
        return job.resolve();
      }
      if (entry.complete === 1) return job.resolve();
      if (item.provider === 'local' || !item.locator) {
        this.db.deleteCacheEntry(item.id);
        return job.resolve();
      }

      const provider = this.getProvider(item.provider);
      const download = await provider.get(parseLocator(item.locator));
      if (download.size && download.size !== item.size) {
        download.stream.destroy();
        throw new Error('Cloud storage returned an unexpected file size.');
      }

      const temporary = path.join(this.tmpDir, `blob-${item.id}-${uid()}.part`);
      try {
        await this.writeDownload(item, download, temporary, this.settings.cache.encrypted);
        if (job.generation !== this.generation) {
          await unlink(temporary).catch(() => {});
          return job.resolve();
        }
        const stillExists = this.db.getCacheEntry(item.id);
        if (!stillExists) {
          await unlink(temporary).catch(() => {});
          return job.resolve();
        }
        const target = this.blobPath(item.id);
        await unlink(target).catch(() => {});
        await rename(temporary, target);
        this.db.markCacheComplete(item.id, item.size);
        if (pinned) this.db.upsertCacheEntry({ key: item.id, kind: 'blob', size: item.size, complete: true, pinned: true });
        await this.evict();
        job.resolve();
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
    } catch (error) {
      const message = truncate(error instanceof Error ? error.message : String(error), 300);
      try {
        const entry = this.db.getCacheEntry(item.id);
        if (entry?.pinned === 1) {
          this.db.markCacheFailed(item.id, message);
        } else {
          this.db.deleteCacheEntry(item.id);
          await unlink(this.blobPath(item.id)).catch(() => {});
        }
        if (pinned) {
          // Keep a pinned entry so the UI can surface the error and offer a retry.
          this.db.upsertCacheEntry({ key: item.id, kind: 'blob', size: 0, complete: false, pinned: true, error: message });
        }
      } catch {
        // The database is already closed (server shutdown). The partial file is
        // removed on the next start.
      }
      job.reject(error instanceof Error ? error : new Error(message));
    }
  }

  maybeAutoCache(item: DbItem): void {
    if (item.provider === 'local' || item.status !== 'ready' || !item.locator) return;
    const cache = this.settings.cache;
    if (!cache.autoCache || this.closed) return;
    // A zero limit means no automatic caching. Explicit offline pins still work.
    if (cache.limitMB === 0) return;
    const limitBytes = cache.limitMB * 1024 * 1024;
    if (item.size <= 0 || item.size > config.autoCacheMaxBytes) return;
    if (item.size > limitBytes) return;
    if (this.isCached(item.id) || this.inFlight.has(item.id)) return;
    this.db.upsertCacheEntry({ key: item.id, kind: 'blob', size: 0, complete: false, pinned: false });
    this.schedulePrefetch(item, false, this.generation).catch((error) => {
      console.warn(`[cache] prefetch failed for ${item.id}: ${(error as Error).message}`);
    });
  }

  async pin(item: DbItem): Promise<void> {
    if (item.provider === 'local') throw new ApiError(400, 'Local files are already stored on this device.');
    if (item.status !== 'ready' || !item.locator) throw new ApiError(409, 'Wait for the upload to finish before saving it offline.');
    if (this.isCached(item.id)) {
      this.db.upsertCacheEntry({ key: item.id, kind: 'blob', size: item.size, complete: true, pinned: true });
      return;
    }
    this.db.upsertCacheEntry({ key: item.id, kind: 'blob', size: 0, complete: false, pinned: true });
    this.schedulePrefetch(item, true, this.generation).catch(() => {
      // The cache error is exposed through the item DTO.
    });
  }

  async unpin(item: DbItem): Promise<void> {
    const entry = this.db.getCacheEntry(item.id);
    if (!entry) return;
    await unlink(this.blobPath(item.id)).catch(() => {});
    this.db.deleteCacheEntry(item.id);
    this.touches.delete(item.id);
  }

  async retryPin(item: DbItem): Promise<void> {
    await this.pin(item);
  }

  async setEncryption(encrypted: boolean): Promise<CacheStats> {
    if (this.migration) await this.migration;
    if (this.settings.cache.encrypted === encrypted) return this.stats();

    // Remember which items the owner asked to keep offline. Clearing the
    // encrypted blobs deletes their cache rows, so they are re-queued below.
    const pinnedItems: DbItem[] = [];
    for (const entry of this.db.listCacheEntries('blob')) {
      if (entry.pinned !== 1) continue;
      const item = this.db.getItemRecord(entry.key);
      if (item && item.status === 'ready' && item.provider !== 'local' && item.locator) {
        pinnedItems.push(item);
      }
    }

    let resolveMigration: () => void = () => {};
    const task = new Promise<void>((resolve, reject) => {
      resolveMigration = resolve;
      void (async () => {
        try {
          await this.clearBlobs(true);
          const previews = this.db.listCacheEntries('preview');
          for (const entry of previews) {
            const id = entry.key.slice('thumb:'.length);
            if (!SAFE_ID.test(id)) continue;
            const file = this.previewPath(id);
            try {
              const info = await cacheFileInfo(file);
              const plain = info.encrypted ? await readEncryptedAll(file, this.cacheKey) : await readFile(file);
              const temporary = path.join(this.tmpDir, `preview-${id}-${uid()}.part`);
              if (encrypted) {
                await writeEncryptedBuffer(plain, temporary, this.cacheKey);
              } else {
                await writeFile(temporary, plain, { mode: 0o600 });
              }
              await unlink(file).catch(() => {});
              await rename(temporary, file);
            } catch (error) {
              console.warn(`[cache] could not migrate preview ${id}: ${(error as Error).message}`);
              await this.removePreview(id);
            }
          }
          this.settings.setCache({ encrypted });
          // Recreate pinned rows only after the new encryption mode is active.
          for (const item of pinnedItems) {
            this.db.upsertCacheEntry({
              key: item.id,
              kind: 'blob',
              size: 0,
              complete: false,
              pinned: true,
            });
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      })();
    });
    this.migration = task.finally(() => {
      this.migration = null;
    });
    await this.migration;
    this.generation += 1;

    const requeuePinned = (item: DbItem): void => {
      if (this.closed) return;
      this.schedulePrefetch(item, true, this.generation).catch((error: Error) => {
        this.db.markCacheFailed(item.id, truncate(error.message, 300));
      });
    };
    for (const item of pinnedItems) {
      if (this.closed) break;
      const existing = this.inFlight.get(item.id);
      if (existing) {
        // A prefetch from before the toggle may still be winding down. Queue a
        // fresh download in the new format once it releases the item.
        void existing.catch(() => {}).finally(() => requeuePinned(item));
      } else {
        requeuePinned(item);
      }
    }
    return this.stats();
  }

  private async clearBlobs(includePinned: boolean): Promise<void> {
    const rows = this.db.clearCacheRows('blob', includePinned);
    for (const row of rows) {
      await unlink(this.blobPath(row.key)).catch(() => {});
    }
    this.generation += 1;
  }

  async clear(includePinned = false): Promise<void> {
    await this.clearBlobs(includePinned);
    this.touches.clear();
  }

  async applyLimit(): Promise<void> {
    await this.evict();
  }

  private async evict(): Promise<void> {
    const cache = this.settings.cache;
    if (cache.limitMB === 0) {
      const rows = this.db.listCacheEntries('blob');
      for (const row of rows) {
        if (row.pinned === 1) continue;
        await unlink(this.blobPath(row.key)).catch(() => {});
        this.db.deleteCacheEntry(row.key);
      }
      return;
    }
    const limitBytes = cache.limitMB * 1024 * 1024;
    let total = this.stats().blobBytes;
    let guard = 0;
    while (total > limitBytes && guard < 1000) {
      guard += 1;
      const candidates = this.db.listEvictable(25);
      if (candidates.length === 0) break;
      let removed = 0;
      for (const entry of candidates) {
        try {
          await unlink(this.blobPath(entry.key));
        } catch {
          // If the file is locked, keep the row for the next pass.
          continue;
        }
        this.db.deleteCacheEntry(entry.key);
        total -= entry.size;
        removed += 1;
        if (total <= limitBytes) break;
      }
      if (removed === 0) break;
    }
  }

  async resumePins(): Promise<void> {
    const entries = this.db.listCacheEntries('blob');
    for (const entry of entries) {
      if (entry.pinned !== 1 || entry.complete === 1) continue;
      const item = this.db.getItemRecord(entry.key);
      if (!item || item.status !== 'ready') {
        this.db.deleteCacheEntry(entry.key);
        continue;
      }
      this.schedulePrefetch(item, true, this.generation).catch(() => {});
    }
  }

  stats(): CacheStats {
    const cache = this.settings.cache;
    const stats = this.db.getCacheStats(cache.limitMB);
    return { ...stats, encrypted: cache.encrypted, limitMB: cache.limitMB, autoCache: cache.autoCache };
  }
}
