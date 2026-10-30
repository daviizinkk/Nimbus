import { unlink } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ShareExpiry, ShareListResponse } from '../../../shared/types.js';
import type { AppContext } from '../context.js';
import { config } from '../config.js';
import { createThumbnail } from '../thumbs.js';
import { receiveBinary } from '../upload-utils.js';
import {
  ApiError,
  kindForMime,
  now,
  prettyBytes,
  resolveMime,
  safeFilename,
  SlidingWindowLimiter,
  uid,
} from '../utils.js';
import { sendItemContent } from '../item-content.js';
import {
  createShare,
  expiryToTimestamp,
  isShareActive,
  parseShareExpiry,
  resolveShare,
  shareDTO,
  shareLink,
} from '../shares.js';

const shareLimiter = new SlidingWindowLimiter(60, 60 * 60_000);
const shareTargetLimiter = new SlidingWindowLimiter(30, 15 * 60_000);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

function absoluteUrl(request: FastifyRequest, pathname: string): string {
  const host = request.headers.host || `localhost:${config.port}`;
  return `${config.publicUrl || `${request.protocol}://${host}`}${pathname}`;
}

function publicHeaders(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store');
  reply.header('x-robots-tag', 'noindex, nofollow, noarchive');
  reply.header('cross-origin-resource-policy', 'cross-origin');
}

