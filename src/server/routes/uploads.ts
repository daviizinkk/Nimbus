import type { Readable } from 'node:stream';
import { readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import type { UploadCompleteRequest } from '../../../shared/types.js';
import type { AppContext } from '../context.js';
import { config } from '../config.js';
import { createThumbnail } from '../thumbs.js';
import { receiveBinary } from '../upload-utils.js';
import {
  ApiError,
  kindForMime,
  now,
  resolveMime,
  safeFilename,
  uid,
} from '../utils.js';

function requireBodyStream(request: FastifyRequest): Readable {
  const body = request.body as unknown;
  if (!body || typeof (body as Readable).on !== 'function') {
    throw new ApiError(400, 'Expected a raw binary request body.');
  }
  return body as Readable;
}

function optionalDimension(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 100_000) return null;
  return Math.round(number);
}

function optionalDuration(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 366 * 24 * 60 * 60) return null;
  return Math.round(number * 1000) / 1000;
}

export function registerUploadRoutes(ctx: AppContext): void {
  const { app, db, cache, queue, settings, getProvider } = ctx;

  app.post('/api/uploads', async (request, reply) => {
    const body = (request.body ?? {}) as {
      name?: string;
      size?: number;
      mime?: string;
      takenAt?: number;
      folderId?: string | null;
    };
    const name = safeFilename(typeof body.name === 'string' ? body.name : '', '');
    if (!name) throw new ApiError(400, 'A file name is required.');
    const size = Number(body.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new ApiError(400, 'Invalid file size.');
    if (config.maxUploadBytes > 0 && size > config.maxUploadBytes) {
      throw new ApiError(413, `This file exceeds the configured upload limit (${Math.round(config.maxUploadBytes / 1024 / 1024)} MB).`);
    }

    const active = settings.activeProvider;
    const provider = getProvider(active);
    if (Number.isFinite(provider.maxUploadBytes) && size > provider.maxUploadBytes) {
      throw new ApiError(
        413,
        `The selected cloud provider accepts files up to ${Math.round(provider.maxUploadBytes / 1024 / 1024 / 1024 * 10) / 10} GB per file. Choose another storage provider in Settings.`,
      );
    }

    const mime = resolveMime(name, body.mime);
    const kind = kindForMime(mime);
    const id = uid();
    const tempPath = path.join(config.tmpDir, `upload-${id}.bin`);
    const takenAtRaw = Number(body.takenAt);
    const takenAt =
      Number.isFinite(takenAtRaw) && takenAtRaw > 946684800000 && takenAtRaw < Date.now() + 86400000
        ? Math.round(takenAtRaw)
        : now();

    // Folders organise files. A photo or video uploaded while browsing a folder
    // still belongs in Photos/Videos, so the target only applies to file-kind
    // uploads.
    let folderId: string | null = null;
    if (kind === 'file' && typeof body.folderId === 'string' && body.folderId) {
      if (!db.getFolderRecord(body.folderId)) throw new ApiError(404, 'That folder no longer exists.');
      folderId = body.folderId;
    }

    db.createItem({
      id,
      name,
      size,
      mime,
      kind,
      provider: active,
      status: 'receiving',
      tempPath,
      takenAt,
      folderId,
    });

    return reply.code(201).send({
      id,
      name,
      size,
      mime,
      kind,
      uploadUrl: `/api/uploads/${id}/body`,
      posterUrl: `/api/uploads/${id}/poster`,
      completeUrl: `/api/uploads/${id}/complete`,
    });
  });

  app.put('/api/uploads/:id/body', async (request) => {
    const { id } = request.params as { id: string };
    const item = db.getItemRecord(id);
    if (!item) throw new ApiError(404, 'Upload not found.');
    if (item.status !== 'receiving') throw new ApiError(409, 'This upload has already been received.');
    if (!item.temp_path) throw new ApiError(500, 'Upload staging path is missing.');

    const contentLengthHeader = request.headers['content-length'];
    if (contentLengthHeader !== undefined) {
      const declared = Number(contentLengthHeader);
      if (!Number.isFinite(declared) || declared !== item.size) {
        throw new ApiError(400, 'The upload Content-Length does not match the declared file size.');
      }
    }

    const result = await receiveBinary(requireBodyStream(request), item.temp_path, item.size, item.size);
    db.updateItem(id, { hash: result.hash, size: result.size });
    return { ok: true, size: result.size };
  });

  app.put('/api/uploads/:id/poster', async (request) => {
    const { id } = request.params as { id: string };
    const item = db.getItemRecord(id);
    if (!item) throw new ApiError(404, 'Upload not found.');
    if (item.kind !== 'video') throw new ApiError(400, 'Posters can only be added to videos.');
    if (item.status !== 'receiving') throw new ApiError(409, 'This upload has already been received.');

    const posterPath = path.join(config.tmpDir, `poster-${id}.jpg`);
    await receiveBinary(requireBodyStream(request), posterPath, null, 10 * 1024 * 1024);
    if (item.poster_path) await unlink(item.poster_path).catch(() => {});
    db.updateItem(id, { poster_path: posterPath });
    return { ok: true };
  });

  app.post('/api/uploads/:id/complete', async (request) => {
    const { id } = request.params as { id: string };
    const item = db.getItemRecord(id);
    if (!item) throw new ApiError(404, 'Upload not found.');
    if (item.status !== 'receiving') throw new ApiError(409, 'This upload has already been completed.');
    if (!item.temp_path) throw new ApiError(500, 'Upload staging path is missing.');

    let info;
    try {
      info = await stat(item.temp_path);
    } catch {
      throw new ApiError(409, 'The upload body has not been received yet.');
    }
    if (info.size !== item.size) throw new ApiError(409, 'The upload is incomplete.');
    if (!item.hash) throw new ApiError(409, 'The upload body has not been received yet.');

    const body = (request.body ?? {}) as UploadCompleteRequest;
    let width = optionalDimension(body.width);
    let height = optionalDimension(body.height);
    const duration = optionalDuration(body.duration);
    let thumbKey: string | null = null;

    try {
      if (item.kind === 'photo') {
        const thumb = await createThumbnail(item.temp_path);
        await cache.savePreview(id, thumb.buffer);
        thumbKey = id;
        width = width ?? thumb.originalWidth;
        height = height ?? thumb.originalHeight;
      } else if (item.kind === 'video' && item.poster_path) {
        const poster = await readFile(item.poster_path);
        const thumb = await createThumbnail(poster);
        await cache.savePreview(id, thumb.buffer);
        thumbKey = id;
      }
    } catch (error) {
      console.warn(`[upload] could not generate preview for ${item.name}: ${(error as Error).message}`);
      // A missing preview must never prevent the original file from being saved.
    }

    if (item.poster_path) {
      await unlink(item.poster_path).catch(() => {});
    }

    db.updateItem(id, {
      status: 'queued',
      error: null,
      poster_path: null,
      thumb_key: thumbKey,
      width,
      height,
      duration,
    });

    queue.enqueue(id, true);
    return { item: db.getItem(id) };
  });

  app.delete('/api/uploads/:id', async (request) => {
    const { id } = request.params as { id: string };
    const item = db.getItemRecord(id);
    if (!item) return { ok: true };
    if (item.status !== 'receiving') {
      throw new ApiError(409, 'This upload is already being processed. Move the item to trash instead.');
    }
    if (item.temp_path) await unlink(item.temp_path).catch(() => {});
    if (item.poster_path) await unlink(item.poster_path).catch(() => {});
    db.deleteItemRow(id);
    return { ok: true };
  });
}
