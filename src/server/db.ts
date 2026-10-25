import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CacheStats,
  FolderDTO,
  ItemDTO,
  ItemKind,
  ItemStatus,
  ProviderId,
  StorageStats,
  SortMode,
} from '../../shared/types.js';

export interface DbItem {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: ItemKind;
  hash: string;
  provider: ProviderId;
  locator: string | null;
  status: ItemStatus;
  error: string | null;
  attempts: number;
  temp_path: string | null;
  poster_path: string | null;
  thumb_key: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  taken_at: number | null;
  created_at: number;
  updated_at: number;
  trashed_at: number | null;
  favorite: number;
  folder_id: string | null;
}

export interface DbFolder {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: number;
  updated_at: number;
}

interface FolderRow extends DbFolder {
  item_count: number;
  folder_count: number;
  size: number;
}

interface ItemRow extends DbItem {
  cache_complete: number | null;
  cache_pinned: number | null;
  cache_error: string | null;
}

export interface CacheEntryRow {
  key: string;
  kind: 'blob' | 'preview';
  size: number;
  complete: number;
  pinned: number;
  error: string | null;
  created_at: number;
  last_access: number;
}

export interface ListItemsOptions {
  section?: 'all' | 'photos' | 'videos' | 'files' | 'favorites' | 'trash';
  q?: string;
  sort?: SortMode;
  limit?: number;
  offset?: number;
  /** When inFolder is true, restrict to this folder (null = the root). */
  folderId?: string | null;
  inFolder?: boolean;
}

const ITEM_SELECT = `
  SELECT i.*,
    c.complete AS cache_complete,
    c.pinned AS cache_pinned,
    c.error AS cache_error
  FROM items i
  LEFT JOIN cache_entries c ON c.key = i.id AND c.kind = 'blob'
`;

function mapItem(row: ItemRow): ItemDTO {
  return {
    id: row.id,
    name: row.name,
    size: row.size,
    mime: row.mime,
    kind: row.kind,
    status: row.status,
    error: row.error ?? null,
    provider: row.provider,
    folderId: row.folder_id ?? null,
    width: row.width ?? null,
    height: row.height ?? null,
    duration: row.duration ?? null,
    takenAt: row.taken_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    favorite: row.favorite === 1,
    trashedAt: row.trashed_at ?? null,
    hasThumb: Boolean(row.thumb_key),
    cached: row.provider === 'local' || row.cache_complete === 1,
    pinned: row.cache_pinned === 1,
    cacheError: row.cache_error ?? null,
  };
}

