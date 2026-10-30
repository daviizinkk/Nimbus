import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { FastifyRequest } from 'fastify';
import type { AppContext } from '../src/server/context.js';
import type { Database } from '../src/server/db.js';
import type { VaultSettings } from '../src/server/settings.js';

// config.ts reads DATA_DIR at import time, so set it before loading server code.
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nimbus-shares-test-'));
process.env.DATA_DIR = dataDir;

const { config } = await import('../src/server/config.js');
const { Database: DatabaseClass } = await import('../src/server/db.js');
const { VaultSettings: VaultSettingsClass } = await import('../src/server/settings.js');
const { sha256, randomToken } = await import('../src/server/crypto.js');
const {
  createShare,
  expiryToTimestamp,
  isShareActive,
  parseShareExpiry,
  resolveShare,
  shareDTO,
  SHARE_EXPIRY_MS,
  MAX_ACTIVE_SHARES,
} = await import('../src/server/shares.js');
const { buildTelemetryPayload, TelemetryService } = await import('../src/server/telemetry.js');

function request(host = 'nimbus.test'): FastifyRequest {
  return {
    headers: { host },
    protocol: 'https',
  } as unknown as FastifyRequest;
}

function addItem(db: InstanceType<typeof DatabaseClass>, id: string, name = 'holiday.jpg'): void {
  db.createItem({
    id,
    name,
    size: 2048,
    mime: 'image/jpeg',
    kind: 'photo',
    provider: 'local',
    status: 'ready',
    tempPath: `tmp/${id}`,
    takenAt: Date.now(),
  });
  db.updateItem(id, {
    status: 'ready',
    locator: JSON.stringify({ path: `${id}.bin` }),
    hash: 'a'.repeat(64),
  });
}

async function withStore(
  t: test.TestContext,
): Promise<{ db: InstanceType<typeof DatabaseClass>; settings: InstanceType<typeof VaultSettingsClass> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nimbus-share-store-'));
  const db = new DatabaseClass(path.join(dir, 'nimbus.db'));
  const settings = new VaultSettingsClass(db, randomBytes(32));
  t.after(() => {
    db.close();
    void rm(dir, { recursive: true, force: true });
  });
  return { db, settings };
}

test('share tokens are unguessable, hashed at rest and sealed for re-copying', async (t) => {
  const { db, settings } = await withStore(t);
  addItem(db, 'item-photo');
  const ctx = { db, settings } as unknown as AppContext;

  const share = createShare(ctx, db.getItemRecord('item-photo')!, '7d', request());
  const token = decodeURIComponent(new URL(share.url).pathname.replace('/s/', ''));

  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(share.url.startsWith('https://nimbus.test/s/'));
  assert.equal(share.active, true);
  assert.ok(share.expiresAt !== null && share.expiresAt > Date.now());

  const row = db.getShare(share.id);
  assert.ok(row);
  assert.equal(row.token_hash, sha256(token));
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_sealed.includes(token), false);
  assert.equal(settings.openShareToken(share.id, row.token_sealed), token);
  assert.equal(db.getShareByTokenHash(sha256(token))?.id, share.id);

  const resolved = resolveShare(ctx, token);
  assert.equal(resolved?.item.id, 'item-photo');

  const again = shareDTO(ctx, row, request());
  assert.equal(again?.url, share.url);

  assert.equal(resolveShare(ctx, `${token}x`), null);
  assert.equal(resolveShare(ctx, 'short'), null);
});

