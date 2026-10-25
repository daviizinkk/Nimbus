import { mkdir, rm } from 'node:fs/promises';
import type { AccountDeletionStatus } from '../../../shared/types.js';
import type { AppContext } from '../context.js';
import { config } from '../config.js';
import { verifyPassword } from '../auth.js';
import { randomToken } from '../crypto.js';
import { deleteGithubRepository } from '../storage/github.js';
import { ApiError, SlidingWindowLimiter, sleep, truncate } from '../utils.js';
import type { DbItem } from '../db.js';

interface DeletionJob {
  token: string;
  startedAt: number;
  finishedAt: number | null;
  status: AccountDeletionStatus;
}

const deleteLimiter = new SlidingWindowLimiter(5, 15 * 60_000);
const JOB_TTL_MS = 60 * 60_000;

let job: DeletionJob | null = null;

function statusOf(jobState: DeletionJob): AccountDeletionStatus {
  return { ...jobState.status };
}

function activeJob(): DeletionJob | null {
  if (!job) return null;
  if (Date.now() - job.startedAt > JOB_TTL_MS) {
    job = null;
    return null;
  }
  return job;
}

function errorMessage(error: unknown): string {
  return truncate(error instanceof Error ? error.message : String(error), 300);
}

function parseLocator(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function resetDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  await mkdir(directory, { recursive: true });
}

async function deleteRemoteFiles(
  ctx: AppContext,
  jobState: DeletionJob,
  items: DbItem[],
  githubRepositoryDeleted: boolean,
): Promise<void> {
  const { getProvider } = ctx;
  const status = jobState.status;

  for (const item of items) {
    try {
      const coveredByRepository = item.provider === 'github' && githubRepositoryDeleted;
      if (!coveredByRepository && item.status === 'ready' && item.locator) {
        const locator = parseLocator(item.locator);
        if (locator && item.provider !== 'local') {
          await getProvider(item.provider).delete(locator);
        }
      }
    } catch (error) {
      status.failed += 1;
      status.error ??= `Could not remove ${item.name}: ${errorMessage(error)}`;
      console.warn(`[delete] could not remove ${item.id} (${item.provider}): ${errorMessage(error)}`);
    } finally {
      status.processed += 1;
      if (status.processed === status.total || status.processed % 10 === 0) {
        status.message = `Deleting files from storage… ${status.processed.toLocaleString()} of ${status.total.toLocaleString()}`;
      }
    }
    // Keep the event loop responsive while processing large libraries.
    if (status.processed % 25 === 0) await sleep(0);
  }
}

async function runDeletion(
  ctx: AppContext,
  jobState: DeletionJob,
  deleteRepository: boolean,
): Promise<void> {
  const { db, cache, queue, settings, app } = ctx;
  const status = jobState.status;
  const github = deleteRepository ? settings.github : null;
  let repositoryDeleted = false;

  try {
    jobState.status.phase = 'running';
    status.message = 'Stopping uploads and cache downloads…';
    await queue.shutdown(20_000);
    await cache.suspendForDeletion();

    if (github) {
      status.message = `Deleting GitHub repository ${github.owner}/${github.repo}…`;
      try {
        await deleteGithubRepository(github);
        repositoryDeleted = true;
        status.repositoryDeleted = true;
      } catch (error) {
        status.failed += 1;
        status.error ??= `GitHub repository could not be deleted: ${errorMessage(error)}`;
        console.warn(`[delete] repository deletion failed: ${errorMessage(error)}`);
      }
    }

    const items = db.listAllItems(1_000_000);
    status.total = items.length;
    status.processed = 0;
    status.message =
      items.length > 0
        ? `Deleting files from storage… 0 of ${items.length.toLocaleString()}`
        : 'Removing local library data…';

    await deleteRemoteFiles(ctx, jobState, items, repositoryDeleted);

    status.phase = 'finalizing';
    status.message = 'Removing local metadata, previews and cache…';

    // Wipe files first so a locked file aborts the deletion while the database
    // still describes the library and the operation can be retried. The
    // database reset is the irreversible final step.
    await Promise.all([resetDirectory(config.storageDir), resetDirectory(config.tmpDir)]);
    await cache.wipeForDeletion();
    db.resetLibraryData();
    queue.reopen();
    cache.reopen();

    status.phase = 'done';
    status.message =
      status.failed > 0
        ? `Library deleted, but ${status.failed.toLocaleString()} ${status.failed === 1 ? 'item' : 'items'} could not be removed from cloud storage.`
        : 'Library and account deleted.';
    jobState.finishedAt = Date.now();
    console.log(`[delete] library deleted (${items.length} items, ${status.failed} failures)`);
  } catch (error) {
    status.phase = 'error';
    status.message = 'Deletion could not finish.';
    status.error = errorMessage(error);
    jobState.finishedAt = Date.now();
    queue.reopen();
    cache.reopen();
    app.log.error({ err: error }, 'account deletion failed');
  }
}

export function registerAccountRoutes(ctx: AppContext): void {
  const { app, db, settings } = ctx;

  app.get('/api/account/deletion', async (request) => {
    const current = activeJob();
    if (!current) throw new ApiError(404, 'No deletion is in progress.');
    const token = (request.query as { token?: unknown }).token;
    if (typeof token !== 'string' || token.length < 20) {
      throw new ApiError(404, 'No deletion is in progress.');
    }
    // Tokens are high-entropy random values. Compare hashes so a timing signal
    // cannot be used to probe an in-flight deletion.
    const expected = Buffer.from(current.token);
    const supplied = Buffer.from(token);
    if (expected.length !== supplied.length || !expected.equals(supplied)) {
      throw new ApiError(404, 'No deletion is in progress.');
    }
    return { deletion: statusOf(current) };
  });

  app.post('/api/account/delete', async (request, reply) => {
    if (!deleteLimiter.allow(request.ip)) {
      throw new ApiError(429, 'Too many deletion attempts. Wait a few minutes and try again.');
    }
    const current = activeJob();
    if (current?.status.phase === 'running' || current?.status.phase === 'finalizing') {
      throw new ApiError(409, 'A deletion is already in progress.');
    }

    const body = (request.body ?? {}) as {
      password?: unknown;
      confirm?: unknown;
      deleteRepository?: unknown;
    };
    if (body.confirm !== 'DELETE') {
      throw new ApiError(400, 'Type DELETE to confirm you want to erase this library.');
    }
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password) throw new ApiError(400, 'Enter your password to delete the library.');
    const stored = settings.passwordHash;
    const valid = stored ? await verifyPassword(password, stored) : false;
    if (!valid) {
      await sleep(400);
      throw new ApiError(401, 'That password is not correct.');
    }

    const deleteRepository = body.deleteRepository === true;
    if (deleteRepository && !settings.github) {
      throw new ApiError(400, 'GitHub storage is not configured, so there is no repository to delete.');
    }

    deleteLimiter.reset(request.ip);
    const token = randomToken(32);
    const jobState: DeletionJob = {
      token,
      startedAt: Date.now(),
      finishedAt: null,
      status: {
        phase: 'running',
        message: 'Preparing to delete your library…',
        processed: 0,
        total: 0,
        failed: 0,
        repositoryDeleted: false,
        error: null,
      },
    };
    job = jobState;
    // Send the token before work starts so the browser can follow progress even
    // after the library settings (and every session) are removed.
    reply.header('cache-control', 'no-store');
    reply.code(202).send({ deletion: statusOf(jobState), token });
    setTimeout(() => void runDeletion(ctx, jobState, deleteRepository), 25);
  });
}
