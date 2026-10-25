import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import type { DbItem } from '../src/server/db.js';
import type { StorageProvider } from '../src/server/storage/index.js';
import type { CacheManager } from '../src/server/cache.js';

// config.ts reads DATA_DIR at import time, so set it before loading the server
// modules. Node's test runner gives every test file its own process.
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nimbus-cache-test-'));
process.env.DATA_DIR = dataDir;

const { CacheManager: CacheManagerClass } = await import('../src/server/cache.js');
const { config } = await import('../src/server/config.js');
const { Database } = await import('../src/server/db.js');
const { VaultSettings } = await import('../src/server/settings.js');
const { cacheFileInfo } = await import('../src/server/cache-crypto.js');

function pattern(size: number): Buffer {
  const buffer = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index++) buffer[index] = (index * 17 + 3) & 0xff;
  return buffer;
}

const REMOTE_A = pattern(2 * 1024 * 1024 + 333);
const REMOTE_B = pattern(512 * 1024 + 1);
const REMOTE_C = pattern(64 * 1024);
const blobs = { A: REMOTE_A, B: REMOTE_B, C: REMOTE_C } as const;

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function remoteProvider(data: Buffer): StorageProvider {
  return {
    id: 'webdav',
    maxUploadBytes: 1024 * 1024 * 1024,
    async put() {
      throw new Error('not used');
    },
    async get(_locator, range) {
      const start = range?.start ?? 0;
      const end = range?.end ?? data.length - 1;
      return {
        stream: Readable.from([data.subarray(start, end + 1)]),
        size: data.length,
        start,
        end,
        status: range ? 206 : 200,
        contentLength: end - start + 1,
      };
    },
    async delete() {},
    async test() {
      return { ok: true, message: 'fake' };
    },
  };
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function addRemoteItem(
  db: InstanceType<typeof Database>,
  name: string,
  data: Buffer,
  provider: 'github' | 'webdav',
): DbItem {
  const id = randomUUID();
  db.createItem({
    id,
    name,
    size: data.length,
    mime: 'application/octet-stream',
    kind: 'file',
    provider,
    status: 'ready',
    tempPath: `tmp/${id}`,
    takenAt: null,
  });
  db.updateItem(id, {
    status: 'ready',
    size: data.length,
    locator: JSON.stringify({ path: name }),
    hash: sha256(data),
  });
  return db.getItemRecord(id)!;
}

test('cache manager manages remote content, pins and encryption', async (t) => {
  const db = new Database(path.join(dataDir, 'nimbus.db'));
  const settings = new VaultSettings(db, randomBytes(32));
  const cacheKey = randomBytes(32);
  const providers = new Map([
    ['webdav', remoteProvider(REMOTE_A)],
    ['github', remoteProvider(REMOTE_B)],
    ['local', remoteProvider(REMOTE_C)],
  ]);
  const cache: CacheManager = new CacheManagerClass(db, settings, cacheKey, (id) => providers.get(id)!);

  t.after(async () => {
    await cache.shutdown();
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  settings.setCache({ encrypted: false, limitMB: 64, autoCache: true });
  await cache.initialize();

  const itemA = addRemoteItem(db, 'auto.bin', REMOTE_A, 'webdav');
  const itemB = addRemoteItem(db, 'pinned.bin', REMOTE_B, 'github');
  const itemC = addRemoteItem(db, 'manual.bin', REMOTE_C, 'webdav');
  const thumb = pattern(4096);
  await cache.savePreview(itemB.id, thumb);

  // ------------------------------------------------------------------ auto cache
  cache.maybeAutoCache(itemA);
  await waitFor(() => cache.isCached(itemA.id), 'auto-cache of item A');
  assert.deepEqual(await cacheFileInfo(path.join(config.cacheDir, 'blobs', `${itemA.id}.bin`)), {
    size: REMOTE_A.length,
    encrypted: false,
  });

  const full = await cache.openCached(itemA.id);
  assert.equal(full.status, 200);
  assert.equal(full.contentLength, REMOTE_A.length);
  assert.deepEqual(await collect(full.stream), REMOTE_A);

  const range = await cache.openCached(itemA.id, { start: 100, end: 2 * 1024 * 1024 + 200 });
  assert.equal(range.status, 206);
  assert.equal(range.contentLength, 2 * 1024 * 1024 + 101);
  assert.deepEqual(await collect(range.stream), REMOTE_A.subarray(100, 2 * 1024 * 1024 + 201));

  // Autocache disabled means no work is queued.
  settings.setCache({ autoCache: false });
  cache.maybeAutoCache(itemC);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(cache.isCached(itemC.id), false);
  settings.setCache({ autoCache: true });

  // --------------------------------------------------------------------- pinning
  await cache.pin(itemB);
  await waitFor(() => cache.isCached(itemB.id), 'pinned download of item B');
  const pinnedEntry = db.getCacheEntry(itemB.id);
  assert.equal(pinnedEntry?.pinned, 1);
  assert.equal(pinnedEntry?.complete, 1);

  // --------------------------------------------------------- encrypt the cache
  const encryptedStats = await cache.setEncryption(true);
  assert.equal(encryptedStats.encrypted, true);
  assert.equal(db.getCacheEntry(itemB.id)?.pinned, 1, 'pin flag must survive the migration');
  assert.equal(cache.isCached(itemB.id), false, 'the pinned blob is re-downloaded in the new format');
  await waitFor(
    () => db.getCacheEntry(itemB.id)?.complete === 1,
    'pinned item to be re-downloaded after enabling encryption',
  );
  assert.equal(cache.isCached(itemA.id), false, 'unpinned cache should be cleared');
  assert.deepEqual(await cache.readPreview(itemB.id), thumb, 'previews are migrated, not discarded');

  const encryptedFile = path.join(config.cacheDir, 'blobs', `${itemB.id}.bin`);
  const previewFile = path.join(config.cacheDir, 'previews', `${itemB.id}.webp`);
  assert.deepEqual(await cacheFileInfo(encryptedFile), { size: REMOTE_B.length, encrypted: true });
  assert.deepEqual(await cacheFileInfo(previewFile), { size: thumb.length, encrypted: true });
  const decrypt1 = await cache.openCached(itemB.id);
  assert.deepEqual(await collect(decrypt1.stream), REMOTE_B);
  const decryptRange = await cache.openCached(itemB.id, { start: REMOTE_B.length - 10, end: REMOTE_B.length - 1 });
  assert.deepEqual(await collect(decryptRange.stream), REMOTE_B.subarray(REMOTE_B.length - 10));

  // ------------------------------------------------------- turn encryption off
  const plainStats = await cache.setEncryption(false);
  assert.equal(plainStats.encrypted, false);
  await waitFor(
    () => db.getCacheEntry(itemB.id)?.complete === 1,
    'pinned item to be re-downloaded after disabling encryption',
  );
  assert.deepEqual(await cacheFileInfo(encryptedFile), { size: REMOTE_B.length, encrypted: false });
  assert.deepEqual(await cacheFileInfo(previewFile), { size: thumb.length, encrypted: false });
  const decrypt2 = await cache.openCached(itemB.id);
  assert.deepEqual(await collect(decrypt2.stream), REMOTE_B);

  // -------------------------------------------------------------------- eviction
  cache.maybeAutoCache(itemA);
  await waitFor(() => cache.isCached(itemA.id), 'second auto-cache of item A');
  settings.setCache({ limitMB: 0 });
  await cache.applyLimit();
  assert.equal(cache.isCached(itemA.id), false, 'limit 0 evicts unpinned content');
  assert.equal(cache.isCached(itemB.id), true, 'pinned content is never evicted');

  await cache.clear(true);
  assert.equal(cache.isCached(itemB.id), false);
  assert.equal(db.listCacheEntries('blob').length, 0);
  assert.deepEqual(await cache.readPreview(itemB.id), thumb, 'clearing cached originals keeps previews');

  // With a zero limit, auto-cache must not download files just to evict them.
  settings.setCache({ limitMB: 0 });
  cache.maybeAutoCache(itemA);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(cache.isCached(itemA.id), false);
  assert.equal(db.getCacheEntry(itemA.id), null);
});