test('share links expire, revoke, count views and reject trashed or pending items', async (t) => {
  const { db, settings } = await withStore(t);
  addItem(db, 'item-photo');
  addItem(db, 'item-trashed');
  const ctx = { db, settings } as unknown as AppContext;
  const item = db.getItemRecord('item-photo')!;

  const active = createShare(ctx, item, 'never', request());
  assert.equal(active.expiresAt, null);
  assert.equal(isShareActive(db.getShare(active.id)!), true);

  db.touchShare(active.id);
  db.touchShare(active.id);
  const touched = db.getShare(active.id)!;
  assert.equal(touched.access_count, 2);
  assert.ok(touched.last_access_at);
  assert.equal(shareDTO(ctx, touched, request())?.accessCount, 2);

  db.revokeShare(active.id);
  assert.equal(db.getShare(active.id)?.revoked_at !== null, true);
  assert.equal(isShareActive(db.getShare(active.id)!), false);
  const revokedToken = decodeURIComponent(new URL(active.url).pathname.replace('/s/', ''));
  assert.equal(resolveShare(ctx, revokedToken), null);

  const expiredToken = 'expired-token-0123456789';
  db.createShare({
    id: 'share-expired',
    itemId: 'item-photo',
    tokenHash: sha256(expiredToken),
    tokenSealed: settings.sealShareToken('share-expired', expiredToken),
    expiresAt: Date.now() - 1_000,
  });
  assert.equal(isShareActive(db.getShare('share-expired')!), false);
  assert.equal(resolveShare(ctx, expiredToken), null);

  const trashed = createShare(ctx, db.getItemRecord('item-trashed')!, '1d', request());
  const trashedToken = decodeURIComponent(new URL(trashed.url).pathname.replace('/s/', ''));
  db.updateItem('item-trashed', { trashed_at: Date.now() });
  assert.equal(resolveShare(ctx, trashedToken), null);

  db.createItem({
    id: 'item-pending',
    name: 'pending.jpg',
    size: 1,
    mime: 'image/jpeg',
    kind: 'photo',
    provider: 'local',
    status: 'receiving',
    tempPath: 'tmp/pending',
    takenAt: null,
  });
  assert.throws(
    () => createShare(ctx, db.getItemRecord('item-pending')!, '1d', request()),
    /finish saving/i,
  );
});

test('a single item is limited to eight active links', async (t) => {
  const { db, settings } = await withStore(t);
  addItem(db, 'item-photo');
  const ctx = { db, settings } as unknown as AppContext;
  const item = db.getItemRecord('item-photo')!;

  for (let index = 0; index < MAX_ACTIVE_SHARES; index++) {
    createShare(ctx, item, '7d', request());
  }
  assert.equal(db.countActiveShares(item.id), MAX_ACTIVE_SHARES);
  assert.throws(() => createShare(ctx, item, '7d', request()), /active links/i);

  db.revokeShare(db.listShares(item.id)[0].id);
  assert.doesNotThrow(() => createShare(ctx, item, '7d', request()));
});

test('expiry helpers map options to timestamps and defaults', () => {
  assert.equal(parseShareExpiry('30d'), '30d');
  assert.equal(parseShareExpiry('bogus'), '7d');
  assert.equal(parseShareExpiry(undefined), '7d');

  const from = 1_000_000;
  assert.equal(expiryToTimestamp('never', from), null);
  assert.equal(expiryToTimestamp('1d', from), from + SHARE_EXPIRY_MS['1d']);
  assert.equal(expiryToTimestamp('90d', from), from + SHARE_EXPIRY_MS['90d']);
});

test('telemetry payload contains only coarse buckets and no names', () => {
  const payload = buildTelemetryPayload(
    'a'.repeat(32),
    {
      getStats: () => ({
        itemCount: 1234,
        photoCount: 0,
        videoCount: 42,
        fileCount: 1001,
        usedBytes: 5.5 * 1024 * 1024 * 1024,
        favorites: 10,
        trashCount: 0,
        trashBytes: 0,
        usedBytesLabel: '',
      }),
    } as unknown as Database,
    { activeProvider: 'github' } as unknown as VaultSettings,
  );

  assert.deepEqual(payload.library, {
    items: '1k-10k',
    photos: '0',
    videos: '10-99',
    files: '1k-10k',
    size: '1-10 GB',
  });
  assert.equal(payload.storage, 'github');
  assert.equal(payload.version, config.version);
  assert.deepEqual(payload.features, ['public-links', 'pwa']);

  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes('holiday'), false);
  assert.equal(serialized.includes('vault'), false);
  assert.equal(serialized.includes('1234'), false);
});

