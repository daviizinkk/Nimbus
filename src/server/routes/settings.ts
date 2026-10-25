import type { AppSettingsView, ProviderId, StorageStats } from '../../../shared/types.js';
import type { AppContext } from '../context.js';
import { config } from '../config.js';
import { createPrivateGithubRepo } from '../storage/github.js';
import { providerFromInput } from '../provider-test.js';
import { ApiError, SlidingWindowLimiter } from '../utils.js';

const testLimiter = new SlidingWindowLimiter(40, 15 * 60_000);
const repoLimiter = new SlidingWindowLimiter(12, 60 * 60_000);

function settingsView(ctx: AppContext): AppSettingsView {
  return {
    vaultName: ctx.settings.vaultName,
    version: config.version,
    storage: ctx.settings.publicStorage(),
    cache: ctx.cache.stats(),
  };
}

function parseProvider(value: unknown): ProviderId {
  if (value === 'local' || value === 'github' || value === 'webdav') return value;
  throw new ApiError(400, 'Unknown storage provider.');
}

type ProviderBody = {
  provider?: string;
  config?: Record<string, string | undefined>;
};

export function registerSettingsRoutes(ctx: AppContext): void {
  const { app, settings, cache, db } = ctx;

  app.get('/api/settings', async () => settingsView(ctx));

  app.patch('/api/settings', async (request) => {
    const body = (request.body ?? {}) as { vaultName?: string };
    if (typeof body.vaultName === 'string') {
      settings.vaultName = body.vaultName;
    }
    return settingsView(ctx);
  });

  app.patch('/api/settings/storage', async (request) => {
    const body = (request.body ?? {}) as {
      active?: string;
      github?: { token?: string; owner?: string; repo?: string; releaseTag?: string };
      webdav?: { url?: string; username?: string; password?: string; folder?: string };
    };

    if (body.active !== undefined) {
      const active = parseProvider(body.active);
      if (active !== 'local') {
        // Never switch uploads to a backend that cannot be reached (or, for
        // GitHub, to a public repository that would expose the library).
        const input = active === 'github' ? body.github : body.webdav;
        const result = await providerFromInput(settings, active, input, true).test();
        if (!result.ok) throw new ApiError(400, `Storage check failed: ${result.message}`);
      }
      if (body.github) settings.saveGithub(body.github);
      if (body.webdav) settings.saveWebdav(body.webdav);
      settings.activeProvider = active;
    } else {
      if (body.github) settings.saveGithub(body.github);
      if (body.webdav) settings.saveWebdav(body.webdav);
    }
    return { settings: settingsView(ctx) };
  });

  app.post('/api/storage/test', async (request) => {
    if (!testLimiter.allow(request.ip)) throw new ApiError(429, 'Too many connection tests. Try again later.');
    const body = (request.body ?? {}) as ProviderBody;
    const provider = parseProvider(body.provider);
    const result = await providerFromInput(settings, provider, body.config, true).test();
    return result;
  });

  app.post('/api/storage/github/create-repo', async (request) => {
    if (!repoLimiter.allow(request.ip)) throw new ApiError(429, 'Too many repository creation attempts. Try again later.');
    const body = (request.body ?? {}) as { token?: string; name?: string };
    const token = (body.token || settings.github?.token || '').trim();
    if (!token) throw new ApiError(400, 'A GitHub access token is required to create a repository.');
    const name = (body.name || 'nimbus-library').trim();
    const result = await createPrivateGithubRepo(token, name);
    return result;
  });

  app.patch('/api/settings/cache', async (request) => {
    const body = (request.body ?? {}) as {
      limitMB?: number;
      encrypted?: boolean;
      autoCache?: boolean;
    };
    const patch: { limitMB?: number; autoCache?: boolean } = {};
    if (body.limitMB !== undefined) {
      const value = Number(body.limitMB);
      if (!Number.isFinite(value) || value < 0 || value > 1024 * 1024) {
        throw new ApiError(400, 'Cache limit must be between 0 and 1,048,576 MB.');
      }
      patch.limitMB = Math.floor(value);
    }
    if (body.autoCache !== undefined) patch.autoCache = Boolean(body.autoCache);
    if (Object.keys(patch).length > 0) settings.setCache(patch);
    if (body.encrypted !== undefined && body.encrypted !== settings.cache.encrypted) {
      await cache.setEncryption(Boolean(body.encrypted));
    }
    await cache.applyLimit();
    return { cache: cache.stats() };
  });

  app.post('/api/cache/clear', async (request) => {
    const body = (request.body ?? {}) as { includePinned?: boolean };
    await cache.clear(Boolean(body.includePinned));
    return { cache: cache.stats() };
  });

  app.get('/api/stats', async () => {
    const stats: StorageStats = db.getStats();
    return {
      storage: stats,
      cache: cache.stats(),
      activeProvider: settings.activeProvider,
    };
  });
}
