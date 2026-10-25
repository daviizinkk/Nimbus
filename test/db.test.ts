import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Database } from '../src/server/db.js';

async function withDatabase(t: test.TestContext): Promise<Database> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nimbus-db-'));
  const db = new Database(path.join(dir, 'nimbus.db'));
  t.after(() => {
    db.close();
    void rm(dir, { recursive: true, force: true });
  });
  return db;
}

function addItem(
  db: Database,
  id: string,
  name: string,
  kind: 'photo' | 'video' | 'file',
  options: { status?: 'ready' | 'receiving'; size?: number; takenAt?: number | null } = {},
): void {
  const status = options.status ?? 'ready';
  db.createItem({
    id,
    name,
    size: options.size ?? 1024,
    mime: kind === 'photo' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'text/plain',
    kind,
    provider: 'local',
    status,
    tempPath: `tmp/${id}`,
    takenAt: options.takenAt ?? null,
  });
  if (status === 'ready') {
    db.updateItem(id, {
      status: 'ready',
      size: options.size ?? 1024,
      locator: JSON.stringify({ path: `${id}.bin` }),
      hash: 'a'.repeat(64),
    });
  }
}

test('receiving items are hidden until the upload finishes', async (t) => {
  const db = await withDatabase(t);
  addItem(db, '018f0000-0000-7000-8000-000000000001', 'pending.jpg', 'photo', { status: 'receiving' });

  assert.equal(db.listItems({}).total, 0);
  assert.equal(db.getStats().itemCount, 0);

  db.updateItem('018f0000-0000-7000-8000-000000000001', { status: 'ready' });
  assert.equal(db.listItems({}).total, 1);
  assert.equal(db.getStats().itemCount, 1);
});

test('sections, sorting, and LIKE search behave predictably', async (t) => {
  const db = await withDatabase(t);
  addItem(db, 'id-photo', 'Beach 100%.jpg', 'photo', { size: 4000, takenAt: 2_000 });
  addItem(db, 'id-underscore', 'notes_final.txt', 'file', { size: 300 });
  addItem(db, 'id-lookalike', 'notesXfinal.txt', 'file', { size: 100 });
  addItem(db, 'id-video', 'clip.mp4', 'video', { size: 9000, takenAt: 1_000 });
  db.updateItem('id-photo', { favorite: 1 });
  db.updateItem('id-video', { trashed_at: Date.now() });

  assert.deepEqual(
    db.listItems({ section: 'all' }).items.map((item) => item.name).sort(),
    ['Beach 100%.jpg', 'notesXfinal.txt', 'notes_final.txt'],
  );
  assert.deepEqual(
    db.listItems({ q: 'notes_' }).items.map((item) => item.name),
    ['notes_final.txt'],
  );
  assert.deepEqual(db.listItems({ q: '100%' }).items.map((item) => item.name), ['Beach 100%.jpg']);
  assert.deepEqual(db.listItems({ section: 'favorites' }).items.map((item) => item.name), ['Beach 100%.jpg']);
  assert.deepEqual(db.listItems({ section: 'trash' }).items.map((item) => item.name), ['clip.mp4']);
  assert.deepEqual(
    db.listItems({ sort: 'largest' }).items.map((item) => item.name),
    ['Beach 100%.jpg', 'notes_final.txt', 'notesXfinal.txt'],
  );
  assert.deepEqual(
    db.listItems({ sort: 'name' }).items.map((item) => item.name),
    ['Beach 100%.jpg', 'notes_final.txt', 'notesXfinal.txt'],
  );

  const page = db.listItems({ limit: 2 });
  assert.equal(page.items.length, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.total, 3);
});

