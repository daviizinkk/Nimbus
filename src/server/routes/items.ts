import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ItemKind, ItemQuery, SortMode } from '../../../shared/types.js';
import type { AppContext } from '../context.js';
import { purgeItem, trashItem } from '../items-service.js';
import type { DbItem } from '../db.js';
import {
  ApiError,
  contentDisposition,
  parseRange,
  safeFilename,
} from '../utils.js';

const SECTIONS = new Set(['all', 'photos', 'videos', 'files', 'favorites', 'trash']);
const SORTS = new Set(['newest', 'oldest', 'name', 'largest']);

function queryValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function itemOr404(ctx: AppContext, id: string): DbItem {
  const item = ctx.db.getItemRecord(id);
  if (!item) throw new ApiError(404, 'Item not found.');
  return item;
}

function parseLocator(raw: string | null): Record<string, unknown> {
  if (!raw) throw new ApiError(409, 'This item has not finished uploading.');
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ApiError(500, 'The stored file location is invalid.');
  }
}

function isInlineSafe(mime: string): boolean {
  return (
    mime.startsWith('image/') ||
    mime.startsWith('video/') ||
    mime.startsWith('audio/') ||
    mime === 'application/pdf'
  );
}

function parseBatchIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new ApiError(400, 'Expected a list of item IDs.');
  const ids = [...new Set(value.filter((item): item is string => typeof item === 'string'))];
  if (ids.length === 0) throw new ApiError(400, 'No items selected.');
  if (ids.length > 500) throw new ApiError(400, 'You can act on at most 500 items at once.');
  return ids;
}

function discardStream(stream: NodeJS.ReadableStream): void {
  const candidate = stream as NodeJS.ReadableStream & { destroy?: () => void };
  candidate.destroy?.();
}

