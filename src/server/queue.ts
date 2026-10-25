import { stat, unlink } from 'node:fs/promises';
import type { Database, DbItem } from './db.js';
import { config } from './config.js';
import type { StorageProvider } from './storage/index.js';
import { fileExtension, now, truncate } from './utils.js';

const MAX_ATTEMPTS = 3;

/**
 * Durable, in-process upload queue. Files are staged locally first, so a
 * completed upload keeps retrying in the background even if the browser closes.
 */
export class UploadQueue {
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly active = new Set<string>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private maxConcurrent = 2;
  private closed = false;

  constructor(
    private readonly db: Database,
    private readonly getProvider: (id: DbItem['provider']) => StorageProvider,
  ) {}

  async resume(): Promise<void> {
    this.db.sqlite
      .prepare(`UPDATE items SET status = 'queued' WHERE status = 'uploading'`)
      .run();
    const rows = this.db.listProcessing();
    for (const item of rows) {
      if (!item.temp_path) {
        this.db.updateItem(item.id, { status: 'error', error: 'Upload data was lost before it reached the cloud.' });
        continue;
      }
      try {
        await stat(item.temp_path);
        this.enqueue(item.id, false);
      } catch {
        this.db.updateItem(item.id, { status: 'error', error: 'Staged upload file is missing.' });
      }
    }

    // Abandoned browser uploads never reached the queue; clean them up.
    const stale = this.db.listStaleReceiving(Date.now() - 24 * 60 * 60 * 1000);
    for (const item of stale) {
      if (item.temp_path) await unlink(item.temp_path).catch(() => {});
      if (item.poster_path) await unlink(item.poster_path).catch(() => {});
      this.db.deleteItemRow(item.id);
    }
  }

  enqueue(id: string, resetAttempts = true): void {
    if (this.closed) return;
    if (resetAttempts) {
      this.db.updateItem(id, { status: 'queued', error: null, attempts: 0 });
    } else {
      this.db.updateItem(id, { status: 'queued' });
    }
    if (this.queued.has(id) || this.active.has(id)) return;
    this.queued.add(id);
    this.queue.push(id);
    this.pump();
  }

  retry(id: string): boolean {
    const item = this.db.getItemRecord(id);
    if (!item || item.status !== 'error' || !item.temp_path) return false;
    this.enqueue(id, true);
    return true;
  }

  private pump(): void {
    while (!this.closed && this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.queued.delete(id);
      if (this.active.has(id)) continue;
      this.active.add(id);
      void this.process(id).finally(() => {
        this.active.delete(id);
        this.pump();
      });
    }
  }

  private async process(id: string): Promise<void> {
    const item = this.db.getItemRecord(id);
    if (!item || !item.temp_path) return;
    if (item.status === 'ready') return;

    this.db.updateItem(id, { status: 'uploading', error: null });

    try {
      await stat(item.temp_path);
      const provider = this.getProvider(item.provider);
      if (Number.isFinite(provider.maxUploadBytes) && item.size > provider.maxUploadBytes) {
        throw new Error(
          `This file is larger than the selected storage provider allows (${Math.round(provider.maxUploadBytes / 1024 / 1024 / 1024 * 10) / 10} GB).`,
        );
      }
      const locator = await provider.put(
        item.id,
        fileExtension(item.name),
        item.name,
        item.temp_path,
        item.size,
        item.mime,
      );
      this.db.updateItem(id, {
        status: 'ready',
        locator: JSON.stringify(locator),
        temp_path: null,
        error: null,
        attempts: 0,
      });
      await unlink(item.temp_path).catch(() => {});
      if (item.poster_path) await unlink(item.poster_path).catch(() => {});
      console.log(`[upload] stored ${item.name} (${item.size} bytes) via ${item.provider}`);
    } catch (error) {
      const message = truncate(error instanceof Error ? error.message : String(error), 500);
      const attempts = item.attempts + 1;
      if (attempts < MAX_ATTEMPTS && !this.closed) {
        this.db.updateItem(id, {
          status: 'queued',
          error: `Retrying (${attempts + 1}/${MAX_ATTEMPTS}): ${message}`,
          attempts,
        });
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer);
          this.enqueue(id, false);
        }, Math.min(30_000, 1500 * attempts * attempts));
        this.retryTimers.add(timer);
      } else {
        this.db.updateItem(id, { status: 'error', error: message, attempts });
        console.error(`[upload] failed for ${item.name}: ${message}`);
      }
    }
  }

  async cleanupStale(): Promise<void> {
    const stale = this.db.listStaleReceiving(Date.now() - 24 * 60 * 60 * 1000);
    for (const item of stale) {
      if (item.temp_path) await unlink(item.temp_path).catch(() => {});
      if (item.poster_path) await unlink(item.poster_path).catch(() => {});
      this.db.deleteItemRow(item.id);
    }
  }

  async shutdown(timeoutMs = 3000): Promise<void> {
    this.closed = true;
    this.queue.length = 0;
    this.queued.clear();
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    // Active provider uploads cannot be cancelled safely; give them a moment
    // to finish so their database updates are not cut off.
    const deadline = Date.now() + timeoutMs;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  /** Re-enables uploads after a cancelled account deletion. */
  reopen(): void {
    this.closed = false;
    this.pump();
  }
}