test('folders group files, nest, and move their contents to trash', async (t) => {
  const db = await withDatabase(t);
  db.createFolder('folder-work', 'Work', null);
  db.createFolder('folder-personal', 'Personal', null);
  db.createFolder('folder-invoices', 'Invoices', 'folder-work');

  addItem(db, 'file-invoice', 'invoice.pdf', 'file', { size: 2048 });
  addItem(db, 'file-root', 'readme.txt', 'file', { size: 512 });
  addItem(db, 'photo-work', 'team.jpg', 'photo');

  db.updateItem('file-invoice', { folder_id: 'folder-work' });
  db.updateItem('file-root', { folder_id: 'folder-invoices' });

  assert.deepEqual(
    db.listFolders(null).map((folder) => folder.name),
    ['Personal', 'Work'],
  );
  assert.deepEqual(
    db.listFolders('folder-work').map((folder) => folder.name),
    ['Invoices'],
  );
  assert.deepEqual(
    db.listItems({ section: 'files', inFolder: true, folderId: null }).items.map((item) => item.id),
    [],
  );
  assert.deepEqual(
    db.listItems({ section: 'files', inFolder: true, folderId: 'folder-work' }).items.map((item) => item.id),
    ['file-invoice'],
  );

  const work = db.getFolder('folder-work');
  assert.equal(work?.itemCount, 1);
  assert.equal(work?.folderCount, 1);
  assert.equal(work?.size, 2048);
  assert.equal(db.folderNameExists(null, 'work'), true);
  assert.equal(db.folderNameExists(null, 'WORK', 'folder-work'), false);
  assert.deepEqual(
    db.folderPath('folder-invoices').map((segment) => segment.name),
    ['Work', 'Invoices'],
  );

  assert.equal(db.moveItemsToFolder(['file-invoice', 'photo-work'], null), 1);
  assert.equal(db.getItem('photo-work')?.folderId, null);
  assert.equal(db.getItem('file-invoice')?.folderId, null);

  db.updateItem('file-invoice', { folder_id: 'folder-work' });
  const deleted = db.deleteFolderTree('folder-work');
  assert.equal(deleted.folders, 2);
  assert.equal(deleted.trashedItems, 2);
  assert.equal(db.getFolderRecord('folder-work'), null);
  assert.equal(db.getFolderRecord('folder-invoices'), null);
  assert.ok(db.getItem('file-invoice')?.trashedAt);
  assert.ok(db.getItem('file-root')?.trashedAt);
  assert.equal(db.listFolders(null).length, 1);
});

test('stats separate active and trashed content', async (t) => {
  const db = await withDatabase(t);
  addItem(db, 'id-photo', 'photo.jpg', 'photo', { size: 4000 });
  addItem(db, 'id-video', 'video.mp4', 'video', { size: 9000 });
  addItem(db, 'id-file', 'notes.txt', 'file', { size: 300 });
  db.updateItem('id-photo', { favorite: 1 });
  db.updateItem('id-video', { trashed_at: Date.now() });

  const stats = db.getStats();
  assert.equal(stats.usedBytes, 4300);
  assert.equal(stats.itemCount, 2);
  assert.equal(stats.photoCount, 1);
  assert.equal(stats.videoCount, 0);
  assert.equal(stats.fileCount, 1);
  assert.equal(stats.favorites, 1);
  assert.equal(stats.trashCount, 1);
  assert.equal(stats.trashBytes, 9000);
});

test('cache rows overlay item state and keep pinned rows when evicting', async (t) => {
  const db = await withDatabase(t);
  addItem(db, 'id-photo', 'photo.jpg', 'photo', { size: 5000 });
  addItem(db, 'id-file', 'notes.txt', 'file', { size: 200 });

  db.upsertCacheEntry({ key: 'id-photo', kind: 'blob', size: 5000, complete: true, pinned: true });
  db.upsertCacheEntry({ key: 'id-file', kind: 'blob', size: 200, complete: true });
  db.upsertCacheEntry({ key: 'thumb:id-photo', kind: 'preview', size: 80, complete: true });
  db.updateItem('id-photo', { thumb_key: 'thumb:id-photo' });

  const photo = db.getItem('id-photo');
  assert.equal(photo?.cached, true);
  assert.equal(photo?.pinned, true);
  assert.equal(photo?.hasThumb, true);

  const stats = db.getCacheStats(100);
  assert.equal(stats.blobBytes, 5200);
  assert.equal(stats.blobCount, 2);
  assert.equal(stats.previewBytes, 80);
  assert.equal(stats.pinnedBytes, 5000);
  assert.equal(stats.pinnedCount, 1);

  const evicted = db.clearCacheRows('blob', false);
  assert.deepEqual(evicted.map((row) => row.key), ['id-file']);
  assert.deepEqual(db.listCacheEntries('blob').map((row) => row.key), ['id-photo']);

  const all = db.clearCacheRows();
  assert.equal(all.length, 2);
  assert.equal(db.listCacheEntries().length, 0);
});

test('stale receiving rows can be found by age', async (t) => {
  const db = await withDatabase(t);
  addItem(db, 'id-old', 'old.jpg', 'photo', { status: 'receiving' });
  addItem(db, 'id-new', 'new.jpg', 'photo', { status: 'receiving' });

  assert.equal(db.listStaleReceiving(Date.now() + 60_000).length, 2);
  assert.equal(db.listStaleReceiving(Date.now() - 60_000).length, 0);
});
