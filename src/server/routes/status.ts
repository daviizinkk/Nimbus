import type { FastifyInstance } from 'fastify';
import type {
  AppStatus,
  ProviderId,
  SetupRequest,
} from '../../../shared/types.js';
import type { AppContext } from '../context.js';
import { config } from '../config.js';
import { hashPassword, verifyPassword } from '../auth.js';
import { providerFromInput } from '../provider-test.js';
import { ApiError, SlidingWindowLimiter, sleep } from '../utils.js';

const loginLimiter = new SlidingWindowLimiter(10, 15 * 60_000);
const setupLimiter = new SlidingWindowLimiter(15, 60 * 60_000);

function publicStatus(ctx: AppContext, authenticated: boolean): AppStatus {
  return {
    onboarded: ctx.settings.onboarded,
    authenticated,
    vaultName: ctx.settings.vaultName,
    version: config.version,
    telemetryConfigured: ctx.settings.telemetryConfigured,
  };
}

function requestUserAgent(request: { headers: Record<string, unknown> }): string | undefined {
  const value = request.headers['user-agent'];
  return typeof value === 'string' ? value : undefined;
}

export function registerStatusRoutes(ctx: AppContext): void {
  const { app, auth, settings, db } = ctx;

  app.get('/api/health', async () => ({
    ok: true,
    version: config.version,
    uptime: Math.round(process.uptime()),
  }));

  app.get('/api/status', async (request) => {
    const session = auth.authenticate(request);
    return publicStatus(ctx, Boolean(session));
  });

  app.post('/api/setup', async (request, reply) => {
    if (!setupLimiter.allow(request.ip)) {
      throw new ApiError(429, 'Too many setup attempts. Try again later.');
    }
    if (settings.onboarded) throw new ApiError(409, 'This Nimbus instance is already set up.');

    const body = (request.body ?? {}) as Partial<SetupRequest>;
    const vaultName = typeof body.vaultName === 'string' ? body.vaultName.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!vaultName || vaultName.length > 60) throw new ApiError(400, 'Choose a library name (up to 60 characters).');
    if (password.length < 8) throw new ApiError(400, 'Your password must be at least 8 characters long.');
    if (password.length > 200) throw new ApiError(400, 'Password is too long.');

    const storage = body.storage;
    const active: ProviderId = storage?.active === 'github' || storage?.active === 'webdav' ? storage.active : 'local';

    let providerInput: Record<string, string | undefined> | undefined;
    if (active === 'github') {
      const input = storage?.github;
      if (!input?.token || !input.owner || !input.repo) {
        throw new ApiError(400, 'Enter the GitHub token, owner and repository for your private storage repo.');
      }
      providerInput = { ...input };
    } else if (active === 'webdav') {
      const input = storage?.webdav;
      if (!input?.url) throw new ApiError(400, 'Enter the WebDAV server URL.');
      providerInput = { ...input };
    }

    if (active !== 'local') {
      const test = await providerFromInput(settings, active, providerInput, false).test();
      if (!test.ok) {
        throw new ApiError(400, `Storage check failed: ${test.message}`);
      }
    }

    if (active === 'github' && storage?.github) {
      settings.saveGithub({ ...storage.github, token: storage.github.token });
    } else if (active === 'webdav' && storage?.webdav) {
      settings.saveWebdav({ ...storage.webdav });
    }
    settings.vaultName = vaultName;
    settings.activeProvider = active;
    settings.passwordHash = await hashPassword(password);
    settings.setTelemetryEnabled(body.telemetry === true);

    const token = auth.createSession(requestUserAgent(request));
    auth.setSessionCookie(request, reply, token);
    setupLimiter.reset(request.ip);
    db.pruneSessions();
    if (body.telemetry === true) void ctx.telemetry.sendNow();
    return reply.code(201).send(publicStatus(ctx, true));
  });

  app.post('/api/login', async (request, reply) => {
    if (!loginLimiter.allow(request.ip)) {
      throw new ApiError(429, 'Too many sign-in attempts. Wait a few minutes and try again.');
    }
    if (!settings.onboarded) throw new ApiError(409, 'This Nimbus instance has not been set up yet.');
    const body = (request.body ?? {}) as { password?: string };
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) throw new ApiError(400, 'Enter your password.');

    const stored = settings.passwordHash;
    const valid = stored ? await verifyPassword(password, stored) : false;
    if (!valid) {
      await sleep(350);
      throw new ApiError(401, 'That password is not correct.');
    }
    loginLimiter.reset(request.ip);
    const token = auth.createSession(requestUserAgent(request));
    auth.setSessionCookie(request, reply, token);
    return { status: publicStatus(ctx, true) };
  });

  app.post('/api/logout', async (request, reply) => {
    const session = auth.authenticate(request);
    auth.logout(session);
    auth.clearSessionCookie(request, reply);
    return { ok: true };
  });

  app.post('/api/account/password', async (request, reply) => {
    const body = (request.body ?? {}) as { currentPassword?: string; newPassword?: string };
    const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (next.length < 8) throw new ApiError(400, 'The new password must be at least 8 characters long.');
    if (next.length > 200) throw new ApiError(400, 'Password is too long.');
    const stored = settings.passwordHash;
    if (!stored || !(await verifyPassword(current, stored))) {
      throw new ApiError(401, 'Your current password is not correct.');
    }
    settings.passwordHash = await hashPassword(next);
    db.deleteAllSessions();
    const token = auth.createSession(requestUserAgent(request));
    auth.setSessionCookie(request, reply, token);
    return { ok: true };
  });
}
