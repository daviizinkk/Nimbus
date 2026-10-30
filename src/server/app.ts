import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import multipart from '@fastify/multipart';
import { lookup as mimeLookup } from 'mime-types';
import type { AppContext } from './context.js';
import { config } from './config.js';
import { ProviderError } from './storage/index.js';
import { ApiError } from './utils.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerItemRoutes } from './routes/items.js';
import { registerUploadRoutes } from './routes/uploads.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerFolderRoutes } from './routes/folders.js';
import { registerAccountRoutes } from './routes/account.js';
import { registerShareRoutes } from './routes/shares.js';

const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'self' blob:",
  "frame-ancestors 'self'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "manifest-src 'self'",
  "worker-src 'self'",
].join('; ');

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PUBLIC_GET_PATHS = new Set(['/api/status', '/api/health', '/api/account/deletion']);
const PUBLIC_POST_PATHS = new Set(['/api/login', '/api/setup', '/api/logout']);

function requestPath(request: FastifyRequest): string {
  const raw = request.url.split('?')[0] || '/';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function addSecurityHeaders(request: FastifyRequest, reply: FastifyReply): void {
  reply.header('x-content-type-options', 'nosniff');
  reply.header('referrer-policy', 'no-referrer');
  reply.header('permissions-policy', 'camera=(self), microphone=(), geolocation=(), payment=()');
  reply.header('cross-origin-opener-policy', 'same-origin');
  if (!reply.getHeader('cross-origin-resource-policy')) {
    reply.header('cross-origin-resource-policy', 'same-origin');
  }
  if (!reply.getHeader('content-security-policy')) {
    reply.header('content-security-policy', CSP);
  }
  if (request.protocol === 'https') {
    reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
  }
}

function isPublicApiRequest(
  method: string,
  pathname: string,
  onboarded: boolean,
): boolean {
  if (method === 'GET' && PUBLIC_GET_PATHS.has(pathname)) return true;
  if (method === 'POST' && PUBLIC_POST_PATHS.has(pathname)) return true;
  if (!onboarded && method === 'POST' && (pathname === '/api/storage/test' || pathname === '/api/storage/github/create-repo')) {
    return true;
  }
  return false;
}

function clientDir(): string {
  return path.resolve(process.cwd(), 'dist/client');
}

const gzipCache = new Map<string, Buffer>();

async function staticFilePayload(
  filePath: string,
  acceptEncoding: string | undefined,
): Promise<{ data: Buffer; encoding?: string }> {
  const contentType = mimeLookup(filePath) || 'application/octet-stream';
  const compressible = /^(text\/|application\/(javascript|json|xml|manifest\+json)|image\/svg\+xml)/.test(contentType);
  if (compressible && acceptEncoding?.includes('gzip')) {
    const cached = gzipCache.get(filePath);
    if (cached) return { data: cached, encoding: 'gzip' };
    const raw = await readFile(filePath);
    if (raw.length > 1024) {
      const compressed = gzipSync(raw, { level: 6 });
      if (gzipCache.size > 100) gzipCache.clear();
      gzipCache.set(filePath, compressed);
      return { data: compressed, encoding: 'gzip' };
    }
    return { data: raw };
  }
  return { data: await readFile(filePath) };
}

async function sendStatic(
  request: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  cacheControl: string,
): Promise<FastifyReply> {
  const info = await stat(filePath);
  const etag = `"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`;
  reply.header('etag', etag);
  reply.header('cache-control', cacheControl);
  if (request.headers['if-none-match'] === etag) return reply.code(304).send();
  const { data, encoding } = await staticFilePayload(filePath, request.headers['accept-encoding']);
  if (encoding) {
    reply.header('content-encoding', encoding);
    reply.header('vary', 'Accept-Encoding');
  }
  reply.header('content-length', String(data.length));
  reply.header('content-type', mimeLookup(filePath) || 'application/octet-stream');
  return reply.code(200).send(request.method === 'HEAD' ? undefined : data);
}

async function sendIndex(request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const indexFile = path.join(clientDir(), 'index.html');
  try {
    await stat(indexFile);
  } catch {
    return reply
      .code(503)
      .header('content-type', 'text/html; charset=utf-8')
      .send(`<!doctype html><html><body style="font-family:system-ui;padding:3rem;max-width:640px;margin:auto">
        <h1>Nimbus API is running</h1>
        <p>The web app has not been built yet. Run <code>npm run dev</code> for development or <code>npm run build</code> and then <code>npm start</code>.</p>
        <p>API health: <a href="/api/health">/api/health</a></p>
      </body></html>`);
  }
  return sendStatic(request, reply, indexFile, 'no-cache');
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    exposeHeadRoutes: true,
  });

  ctx.app = app;

  // Streaming upload bodies are handed directly to the route handler.
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  // Android share-target posts arrive as streaming multipart bodies.
  await app.register(multipart, {
    limits: {
      files: 40,
      parts: 100,
      fields: 10,
      fieldSize: 1024 * 1024,
      fileSize: config.maxUploadBytes > 0 ? config.maxUploadBytes : 10 * 1024 * 1024 * 1024,
    },
  });

  app.addHook('preHandler', async (request) => {
    const pathname = requestPath(request);
    if (!pathname.startsWith('/api/')) return;

    if (MUTATION_METHODS.has(request.method) && request.headers['x-nimbus-client'] !== '1') {
      throw new ApiError(403, 'Missing client request header.', 'csrf');
    }

    if (isPublicApiRequest(request.method, pathname, ctx.settings.onboarded)) return;

    const session = ctx.auth.authenticate(request);
    if (!session) throw new ApiError(401, 'Your session has expired. Sign in again.', 'unauthorized');
    request.authSession = session;
  });

  app.addHook('onSend', async (request, reply, payload) => {
    addSecurityHeaders(request, reply);
    if (requestPath(request).startsWith('/api/') && !reply.getHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  app.setErrorHandler((rawError, request, reply) => {
    const error = rawError as Error & { statusCode?: number };
    let status = 500;
    let message = 'An unexpected server error occurred.';
    let code = 'internal_error';

    if (error instanceof ApiError) {
      status = error.status;
      message = error.message;
      code = error.code;
    } else if (error instanceof ProviderError) {
      status = error.status >= 400 && error.status < 600 ? error.status : 502;
      message = error.message;
      code = error.code;
    } else if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      status = error.statusCode;
      message =
        status === 413
          ? 'Request body is too large.'
          : status === 400
            ? 'The request could not be understood.'
            : error.message;
      code = 'bad_request';
    }

    if (status >= 500) {
      app.log.error({ err: error, url: request.url }, 'request failed');
    }
    if (reply.sent) return;
    reply.code(status).send({ error: { code, message } });
  });

  app.setNotFoundHandler(async (request, reply) => {
    const pathname = requestPath(request);
    if (pathname.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'API route not found.' } });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(405).send({ error: { code: 'method_not_allowed', message: 'Method not allowed.' } });
    }

    const root = clientDir();
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      decoded = pathname;
    }
    if (!decoded.includes('\0') && !decoded.includes('..') && !decoded.includes('\\')) {
      const candidate = path.resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
      if (candidate.startsWith(`${root}${path.sep}`) && !decoded.endsWith('/')) {
        try {
          const info = await stat(candidate);
          if (info.isFile()) {
            const cacheControl =
              decoded === '/sw.js'
                ? 'no-cache'
                : decoded.startsWith('/assets/')
                  ? 'public, max-age=31536000, immutable'
                  : 'public, max-age=86400';
            if (decoded === '/sw.js') reply.header('service-worker-allowed', '/');
            return sendStatic(request, reply, candidate, cacheControl);
          }
        } catch {
          // Fall through to the SPA.
        }
      }
    }

    const acceptsHtml = String(request.headers.accept || '').includes('text/html');
    if (acceptsHtml) return sendIndex(request, reply);
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
  });

  registerStatusRoutes(ctx);
  registerSettingsRoutes(ctx);
  registerUploadRoutes(ctx);
  registerItemRoutes(ctx);
  registerFolderRoutes(ctx);
  registerAccountRoutes(ctx);
  registerShareRoutes(ctx);

  return app;
}