function unavailablePage(reply: FastifyReply) {
  publicHeaders(reply);
  return reply
    .code(404)
    .header('content-type', 'text/html; charset=utf-8')
    .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="robots" content="noindex, nofollow">
  <meta name="theme-color" content="#0b0d12">
  <title>Link unavailable · Nimbus</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      background: radial-gradient(circle at 50% 0%, #1c2140, #0b0d12 62%); color: #f4f6fb; }
    main { width: min(420px, 100%); text-align: center; }
    .mark { width: 58px; height: 58px; margin: 0 auto 20px; border-radius: 17px;
      display: grid; place-items: center; background: linear-gradient(135deg, #6366f1, #06b6d4);
      font-size: 28px; }
    h1 { font-size: 22px; margin: 0 0 10px; }
    p { color: #9aa3b7; line-height: 1.55; margin: 0; font-size: 14px; }
    footer { margin-top: 28px; color: #6f7890; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <div class="mark" aria-hidden="true">☁</div>
    <h1>This link is not available</h1>
    <p>The link may have expired, been revoked, or the file may have been removed.</p>
    <footer>Nimbus · private by design</footer>
  </main>
</body>
</html>`);
}

function sharePage(
  request: FastifyRequest,
  token: string,
  item: { id: string; name: string; mime: string; size: number; kind: string; width: number | null; height: number | null; hasThumb: boolean },
  expiresAt: number | null,
): string {
  const contentPath = `/s/${encodeURIComponent(token)}/content`;
  const thumbPath = `/s/${encodeURIComponent(token)}/thumb`;
  const contentUrl = absoluteUrl(request, contentPath);
  const thumbUrl = absoluteUrl(request, thumbPath);
  const fallbackImage = absoluteUrl(request, '/nimbus-og.png');
  const imageUrl = item.hasThumb && (item.kind === 'photo' || item.kind === 'video') ? thumbUrl : fallbackImage;
  const title = escapeHtml(item.name);
  const description =
    item.kind === 'photo'
      ? 'A photo shared from a private Nimbus library.'
      : item.kind === 'video'
        ? 'A video shared from a private Nimbus library.'
        : 'A file shared from a private Nimbus library.';
  const escapedDescription = escapeHtml(description);
  const downloadUrl = `${contentUrl}?download=1`;

  let preview: string;
  if (item.kind === 'photo') {
    preview = `<img class="media" src="${escapeHtml(contentPath)}" alt="${title}" loading="eager">`;
  } else if (item.kind === 'video') {
    preview = `<video class="media" src="${escapeHtml(contentPath)}"${item.hasThumb ? ` poster="${escapeHtml(thumbPath)}"` : ''} controls playsinline preload="metadata"></video>`;
  } else {
    preview = `<div class="file-card"><span class="file-icon" aria-hidden="true">▤</span><strong>${title}</strong><span>${escapeHtml(prettyBytes(item.size))}</span></div>`;
  }

  const imageTags =
    item.kind === 'video'
      ? `<meta property="og:type" content="video.other">
  <meta property="og:video" content="${escapeHtml(contentUrl)}">
  <meta property="og:video:secure_url" content="${escapeHtml(contentUrl)}">
  <meta property="og:video:type" content="${escapeHtml(item.mime || 'video/mp4')}">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}">`
      : `<meta property="og:type" content="website">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta property="og:image:alt" content="${title}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}">`;

  const expiryNote =
    expiresAt === null
      ? 'This link stays available until the owner revokes it.'
      : `This link expires ${escapeHtml(new Date(expiresAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }))}.`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="robots" content="noindex, nofollow, noarchive">
  <meta name="theme-color" content="#0b0d12">
  <meta name="description" content="${escapedDescription}">
  <meta property="og:site_name" content="Nimbus">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${escapedDescription}">
  <meta property="og:url" content="${escapeHtml(absoluteUrl(request, `/s/${encodeURIComponent(token)}`))}">
  ${imageTags}
  <title>${title} · Nimbus</title>
  <style>
    :root { color-scheme: dark; --line: rgba(255,255,255,.09); }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body { margin: 0; background: #0b0d12; color: #f4f6fb;
      font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
      display: flex; flex-direction: column; }
    header { display: flex; align-items: center; gap: 10px; padding: 16px 20px; border-bottom: 1px solid var(--line); }
    .brand-mark { width: 30px; height: 30px; border-radius: 9px; display: grid; place-items: center;
      background: linear-gradient(135deg, #6366f1, #06b6d4); font-size: 15px; }
    .brand { font-weight: 650; letter-spacing: -.01em; }
    .brand small { display: block; color: #8d96aa; font-weight: 400; font-size: 11px; }
    main { flex: 1; width: min(980px, 100%); margin: 0 auto; padding: 22px 16px 30px; }
    .stage { background: #11141c; border: 1px solid var(--line); border-radius: 18px; overflow: hidden;
      min-height: 240px; display: grid; place-items: center; }
    .media { display: block; width: 100%; max-height: 68vh; object-fit: contain; background: #080a0f; }
    .file-card { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 48px 24px; text-align: center; }
    .file-icon { width: 64px; height: 64px; border-radius: 18px; display: grid; place-items: center;
      background: rgba(99,102,241,.16); color: #a5b4fc; font-size: 30px; }
    .file-card strong { font-size: 16px; overflow-wrap: anywhere; }
    .file-card span { color: #8d96aa; font-size: 13px; }
    .meta { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap;
      padding: 18px 2px 0; }
    h1 { margin: 0; font-size: 17px; font-weight: 650; overflow-wrap: anywhere; }
    .meta p { margin: 5px 0 0; color: #8d96aa; font-size: 13px; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      min-height: 44px; padding: 0 17px; border-radius: 11px; text-decoration: none;
      font-size: 13.5px; font-weight: 600; border: 1px solid transparent; }
    .btn-primary { background: #6366f1; color: #fff; }
    .btn-ghost { border-color: var(--line); color: #d8deeb; background: rgba(255,255,255,.03); }
    footer { padding: 0 16px calc(24px + env(safe-area-inset-bottom)); text-align: center; color: #6f7890; font-size: 12px; line-height: 1.6; }
    @media (max-width: 560px) {
      header { padding: 13px 15px; }
      main { padding: 14px 10px 20px; }
      .stage { border-radius: 14px; }
      .meta { padding: 14px 6px 0; }
      .actions { width: 100%; }
      .btn { flex: 1; }
    }
  </style>
</head>
<body>
  <header>
    <span class="brand-mark" aria-hidden="true">☁</span>
    <span class="brand">Nimbus<small>Shared privately</small></span>
  </header>
  <main>
    <div class="stage">${preview}</div>
    <div class="meta">
      <div>
        <h1>${title}</h1>
        <p>${escapeHtml(prettyBytes(item.size))}${item.width && item.height ? ` · ${item.width}×${item.height}` : ''}</p>
      </div>
      <div class="actions">
        <a class="btn btn-primary" href="${escapeHtml(downloadUrl)}">Download</a>
        <a class="btn btn-ghost" href="${escapeHtml(contentPath)}" target="_blank" rel="noreferrer">Open original</a>
      </div>
    </div>
  </main>
  <footer>${expiryNote}<br>Anyone with this link can view the file. The owner can revoke it at any time.</footer>
</body>
</html>`;
}

async function ingestSharedFile(
  ctx: AppContext,
  name: string,
  mimetype: string,
  stream: NodeJS.ReadableStream,
): Promise<boolean> {
  const safeName = safeFilename(name, 'shared-file');
  const mime = resolveMime(safeName, mimetype);
  const kind = kindForMime(mime);
  const id = uid();
  const tempPath = path.join(config.tmpDir, `upload-${id}.bin`);
  const active = ctx.settings.activeProvider;

  ctx.db.createItem({
    id,
    name: safeName,
    size: 0,
    mime,
    kind,
    provider: active,
    status: 'receiving',
    tempPath,
    takenAt: now(),
  });

  try {
    const maxBytes = config.maxUploadBytes > 0 ? config.maxUploadBytes : Number.MAX_SAFE_INTEGER;
    const result = await receiveBinary(stream, tempPath, null, maxBytes);
    const provider = ctx.getProvider(active);
    if (Number.isFinite(provider.maxUploadBytes) && result.size > provider.maxUploadBytes) {
      throw new ApiError(
        413,
        `The selected storage provider accepts files up to ${Math.round(provider.maxUploadBytes / 1024 / 1024 / 1024 * 10) / 10} GB per file.`,
      );
    }

    ctx.db.updateItem(id, { size: result.size, hash: result.hash });
    let thumbKey: string | null = null;
    let width: number | null = null;
    let height: number | null = null;
    if (kind === 'photo') {
      try {
        const thumb = await createThumbnail(tempPath);
        await ctx.cache.savePreview(id, thumb.buffer);
        thumbKey = id;
        width = thumb.originalWidth;
        height = thumb.originalHeight;
      } catch (error) {
        console.warn(`[share-target] could not generate preview for ${safeName}: ${(error as Error).message}`);
      }
    }

    ctx.db.updateItem(id, {
      status: 'queued',
      error: null,
      thumb_key: thumbKey,
      width,
      height,
    });
    ctx.queue.enqueue(id, true);
    return true;
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    ctx.db.deleteItemRow(id);
    throw error;
  }
}

export function registerShareRoutes(ctx: AppContext): void {
  const { app, db, cache } = ctx;

  app.get('/api/items/:id/shares', async (request) => {
    const { id } = request.params as { id: string };
    if (!db.getItemRecord(id)) throw new ApiError(404, 'Item not found.');
    const shares = db
      .listShares(id)
      .map((share) => shareDTO(ctx, share, request))
      .filter((share): share is NonNullable<typeof share> => share !== null);
    return { shares } satisfies ShareListResponse;
  });

  app.post('/api/items/:id/shares', async (request) => {
    if (!shareLimiter.allow(request.ip)) throw new ApiError(429, 'Too many share links created. Try again later.');
    const { id } = request.params as { id: string };
    const item = db.getItemRecord(id);
    if (!item) throw new ApiError(404, 'Item not found.');
    const body = (request.body ?? {}) as { expiry?: ShareExpiry };
    const share = createShare(ctx, item, parseShareExpiry(body.expiry), request);
    return { share };
  });

  app.post('/api/shares/:id/revoke', async (request) => {
    const { id } = request.params as { id: string };
    const share = db.getShare(id);
    if (!share) throw new ApiError(404, 'Share link not found.');
    db.revokeShare(id);
    return { ok: true };
  });

  // ------------------------------------------------------------ public pages

  app.get('/s/:token', async (request, reply) => {
    const { token } = request.params as { token: string };
    const resolved = resolveShare(ctx, token);
    if (!resolved) return unavailablePage(reply);
    const { share, item } = resolved;
    db.touchShare(share.id);
    publicHeaders(reply);
    reply.header('content-type', 'text/html; charset=utf-8');
    return reply.code(200).send(
      sharePage(
        request,
        token,
        {
          id: item.id,
          name: item.name,
          mime: item.mime,
          size: item.size,
          kind: item.kind,
          width: item.width,
          height: item.height,
          hasThumb: Boolean(item.thumb_key),
        },
        share.expires_at,
      ),
    );
  });

  app.route({
    method: ['GET', 'HEAD'],
    url: '/s/:token/thumb',
    handler: async (request, reply) => {
      const { token } = request.params as { token: string };
      const resolved = resolveShare(ctx, token);
      if (!resolved) return unavailablePage(reply);
      const etag = `"share-thumb-${resolved.share.id}"`;
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      const buffer = await cache.readPreview(resolved.item.id);
      if (!buffer) {
        return reply
          .code(404)
          .header('cache-control', 'no-store')
          .header('x-robots-tag', 'noindex, nofollow')
          .send();
      }
      return reply
        .code(200)
        .header('content-type', 'image/webp')
        .header('content-length', String(buffer.length))
        .header('cache-control', 'public, max-age=300')
        .header('x-robots-tag', 'noindex, nofollow, noarchive')
        .header('cross-origin-resource-policy', 'cross-origin')
        .header('etag', etag)
        .send(request.method === 'HEAD' ? undefined : buffer);
    },
  });

  app.route({
    method: ['GET', 'HEAD'],
    url: '/s/:token/content',
    handler: async (request, reply) => {
      const { token } = request.params as { token: string };
      const resolved = resolveShare(ctx, token);
      if (!resolved) return unavailablePage(reply);
      const query = request.query as Record<string, unknown>;
      return sendItemContent(ctx, request, reply, resolved.item, {
        download: query.download === '1',
        cacheControl: 'public, max-age=300',
        etagPrefix: `share-${resolved.share.id}`,
        headers: {
          'x-robots-tag': 'noindex, nofollow, noarchive',
          'cross-origin-resource-policy': 'cross-origin',
        },
      });
    },
  });

  // --------------------------------------------------------- Android share target

  app.post('/share-target', async (request, reply) => {
    if (!shareTargetLimiter.allow(request.ip)) {
      return reply.code(303).header('cache-control', 'no-store').header('location', '/?shared=busy').send();
    }
    if (!ctx.auth.authenticate(request)) {
      return reply.code(303).header('cache-control', 'no-store').header('location', '/?shared=signin').send();
    }
    if (!request.isMultipart()) {
      return reply.code(303).header('cache-control', 'no-store').header('location', '/?shared=error').send();
    }

    let accepted = 0;
    let failed = 0;
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file') continue;
        try {
          const ok = await ingestSharedFile(ctx, part.filename || 'shared-file', part.mimetype, part.file);
          if (ok) accepted += 1;
          else failed += 1;
        } catch (error) {
          failed += 1;
          request.log.warn({ err: error, name: part.filename }, 'share target file failed');
        }
      }
    } catch (error) {
      request.log.warn({ err: error }, 'share target request failed');
      failed += 1;
    }

    const target = failed > 0 ? `/?shared=${accepted}&shareFailed=${failed}` : `/?shared=${accepted}`;
    return reply.code(303).header('cache-control', 'no-store').header('location', target).send();
  });
}