function mapFolder(row: FolderRow): FolderDTO {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parent_id ?? null,
    itemCount: asNumber(row.item_count),
    folderCount: asNumber(row.folder_count),
    size: asNumber(row.size),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

export class Database {
  readonly sqlite: DatabaseSync;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.sqlite = new DatabaseSync(dbPath);
    this.sqlite.exec('PRAGMA journal_mode = WAL;');
    this.sqlite.exec('PRAGMA synchronous = NORMAL;');
    this.sqlite.exec('PRAGMA foreign_keys = ON;');
    this.sqlite.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  private migrate(): void {
    const versionRow = this.sqlite.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    const version = versionRow?.user_version ?? 0;
    if (version > 2) {
      throw new Error(`Database schema version ${version} is newer than this app supports.`);
    }
    if (version === 0) {
      this.sqlite.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          user_agent TEXT
        );
        CREATE TABLE IF NOT EXISTS items (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          size INTEGER NOT NULL,
          mime TEXT NOT NULL,
          kind TEXT NOT NULL,
          hash TEXT NOT NULL DEFAULT '',
          provider TEXT NOT NULL,
          locator TEXT,
          status TEXT NOT NULL DEFAULT 'receiving',
          error TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          temp_path TEXT,
          poster_path TEXT,
          thumb_key TEXT,
          width INTEGER,
          height INTEGER,
          duration REAL,
          taken_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          trashed_at INTEGER,
          favorite INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_items_list ON items (trashed_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_items_status ON items (status);
        CREATE INDEX IF NOT EXISTS idx_items_kind ON items (kind);
        CREATE INDEX IF NOT EXISTS idx_items_hash ON items (hash);
        CREATE TABLE IF NOT EXISTS cache_entries (
          key TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          size INTEGER NOT NULL DEFAULT 0,
          complete INTEGER NOT NULL DEFAULT 0,
          pinned INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at INTEGER NOT NULL,
          last_access INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_cache_kind ON cache_entries (kind, complete, pinned, last_access);
        PRAGMA user_version = 1;
        COMMIT;
      `);
    }
    if (version < 2) {
      this.sqlite.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS folders (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_parent_name
          ON folders (COALESCE(parent_id, ''), name COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders (parent_id);
        ALTER TABLE items ADD COLUMN folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_items_folder ON items (folder_id);
        PRAGMA user_version = 2;
        COMMIT;
      `);
    }
    this.sqlite.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  }

  close(): void {
    this.sqlite.close();
  }

  // ---------------------------------------------------------------- settings

  getSetting(key: string): string | null {
    const row = this.sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.sqlite
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  deleteSetting(key: string): void {
    this.sqlite.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  // ---------------------------------------------------------------- sessions

  createSession(id: string, expiresAt: number, userAgent: string | null): void {
    this.sqlite
      .prepare('INSERT INTO sessions (id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)')
      .run(id, Date.now(), expiresAt, userAgent);
  }

  getSession(id: string): { id: string; expires_at: number } | null {
    const row = this.sqlite
      .prepare('SELECT id, expires_at FROM sessions WHERE id = ? AND expires_at > ?')
      .get(id, Date.now()) as { id: string; expires_at: number } | undefined;
    return row ?? null;
  }

  deleteSession(id: string): void {
    this.sqlite.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  deleteAllSessions(): void {
    this.sqlite.prepare('DELETE FROM sessions').run();
  }

  pruneSessions(): void {
    this.sqlite.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  }

  // ------------------------------------------------------------------- items

  createItem(item: {
    id: string;
    name: string;
    size: number;
    mime: string;
    kind: ItemKind;
    provider: ProviderId;
    status: ItemStatus;
    tempPath: string;
    takenAt: number | null;
    folderId?: string | null;
  }): void {
    const timestamp = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO items
          (id, name, size, mime, kind, hash, provider, status, temp_path, taken_at, folder_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.name,
        item.size,
        item.mime,
        item.kind,
        item.provider,
        item.status,
        item.tempPath,
        item.takenAt,
        item.folderId ?? null,
        timestamp,
        timestamp,
      );
  }

  getItemRecord(id: string): DbItem | null {
    const row = this.sqlite.prepare('SELECT * FROM items WHERE id = ?').get(id) as unknown as DbItem | undefined;
    return row ?? null;
  }

  getItem(id: string): ItemDTO | null {
    const row = this.sqlite.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id) as unknown as ItemRow | undefined;
    return row ? mapItem(row) : null;
  }

  updateItem(
    id: string,
    patch: Partial<{
      name: string;
      size: number;
      hash: string;
      locator: string | null;
      status: ItemStatus;
      error: string | null;
      attempts: number;
      temp_path: string | null;
      poster_path: string | null;
      thumb_key: string | null;
      width: number | null;
      height: number | null;
      duration: number | null;
      trashed_at: number | null;
      favorite: number;
      folder_id: string | null;
    }>,
  ): void {
    const columns = Object.keys(patch);
    if (columns.length === 0) return;
    const allowed = new Set([
      'name',
      'size',
      'hash',
      'locator',
      'status',
      'error',
      'attempts',
      'temp_path',
      'poster_path',
      'thumb_key',
      'width',
      'height',
      'duration',
      'trashed_at',
      'favorite',
      'folder_id',
    ]);
    const safeColumns = columns.filter((column) => allowed.has(column));
    if (safeColumns.length === 0) return;
    const assignments = safeColumns.map((column) => `${column} = ?`).join(', ');
    const values = safeColumns.map((column) => (patch as Record<string, SQLInputValue>)[column]);
    this.sqlite
      .prepare(`UPDATE items SET ${assignments}, updated_at = ? WHERE id = ?`)
      .run(...values, Date.now(), id);
  }

  deleteItemRow(id: string): void {
    this.sqlite.prepare('DELETE FROM items WHERE id = ?').run(id);
  }

  listItems(options: ListItemsOptions): { items: ItemDTO[]; total: number; hasMore: boolean } {
    const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 60)));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const section = options.section ?? 'all';
    const clauses: string[] = [`i.status != 'receiving'`];
    const params: SQLInputValue[] = [];

    if (section === 'trash') {
      clauses.push('i.trashed_at IS NOT NULL');
    } else {
      clauses.push('i.trashed_at IS NULL');
    }
    if (section === 'photos') clauses.push(`i.kind = 'photo'`);
    if (section === 'videos') clauses.push(`i.kind = 'video'`);
    if (section === 'files') clauses.push(`i.kind = 'file'`);
    if (section === 'favorites') clauses.push('i.favorite = 1');
    if (options.inFolder) {
      if (options.folderId) {
        clauses.push('i.folder_id = ?');
        params.push(options.folderId);
      } else {
        clauses.push('i.folder_id IS NULL');
      }
    }

    const query = options.q?.trim();
    if (query) {
      const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
      clauses.push(`i.name LIKE ? ESCAPE '\\'`);
      params.push(`%${escaped}%`);
    }

    const sort: SortMode = options.sort ?? 'newest';
    const orderBy =
      section === 'trash'
        ? 'i.trashed_at DESC, i.created_at DESC'
        : sort === 'oldest'
          ? 'COALESCE(i.taken_at, i.created_at) ASC, i.created_at ASC'
          : sort === 'name'
            ? 'i.name COLLATE NOCASE ASC'
            : sort === 'largest'
              ? 'i.size DESC, i.created_at DESC'
              : 'COALESCE(i.taken_at, i.created_at) DESC, i.created_at DESC';

    const where = clauses.join(' AND ');
    const totalRow = this.sqlite
      .prepare(`SELECT COUNT(*) AS count FROM items i WHERE ${where}`)
      .get(...params) as { count: number } | undefined;
    const total = asNumber(totalRow?.count);

    const rows = this.sqlite
      .prepare(`${ITEM_SELECT} WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, limit + 1, offset) as unknown as ItemRow[];
    const hasMore = rows.length > limit;
    return { items: rows.slice(0, limit).map(mapItem), total, hasMore };
  }

  listProcessing(): DbItem[] {
    return this.sqlite
      .prepare(`SELECT * FROM items WHERE status IN ('queued', 'uploading') ORDER BY created_at ASC`)
      .all() as unknown as DbItem[];
  }

  listTrashed(limit = 1000): DbItem[] {
    return this.sqlite
      .prepare(`SELECT * FROM items WHERE trashed_at IS NOT NULL ORDER BY trashed_at ASC LIMIT ?`)
      .all(limit) as unknown as DbItem[];
  }

  listStaleReceiving(cutoff: number): DbItem[] {
    return this.sqlite
      .prepare(`SELECT * FROM items WHERE status = 'receiving' AND created_at < ?`)
      .all(cutoff) as unknown as DbItem[];
  }

  listPurgeableTrash(cutoff: number): DbItem[] {
    return this.sqlite
      .prepare(`SELECT * FROM items WHERE trashed_at IS NOT NULL AND trashed_at < ?`)
      .all(cutoff) as unknown as DbItem[];
  }

  getStats(): StorageStats {
    const base = `status != 'receiving' AND trashed_at IS NULL`;
    const row = this.sqlite
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status = 'ready' THEN size ELSE 0 END), 0) AS usedBytes,
           COUNT(*) AS itemCount,
           SUM(CASE WHEN kind = 'photo' THEN 1 ELSE 0 END) AS photoCount,
           SUM(CASE WHEN kind = 'video' THEN 1 ELSE 0 END) AS videoCount,
           SUM(CASE WHEN kind = 'file' THEN 1 ELSE 0 END) AS fileCount,
           SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END) AS favorites
         FROM items WHERE ${base}`,
      )
      .get() as Record<string, unknown> | undefined;
    const trash = this.sqlite
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(CASE WHEN status = 'ready' THEN size ELSE 0 END), 0) AS bytes
         FROM items WHERE trashed_at IS NOT NULL`,
      )
      .get() as Record<string, unknown> | undefined;
    return {
      usedBytes: asNumber(row?.usedBytes),
      itemCount: asNumber(row?.itemCount),
      photoCount: asNumber(row?.photoCount),
      videoCount: asNumber(row?.videoCount),
      fileCount: asNumber(row?.fileCount),
      favorites: asNumber(row?.favorites),
      trashCount: asNumber(trash?.count),
      trashBytes: asNumber(trash?.bytes),
    };
  }

  // ----------------------------------------------------------------- folders

  private folderSelect(parentClause: string): string {
    return `
      SELECT f.*,
        (SELECT COUNT(*) FROM items i
          WHERE i.folder_id = f.id AND i.kind = 'file' AND i.trashed_at IS NULL AND i.status != 'receiving') AS item_count,
        (SELECT COUNT(*) FROM folders c WHERE c.parent_id = f.id) AS folder_count,
        (SELECT COALESCE(SUM(i.size), 0) FROM items i
          WHERE i.folder_id = f.id AND i.kind = 'file' AND i.trashed_at IS NULL AND i.status = 'ready') AS size
      FROM folders f
      WHERE ${parentClause}
    `;
  }

  listFolders(parentId: string | null): FolderDTO[] {
    const clause = parentId === null ? 'f.parent_id IS NULL' : 'f.parent_id = ?';
    const statement = this.sqlite.prepare(
      `${this.folderSelect(clause)} ORDER BY f.name COLLATE NOCASE ASC`,
    );
    const rows = (parentId === null ? statement.all() : statement.all(parentId)) as unknown as FolderRow[];
    return rows.map(mapFolder);
  }

  getFolderRecord(id: string): DbFolder | null {
    const row = this.sqlite.prepare('SELECT * FROM folders WHERE id = ?').get(id) as unknown as DbFolder | undefined;
    return row ?? null;
  }

  getFolder(id: string): FolderDTO | null {
    const row = this.sqlite.prepare(this.folderSelect('f.id = ?')).get(id) as unknown as FolderRow | undefined;
    return row ? mapFolder(row) : null;
  }

  listFolderRecords(): DbFolder[] {
    return this.sqlite
      .prepare('SELECT * FROM folders ORDER BY name COLLATE NOCASE ASC')
      .all() as unknown as DbFolder[];
  }

  createFolder(id: string, name: string, parentId: string | null): DbFolder {
    const timestamp = Date.now();
    this.sqlite
      .prepare('INSERT INTO folders (id, name, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, name, parentId, timestamp, timestamp);
    return { id, name, parent_id: parentId, created_at: timestamp, updated_at: timestamp };
  }

  renameFolder(id: string, name: string): void {
    this.sqlite.prepare('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id);
  }

  folderNameExists(parentId: string | null, name: string, excludeId?: string): boolean {
    const row = this.sqlite
      .prepare(
        `SELECT 1 AS found FROM folders
         WHERE COALESCE(parent_id, '') = COALESCE(?, '')
           AND name = ? COLLATE NOCASE
           AND id != ?
         LIMIT 1`,
      )
      .get(parentId, name, excludeId ?? '') as { found?: number } | undefined;
    return Boolean(row);
  }

  folderPath(id: string): Array<{ id: string; name: string }> {
    const path: Array<{ id: string; name: string }> = [];
    let current = this.getFolderRecord(id);
    const seen = new Set<string>();
    for (let depth = 0; current && depth < 100; depth += 1) {
      if (seen.has(current.id)) break;
      seen.add(current.id);
      path.unshift({ id: current.id, name: current.name });
      current = current.parent_id ? this.getFolderRecord(current.parent_id) : null;
    }
    return path;
  }

  deleteFolderTree(id: string): { folders: number; trashedItems: number } {
    const rows = this.sqlite
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT id FROM folders WHERE id = ?
           UNION ALL
           SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id
         )
         SELECT id FROM tree`,
      )
      .all(id) as Array<{ id: string }>;
    if (rows.length === 0) return { folders: 0, trashedItems: 0 };
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(', ');
    const timestamp = Date.now();
    const trashed = this.sqlite
      .prepare(
        `UPDATE items SET trashed_at = ?, folder_id = NULL, updated_at = ?
         WHERE folder_id IN (${placeholders}) AND trashed_at IS NULL`,
      )
      .run(timestamp, timestamp, ...ids);
    this.sqlite.prepare(`DELETE FROM folders WHERE id IN (${placeholders})`).run(...ids);
    return { folders: ids.length, trashedItems: Number(trashed.changes) };
  }

  moveItemsToFolder(ids: string[], folderId: string | null): number {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(', ');
    const result = this.sqlite
      .prepare(
        `UPDATE items SET folder_id = ?, updated_at = ?
         WHERE id IN (${placeholders}) AND kind = 'file' AND trashed_at IS NULL`,
      )
      .run(folderId, Date.now(), ...ids);
    return Number(result.changes);
  }

  listAllItems(limit = 100_000): DbItem[] {
    return this.sqlite
      .prepare('SELECT * FROM items ORDER BY created_at ASC LIMIT ?')
      .all(limit) as unknown as DbItem[];
  }

  /** Removes every user-owned row while keeping the schema ready for onboarding. */
  resetLibraryData(): void {
    this.sqlite.exec('BEGIN;');
    try {
      this.sqlite.prepare('DELETE FROM items').run();
      this.sqlite.prepare('DELETE FROM folders').run();
      this.sqlite.prepare('DELETE FROM cache_entries').run();
      this.sqlite.prepare('DELETE FROM sessions').run();
      this.sqlite.prepare('DELETE FROM settings').run();
      this.sqlite.exec('COMMIT;');
    } catch (error) {
      this.sqlite.exec('ROLLBACK;');
      throw error;
    }
  }

  // ------------------------------------------------------------------- cache

  getCacheEntry(key: string): CacheEntryRow | null {
    const row = this.sqlite.prepare('SELECT * FROM cache_entries WHERE key = ?').get(key) as
      | unknown as CacheEntryRow
      | undefined;
    return row ?? null;
  }

  upsertCacheEntry(entry: {
    key: string;
    kind: 'blob' | 'preview';
    size?: number;
    complete?: boolean;
    pinned?: boolean;
    error?: string | null;
  }): void {
    const timestamp = Date.now();
    this.sqlite
      .prepare(
        `INSERT INTO cache_entries (key, kind, size, complete, pinned, error, created_at, last_access)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           size = excluded.size,
           complete = excluded.complete,
           pinned = excluded.pinned,
           error = excluded.error,
           last_access = excluded.last_access`,
      )
      .run(
        entry.key,
        entry.kind,
        entry.size ?? 0,
        entry.complete ? 1 : 0,
        entry.pinned ? 1 : 0,
        entry.error ?? null,
        timestamp,
        timestamp,
      );
  }

  markCacheComplete(key: string, size: number): void {
    this.sqlite
      .prepare('UPDATE cache_entries SET complete = 1, size = ?, error = NULL, last_access = ? WHERE key = ?')
      .run(size, Date.now(), key);
  }

  markCacheFailed(key: string, error: string): void {
    this.sqlite.prepare('UPDATE cache_entries SET complete = 0, error = ? WHERE key = ?').run(error, key);
  }

  touchCacheEntry(key: string): void {
    this.sqlite.prepare('UPDATE cache_entries SET last_access = ? WHERE key = ?').run(Date.now(), key);
  }

  deleteCacheEntry(key: string): void {
    this.sqlite.prepare('DELETE FROM cache_entries WHERE key = ?').run(key);
  }

  listCacheEntries(kind?: 'blob' | 'preview'): CacheEntryRow[] {
    if (kind) {
      return this.sqlite.prepare('SELECT * FROM cache_entries WHERE kind = ? ORDER BY last_access ASC').all(kind) as unknown as CacheEntryRow[];
    }
    return this.sqlite.prepare('SELECT * FROM cache_entries ORDER BY last_access ASC').all() as unknown as CacheEntryRow[];
  }

  listEvictable(limit: number): CacheEntryRow[] {
    return this.sqlite
      .prepare(
        `SELECT * FROM cache_entries
         WHERE kind = 'blob' AND complete = 1 AND pinned = 0
         ORDER BY last_access ASC LIMIT ?`,
      )
      .all(limit) as unknown as CacheEntryRow[];
  }

  clearCacheRows(kind?: 'blob' | 'preview', includePinned = true): CacheEntryRow[] {
    const rows = kind
      ? (this.sqlite
          .prepare(`SELECT * FROM cache_entries WHERE kind = ? ${includePinned ? '' : 'AND pinned = 0'}`)
          .all(kind) as unknown as CacheEntryRow[])
      : (this.sqlite
          .prepare(`SELECT * FROM cache_entries ${includePinned ? '' : 'WHERE pinned = 0'}`)
          .all() as unknown as CacheEntryRow[]);
    if (kind) {
      this.sqlite
        .prepare(`DELETE FROM cache_entries WHERE kind = ? ${includePinned ? '' : 'AND pinned = 0'}`)
        .run(kind);
    } else {
      this.sqlite.prepare(`DELETE FROM cache_entries ${includePinned ? '' : 'WHERE pinned = 0'}`).run();
    }
    return rows;
  }

  getCacheStats(limitMB: number): CacheStats {
    const rows = this.sqlite
      .prepare(
        `SELECT kind, COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS count,
                COALESCE(SUM(CASE WHEN pinned = 1 THEN size ELSE 0 END), 0) AS pinned_bytes,
                SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) AS pinned_count
         FROM cache_entries WHERE complete = 1
         GROUP BY kind`,
      )
      .all() as unknown as Array<{
      kind: string;
      bytes: number;
      count: number;
      pinned_bytes: number;
      pinned_count: number;
    }>;
    let blobBytes = 0;
    let blobCount = 0;
    let previewBytes = 0;
    let pinnedBytes = 0;
    let pinnedCount = 0;
    for (const row of rows) {
      if (row.kind === 'blob') {
        blobBytes += asNumber(row.bytes);
        blobCount += asNumber(row.count);
      } else if (row.kind === 'preview') {
        previewBytes += asNumber(row.bytes);
      }
      pinnedBytes += asNumber(row.pinned_bytes);
      pinnedCount += asNumber(row.pinned_count);
    }
    return {
      encrypted: false,
      limitMB,
      autoCache: false,
      blobBytes,
      blobCount,
      previewBytes,
      pinnedBytes,
      pinnedCount,
    };
  }
}