export function registerItemRoutes(ctx: AppContext): void {
  const { app, db, cache, queue, getProvider } = ctx;

  app.get('/api/items', async (request) => {
    const raw = request.query as Record<string, unknown>;
    const sectionRaw = queryValue(raw.section) ?? 'all';
    const section = SECTIONS.has(sectionRaw) ? (sectionRaw as ItemQuery['section']) : 'all';
    const sortRaw = queryValue(raw.sort) ?? 'newest';
    const sort = SORTS.has(sortRaw) ? (sortRaw as SortMode) : 'newest';
    const limit = Math.min(200, Math.max(1, Number.parseInt(queryValue(raw.limit) ?? '60', 10) || 60));
    const offset = Math.max(0, Number.parseInt(queryValue(raw.offset) ?? '0', 10) || 0);
    const q = (queryValue(raw.q) ?? '').slice(0, 200);
    const folderRaw = queryValue(raw.folder);
    const inFolder = section === 'files' && folderRaw !== undefined;
    const folderId = folderRaw === 'root' || folderRaw === '' ? null : folderRaw ?? null;
    if (inFolder && folderId && !db.getFolderRecord(folderId)) {
      throw new ApiError(404, 'Folder not found.');
    }
    return db.listItems({ section, sort, limit, offset, q, inFolder, folderId });
  });

  app.get('/api/items/:id', async (request) => {
    const { id } = request.params as { id: string };
    const item = db.getItem(id);
    if (!item) throw new ApiError(404, 'Item not found.');
    return { item };
  });

  app.patch('/api/items/:id', async (request) => {
    const { id } = request.params as { id: string };
    const item = itemOr404(ctx, id);
    const body = (request.body ?? {}) as { name?: string; favorite?: boolean; folderId?: string | null };
    const patch: { name?: string; favorite?: number; folder_id?: string | null } = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string') throw new ApiError(400, 'Invalid file name.');
      const name = safeFilename(body.name, '');
      if (!name) throw new ApiError(400, 'File name cannot be empty.');
      patch.name = name;
    }
    if (body.favorite !== undefined) patch.favorite = body.favorite ? 1 : 0;
    if (body.folderId !== undefined) {
      if (item.kind !== 'file') throw new ApiError(400, 'Only files can be filed in folders.');
      if (body.folderId === null) {
        patch.folder_id = null;
      } else {
        if (typeof body.folderId !== 'string' || !body.folderId) {
          throw new ApiError(400, 'Invalid folder.');
        }
        if (!db.getFolderRecord(body.folderId)) throw new ApiError(404, 'Folder not found.');
        patch.folder_id = body.folderId;
      }
    }
    if (Object.keys(patch).length === 0) throw new ApiError(400, 'Nothing to update.');
    db.updateItem(item.id, patch);
    return { item: db.getItem(id) };
  });

  app.post('/api/items/batch', async (request) => {
    const body = (request.body ?? {}) as { ids?: unknown; action?: string; folderId?: string | null };
    const ids = parseBatchIds(body.ids);
    const action = body.action;
    if (
      action !== 'trash' &&
      action !== 'restore' &&
      action !== 'favorite' &&
      action !== 'unfavorite' &&
      action !== 'move'
    ) {
      throw new ApiError(400, 'Unknown batch action.');
    }
    if (action === 'move') {
      const folderId = body.folderId ?? null;
      if (folderId !== null) {
        if (typeof folderId !== 'string' || !db.getFolderRecord(folderId)) {
          throw new ApiError(404, 'Folder not found.');
        }
      }
      const updated = db.moveItemsToFolder(ids, folderId);
      return { updated };
    }
    let updated = 0;
    for (const id of ids) {
      const item = db.getItemRecord(id);
      if (!item) continue;
      try {
        if (action === 'trash') {
          await trashItem(item, db);
        } else if (action === 'restore') {
          if (item.trashed_at) db.updateItem(id, { trashed_at: null });
        } else {
          db.updateItem(id, { favorite: action === 'favorite' ? 1 : 0 });
        }
        updated += 1;
      } catch {
        // Skip items that cannot be changed (for example, active uploads).
      }
    }
    return { updated };
  });

  app.post('/api/items/:id/trash', async (request) => {
    const { id } = request.params as { id: string };
    const item = itemOr404(ctx, id);
    await trashItem(item, db);
    return { item: db.getItem(id) };
  });

  app.post('/api/items/:id/restore', async (request) => {
    const { id } = request.params as { id: string };
    const item = itemOr404(ctx, id);
    if (item.trashed_at) db.updateItem(id, { trashed_at: null });
    return { item: db.getItem(id) };
  });

  app.delete('/api/items/:id', async (request) => {
    const { id } = request.params as { id: string };
    const item = itemOr404(ctx, id);
    if (!item.trashed_at) throw new ApiError(409, 'Move this item to trash before deleting it permanently.');
    await purgeItem(item, db, cache, getProvider);
    return { ok: true };
  });

  app.delete('/api/trash', async () => {
    let deleted = 0;
    let failed = 0;
    for (let round = 0; round < 20; round++) {
      const rows = db.listTrashed(1000);
      if (rows.length === 0) break;
      for (const item of rows) {
        try {
          await purgeItem(item, db, cache, getProvider);
          deleted += 1;
        } catch (error) {
          failed += 1;
          console.warn(`[trash] could not delete ${item.id}: ${(error as Error).message}`);
        }
      }
      if (failed > 0) break;
    }
    return { deleted, failed };
  });

  app.post('/api/items/:id/retry', async (request) => {
    const { id } = request.params as { id: string };
    itemOr404(ctx, id);
    if (!queue.retry(id)) throw new ApiError(409, 'This item is not waiting to be retried.');
    return { item: db.getItem(id) };
  });

  app.post('/api/items/:id/offline', async (request) => {
    const { id } = request.params as { id: string };
    const item = itemOr404(ctx, id);
    await cache.pin(item);
    return { item: db.getItem(id) };
  });

  app.delete('/api/items/:id/offline', async (request) => {
    const { id } = request.params as { id: string };
    const item = itemOr404(ctx, id);
    if (item.provider !== 'local') await cache.unpin(item);
    return { item: db.getItem(id) };
  });

  const sendThumb = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    itemOr404(ctx, id);
    const etag = `"thumb-${id}"`;
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    const buffer = await cache.readPreview(id);
    if (!buffer) throw new ApiError(404, 'Preview not available.');
    return reply
      .code(200)
      .header('content-type', 'image/webp')
      .header('content-length', String(buffer.length))
      .header('cache-control', 'private, max-age=31536000, immutable')
      .header('etag', etag)
      .send(request.method === 'HEAD' ? undefined : buffer);
  };

  // Explicit HEAD routes keep Fastify from replacing the real content-length
  // with 0 on the auto-generated HEAD handler.
  app.route({ method: ['GET', 'HEAD'], url: '/api/items/:id/thumb', handler: sendThumb });

  const sendContent = async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const item = itemOr404(ctx, id);
    if (item.status !== 'ready') throw new ApiError(409, 'This file is still being saved to the cloud.');

    const query = request.query as Record<string, unknown>;
    const download = queryValue(query.download) === '1';
    const range = parseRange(request.headers.range, item.size);
    if (range === 'invalid') {
      reply.header('content-range', `bytes */${item.size}`).header('accept-ranges', 'bytes');
      throw new ApiError(416, 'Requested range is not available.');
    }

    const etag = `"${item.hash || item.id}"`;
    if (!range && request.headers['if-none-match'] === etag) {
      return reply.code(304).send();
    }

    let content: {
      stream: NodeJS.ReadableStream;
      size: number;
      start: number;
      end: number;
      status: 200 | 206;
      contentLength: number;
    } | null = null;

    if (item.provider !== 'local' && cache.isCached(item.id)) {
      try {
        content = await cache.openCached(item.id, range ?? undefined);
        if (content.size !== item.size) {
          await cache.invalidateBlob(item.id);
          content = null;
        }
      } catch (error) {
        console.warn(`[cache] failed to read cached file ${item.id}: ${(error as Error).message}`);
        await cache.invalidateBlob(item.id);
      }
    }

    if (!content) {
      const provider = getProvider(item.provider);
      const result = await provider.get(parseLocator(item.locator), range ?? undefined);
      content = {
        stream: result.stream,
        size: result.size,
        start: result.start,
        end: result.end,
        status: result.status,
        contentLength: result.contentLength,
      };
      if (request.method !== 'HEAD' && item.provider !== 'local') {
        try {
          // Warm the local cache in the background while this response streams.
          cache.maybeAutoCache(item);
        } catch (error) {
          request.log.warn({ err: error, item: item.id }, 'could not schedule auto-cache');
        }
      }
    }

    const inline = !download && isInlineSafe(item.mime);
    const headers: Record<string, string> = {
      'content-type': item.mime || 'application/octet-stream',
      'content-length': String(content.contentLength),
      'accept-ranges': 'bytes',
      'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', item.name),
      'cache-control': download ? 'private, max-age=0, must-revalidate' : 'private, max-age=3600',
      etag,
    };
    if (content.status === 206) {
      headers['content-range'] = `bytes ${content.start}-${content.end}/${content.size}`;
    }
    if (item.mime === 'image/svg+xml') {
      headers['content-security-policy'] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
    }

    if (request.method === 'HEAD' || content.contentLength === 0) {
      discardStream(content.stream);
      return reply.code(content.status).headers(headers).send();
    }
    return reply.code(content.status).headers(headers).send(content.stream);
  };

  app.route({ method: ['GET', 'HEAD'], url: '/api/items/:id/content', handler: sendContent });
}
