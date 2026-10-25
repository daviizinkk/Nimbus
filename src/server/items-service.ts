import { unlink } from 'node:fs/promises';
import type { CacheManager } from './cache.js';
import type { Database, DbItem } from './db.js';
import type { StorageProvider } from './storage/index.js';
import { ApiError } from './utils.js';

function parseLocator(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Permanently removes an item from the library and its storage provider.
 * Metadata is kept if the provider deletion fails, so the action can be retried.
 */
export async function purgeItem(
  item: DbItem,
  db: Database,
  cache: CacheManager,
  getProvider: (provider: DbItem['provider']) => StorageProvider,
): Promise<void> {
  if (item.status === 'queued' || item.status === 'uploading') {
    throw new ApiError(409, 'This file is still being uploaded. Wait for it to finish before deleting it permanently.');
  }

  if (item.status === 'ready' && item.locator) {
    const locator = parseLocator(item.locator);
    if (locator) {
      const provider = getProvider(item.provider);
      await provider.delete(locator);
    }
  }

  if (item.temp_path) await unlink(item.temp_path).catch(() => {});
  if (item.poster_path) await unlink(item.poster_path).catch(() => {});
  await cache.removeForItem(item.id);
  db.deleteItemRow(item.id);
}

export async function trashItem(item: DbItem, db: Database): Promise<void> {
  if (item.trashed_at) return;
  if (item.status === 'queued' || item.status === 'uploading') {
    throw new ApiError(409, 'Wait for this upload to finish before moving it to trash.');
  }
  db.updateItem(item.id, { trashed_at: Date.now() });
}