test('telemetry is a no-op until opted in and configured', async () => {
  let attempts = 0;
  let fetches = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    const makeSettings = (enabled: boolean, configured: boolean) => ({
      onboarded: true,
      telemetryConfigured: configured,
      telemetryView: () => ({
        enabled,
        configured,
        installId: null,
        lastSentAt: null,
        lastError: null,
      }),
      telemetryLastAttemptAt: null,
      getOrCreateTelemetryInstallId: () => 'a'.repeat(32),
      markTelemetryAttempt: () => {
        attempts += 1;
      },
      markTelemetrySuccess: () => {},
      markTelemetryError: () => {},
    });

    const disabled = new TelemetryService(
      {
        getStats: () => ({
          itemCount: 1,
          photoCount: 1,
          videoCount: 0,
          fileCount: 0,
          usedBytes: 100,
          favorites: 0,
          trashCount: 0,
          trashBytes: 0,
        }),
      } as unknown as Database,
      makeSettings(false, true) as unknown as VaultSettings,
    );
    await disabled.sendNow();
    assert.equal(attempts, 0);
    assert.equal(fetches, 0);

    const unconfigured = new TelemetryService(
      {
        getStats: () => ({
          itemCount: 1,
          photoCount: 1,
          videoCount: 0,
          fileCount: 0,
          usedBytes: 100,
          favorites: 0,
          trashCount: 0,
          trashBytes: 0,
        }),
      } as unknown as Database,
      makeSettings(true, false) as unknown as VaultSettings,
    );
    await unconfigured.sendNow();
    assert.equal(attempts, 0);
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('telemetry sends one coarse heartbeat and respects the daily gap', async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = config.telemetryUrl;
  const body: Record<string, unknown> = {};
  let fetches = 0;
  let attempts = 0;
  let successes = 0;
  let lastAttemptAt: number | null = null;

  config.telemetryUrl = 'https://telemetry.example.test/heartbeat';
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    fetches += 1;
    Object.assign(body, JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  const settings = {
    onboarded: true,
    telemetryConfigured: true,
    activeProvider: 'local',
    telemetryView: () => ({
      enabled: true,
      configured: true,
      installId: 'a'.repeat(32),
      lastSentAt: null,
      lastError: null,
    }),
    get telemetryLastAttemptAt() {
      return lastAttemptAt;
    },
    getOrCreateTelemetryInstallId: () => 'a'.repeat(32),
    markTelemetryAttempt: () => {
      attempts += 1;
      lastAttemptAt = Date.now();
    },
    markTelemetrySuccess: () => {
      successes += 1;
    },
    markTelemetryError: () => {},
  };

  const db = {
    getStats: () => ({
      itemCount: 5,
      photoCount: 3,
      videoCount: 1,
      fileCount: 1,
      usedBytes: 250 * 1024 * 1024,
      favorites: 0,
      trashCount: 0,
      trashBytes: 0,
    }),
  };

  try {
    const service = new TelemetryService(db as unknown as Database, settings as unknown as VaultSettings);
    await service.sendNow();

    assert.equal(fetches, 1);
    assert.equal(attempts, 1);
    assert.equal(successes, 1);
    assert.equal(body.installId, 'a'.repeat(32));
    assert.equal(body.storage, 'local');
    assert.deepEqual(body.library, {
      items: '1-9',
      photos: '1-9',
      videos: '1-9',
      files: '1-9',
      size: '100 MB-1 GB',
    });

    await service.sendNow();
    assert.equal(fetches, 1, 'a second call within 24 hours is skipped');
  } finally {
    globalThis.fetch = originalFetch;
    config.telemetryUrl = originalUrl;
  }
});
