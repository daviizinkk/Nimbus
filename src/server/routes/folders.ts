import type { FolderDTO } from '../../../shared/types.js';
import type { AppContext } from '../context.js';
import type { DbFolder } from '../db.js';
import { ApiError, safeFilename, uid } from '../utils.js';

const MAX_FOLDER_DEPTH = 20;
const MAX_FOLDER_NAME = 120;

function queryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function parseName(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, 'Enter a folder name.');
  if (/[\\/]/.test(value)) throw new ApiError(400, 'Folder names cannot contain slashes.');
  const name = safeFilename(value, '').trim();
  if (!name) throw new ApiError(400, 'Enter a folder name.');
  if (name.length > MAX_FOLDER_NAME) {
    throw new ApiError(400, `Folder names are limited to ${MAX_FOLDER_NAME} characters.`);
  }
  return name;
}

function parseParent(value: unknown): string | null {
  if (value === undefined || value === null || value === '' || value === 'root') return null;
  if (typeof value !== 'string') throw new ApiError(400, 'Invalid parent folder.');
  return value;
}

export function registerFolderRoutes(ctx: AppContext): void {
  const { app, db } = ctx;

  const requireFolder = (id: string): DbFolder => {
    const folder = db.getFolderRecord(id);
    if (!folder) throw new ApiError(404, 'Folder not found.');
    return folder;
  };

  app.get('/api/folders', async (request) => {
    const raw = request.query as Record<string, unknown>;
    const parentId = parseParent(queryValue(raw.parent));
    if (parentId) requireFolder(parentId);
    const folders = db.listFolders(parentId);
    const path = parentId ? db.folderPath(parentId) : [];
    return { folders, path };
  });

  app.get('/api/folders/tree', async () => {
    const records = db.listFolderRecords();
    const byId = new Map(records.map((record) => [record.id, record]));
    const pathCache = new Map<string, string>();

    const pathFor = (folder: DbFolder): string => {
      const cached = pathCache.get(folder.id);
      if (cached !== undefined) return cached;
      const parts: string[] = [];
      const seen = new Set<string>();
      let current: DbFolder | undefined = folder;
      for (let depth = 0; current && depth < MAX_FOLDER_DEPTH + 5; depth += 1) {
        if (seen.has(current.id)) break;
        seen.add(current.id);
        parts.unshift(current.name);
        current = current.parent_id ? byId.get(current.parent_id) : undefined;
      }
      const value = parts.join(' / ');
      pathCache.set(folder.id, value);
      return value;
    };

    const folders: FolderDTO[] = [];
    for (const record of records) {
      const dto = db.getFolder(record.id);
      if (dto) folders.push({ ...dto, path: pathFor(record) });
    }
    folders.sort((left, right) =>
      (left.path ?? left.name).localeCompare(right.path ?? right.name, undefined, { sensitivity: 'base' }),
    );

    return { folders };
  });

  app.post('/api/folders', async (request, reply) => {
    const body = (request.body ?? {}) as { name?: unknown; parentId?: unknown };
    const name = parseName(body.name);
    const parentId = parseParent(body.parentId);
    if (parentId) {
      requireFolder(parentId);
      const depth = db.folderPath(parentId).length;
      if (depth >= MAX_FOLDER_DEPTH) {
        throw new ApiError(400, `Folders can be nested up to ${MAX_FOLDER_DEPTH} levels deep.`);
      }
    }
    if (db.folderNameExists(parentId, name)) {
      throw new ApiError(409, 'A folder with that name already exists here.');
    }
    const id = uid();
    db.createFolder(id, name, parentId);
    return reply.code(201).send({ folder: db.getFolder(id) });
  });

  app.patch('/api/folders/:id', async (request) => {
    const { id } = request.params as { id: string };
    const folder = requireFolder(id);
    const body = (request.body ?? {}) as { name?: unknown };
    const name = parseName(body.name);
    if (db.folderNameExists(folder.parent_id, name, folder.id)) {
      throw new ApiError(409, 'A folder with that name already exists here.');
    }
    db.renameFolder(id, name);
    return { folder: db.getFolder(id) };
  });

  app.delete('/api/folders/:id', async (request) => {
    const { id } = request.params as { id: string };
    requireFolder(id);
    const result = db.deleteFolderTree(id);
    return { ok: true, ...result };
  });
}
