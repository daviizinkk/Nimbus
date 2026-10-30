import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context.js';
import type { DbItem } from './db.js';
import {
  ApiError,
  contentDisposition,
  parseRange,
} from './utils.js';

export interface SendItemContentOptions {
  /** Force a download instead of an inline preview. */
  download?: boolean;
  /** Cache-Control header for this response. */
  cacheControl?: string;
  /** Extra headers (for example no-index or cross-origin hints). */
  headers?: Record<string, string>;
  /** Distinguishes public share ETags from the private item ETag. */
  etagPrefix?: string;
}

function isInlineSafe(mime: string): boolean {
  return (
    mime.startsWith('image/') ||
    mime.startsWith('video/') ||
    mime.startsWith('audio/') ||
    mime === 'application/pdf'
  );
}

function discardStream(stream: NodeJS.ReadableStream): void {
  const candidate = stream as NodeJS.ReadableStream & { destroy?: () => void };
  candidate.destroy?.();
}

/**
 * Streams an item's original bytes with range support. Shared by the
 * authenticated item routes and revocable public share links.
 */
export async function sendItemContent(
  ctx: Pick<AppContext, 'cache' | 'getProvider'>,
  request: FastifyRequest,
  reply: FastifyReply,
  item: DbItem,
  options: SendItemContentOptions = {},
): Promise<FastifyReply> {
  if (item.status !== 'ready') {
    throw new ApiError(409, 'This file is still being saved to the cloud.');
  }

  const range = parseRange(request.headers.range, item.size);
  if (range === 'invalid') {
    reply.header('content-range', `bytes */${item.size}`).header('accept-ranges', 'bytes');
    throw new ApiError(416, 'Requested range is not available.');
  }

  const etag = `"${options.etagPrefix ? `${options.etagPrefix}-` : ''}${item.hash || item.id}"`;
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

  if (item.provider !== 'local' && ctx.cache.isCached(item.id)) {
    try {
      content = await ctx.cache.openCached(item.id, range ?? undefined);
      if (content.size !== item.size) {
        await ctx.cache.invalidateBlob(item.id);
        content = null;
      }
    } catch (error) {
      console.warn(`[cache] failed to read cached file ${item.id}: ${(error as Error).message}`);
      await ctx.cache.invalidateBlob(item.id);
    }
  }

  if (!content) {
    if (!item.locator) throw new ApiError(409, 'This item has not finished uploading.');
    let locator: Record<string, unknown>;
    try {
      locator = JSON.parse(item.locator) as Record<string, unknown>;
    } catch {
      throw new ApiError(500, 'The stored file location is invalid.');
    }
    const provider = ctx.getProvider(item.provider);
    const result = await provider.get(locator, range ?? undefined);
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
        ctx.cache.maybeAutoCache(item);
      } catch (error) {
        request.log.warn({ err: error, item: item.id }, 'could not schedule auto-cache');
      }
    }
  }

  const inline = !options.download && isInlineSafe(item.mime);
  const headers: Record<string, string> = {
    'content-type': item.mime || 'application/octet-stream',
    'content-length': String(content.contentLength),
    'accept-ranges': 'bytes',
    'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', item.name),
    'cache-control':
      options.cacheControl ?? (options.download ? 'private, max-age=0, must-revalidate' : 'private, max-age=3600'),
    etag,
    ...(options.headers ?? {}),
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
}
