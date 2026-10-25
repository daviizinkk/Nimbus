import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { RequestInit as FetchRequestInit, Response as FetchResponse } from 'undici';
import type { ProviderTestResult } from '../../../shared/types.js';
import type { GithubConfig } from '../settings.js';
import { sha256 } from '../crypto.js';
import type { ByteRange } from '../utils.js';
import {
  parseContentRange,
  providerHttpError,
  rangeHeader,
  storageFetch,
} from './http.js';
import type { Locator, ProviderDownload, StorageProvider } from './types.js';
import { ProviderError } from './types.js';

const API = 'https://api.github.com';
const UPLOADS = 'https://uploads.github.com';
// GitHub allows release assets up to 2 GiB, but Nimbus splits at 1 GiB so each
// part stays comfortably below the limit, retries are cheaper, and the
// documented "1 GiB parts" behaviour is exact. A 100 GB library still fits in
// a few hundred assets.
export const GITHUB_CHUNK_BYTES = 1024 * 1024 * 1024;
const MAX_LIBRARY_BYTES = 100 * 1024 * 1024 * 1024;
// GitHub rejects more than 1,000 assets on a single release. Nimbus rotates to
// numbered releases so a large library keeps uploading instead of hitting a
// hard wall. Existing locators reference asset IDs, so older files stay valid.
const MAX_ASSETS_PER_RELEASE = 1000;
const MAX_RELEASE_SHARDS = 1000;
const RELEASE_BODY_MARKER = 'managed by Nimbus';

interface ReleaseState {
  id: number;
  tag: string;
  assets: number;
}

/** Files larger than 1 GiB are split into one asset per 1 GiB part. */
export function shouldChunkGithubFile(size: number): boolean {
  return size > GITHUB_CHUNK_BYTES;
}

export interface GithubChunkPart {
  releaseId: number;
  releaseTag: string;
  assetId: number;
  name: string;
  offset: number;
  size: number;
}

export interface ChunkPlanEntry {
  /** Index into the parts array. */
  part: number;
  /** Inclusive range relative to the start of that part. */
  localStart: number;
  localEnd: number;
  /** Inclusive range in the assembled file. */
  start: number;
  end: number;
}

/** Splits a byte count into chunk ranges. */
export function chunkRanges(size: number, chunkSize = GITHUB_CHUNK_BYTES): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(chunkSize) || chunkSize <= 0) return ranges;
  for (let start = 0; start < size; start += chunkSize) {
    ranges.push({ start, end: Math.min(size, start + chunkSize) - 1 });
  }
  return ranges;
}

/**
 * Works out which chunk parts overlap a requested range. This is pure math so
 * range stitching can be tested without mocking the GitHub API.
 */
export function planChunkRead(
  parts: Array<{ offset: number; size: number }>,
  range?: ByteRange,
): ChunkPlanEntry[] {
  const total = parts.reduce((sum, part) => sum + part.size, 0);
  if (total <= 0) return [];
  const start = range ? Math.max(0, range.start) : 0;
  const end = range ? Math.min(total - 1, range.end) : total - 1;
  if (start > end) return [];
  const plan: ChunkPlanEntry[] = [];
  parts.forEach((part, index) => {
    const partStart = part.offset;
    const partEnd = part.offset + part.size - 1;
    if (partEnd < start || partStart > end) return;
    plan.push({
      part: index,
      localStart: Math.max(start, partStart) - partStart,
      localEnd: Math.min(end, partEnd) - partStart,
      start: Math.max(start, partStart),
      end: Math.min(end, partEnd),
    });
  });
  return plan;
}

function parseChunkParts(locator: Locator): GithubChunkPart[] | null {
  if (!Array.isArray(locator.parts)) return null;
  const parts: GithubChunkPart[] = [];
  for (const raw of locator.parts) {
    if (!raw || typeof raw !== 'object') throw new ProviderError('Invalid chunked GitHub locator.', 500);
    const entry = raw as Record<string, unknown>;
    const assetId = Number(entry.assetId);
    const offset = Number(entry.offset);
    const size = Number(entry.size);
    if (
      !Number.isFinite(assetId) ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size <= 0
    ) {
      throw new ProviderError('Invalid chunked GitHub locator.', 500);
    }
    parts.push({
      releaseId: Number(entry.releaseId),
      releaseTag: typeof entry.releaseTag === 'string' ? entry.releaseTag : '',
      assetId,
      name: typeof entry.name === 'string' ? entry.name : '',
      offset,
      size,
    });
  }
  parts.sort((left, right) => left.offset - right.offset);
  let expected = 0;
  for (const part of parts) {
    if (part.offset !== expected) throw new ProviderError('Chunked GitHub locator has a gap.', 500);
    expected += part.size;
  }
  return parts;
}

// Provider instances are created per operation, so release state is shared at
// module scope and keyed by repository + tag + token.
const releaseStates = new Map<string, ReleaseState>();
const releaseTasks = new Map<string, Promise<ReleaseState>>();

/** Returns the release tag for a shard. The first shard keeps the chosen tag. */
export function releaseTagForShard(baseTag: string, shard: number): string {
  if (shard <= 1) return baseTag;
  const suffix = `-${shard}`;
  return `${baseTag.slice(0, Math.max(1, 80 - suffix.length))}${suffix}`;
}

function apiHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'Nimbus-Vault/1.1',
    ...extra,
  };
}

async function githubFetch(
  token: string,
  url: string,
  init: FetchRequestInit = {},
  timeoutMs = 45_000,
): Promise<FetchResponse> {
  try {
    return await storageFetch(url, {
      ...init,
      headers: apiHeaders(token, init.headers as Record<string, string> | undefined),
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const message = (error as Error).name === 'TimeoutError' ? 'GitHub request timed out.' : `Could not reach GitHub: ${(error as Error).message}`;
    throw new ProviderError(message, 502);
  }
}

export interface GithubRepositoryInfo {
  owner: string;
  repo: string;
  private: boolean;
  login: string;
  releaseId: number;
}

export class GithubProvider implements StorageProvider {
  readonly id = 'github' as const;
  // Chunking lifts the old 2 GB per-file ceiling. The repository itself is
  // capped at 100 GB by GitHub, so a larger single file cannot fit.
  readonly maxUploadBytes = MAX_LIBRARY_BYTES;
  private readonly config: GithubConfig;
  private readonly cacheKey: string;

  constructor(config: GithubConfig) {
    this.config = config;
    this.cacheKey = `${config.owner}/${config.repo}/${config.releaseTag}/${sha256(config.token).slice(0, 10)}`;
  }

  private repoUrl(suffix = ''): string {
    return `${API}/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}${suffix}`;
  }

  private invalidateRelease(): void {
    // Keep an in-flight lookup: it is already searching for the next release
    // with capacity, and concurrent uploads should share that result.
    releaseStates.delete(this.cacheKey);
  }

  private async countReleaseAssets(releaseId: number): Promise<number> {
    const response = await githubFetch(
      this.config.token,
      this.repoUrl(`/releases/${releaseId}/assets?per_page=1`),
    );
    if (!response.ok) throw await providerHttpError(response, 'Count GitHub release assets');
    const body = (await response.json()) as unknown[];
    // With per_page=1, the last Link page equals the total number of assets.
    const link = response.headers.get('link') ?? '';
    const last = /[?&]page=(\d+)>;\s*rel="last"/.exec(link);
    return last ? Number.parseInt(last[1], 10) : Array.isArray(body) ? body.length : 0;
  }

  private async createRelease(tag: string, shard: number): Promise<ReleaseState> {
    const created = await githubFetch(this.config.token, this.repoUrl('/releases'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tag_name: tag,
        name: shard === 1 ? 'Nimbus storage' : `Nimbus storage (part ${shard})`,
        body:
          shard === 1
            ? 'Storage release managed by Nimbus. Please do not delete assets from this release.'
            : `Storage release part ${shard} managed by Nimbus. New assets move here when earlier releases reach GitHub's per-release limit.`,
        draft: false,
        prerelease: false,
      }),
    });
    if (created.ok) {
      const body = (await created.json()) as { id: number };
      return { id: body.id, tag, assets: 0 };
    }
    // A concurrent request may have created it first.
    if (created.status === 422) {
      const retry = await githubFetch(
        this.config.token,
        this.repoUrl(`/releases/tags/${encodeURIComponent(tag)}`),
      );
      if (retry.ok) {
        const body = (await retry.json()) as { id: number };
        return { id: body.id, tag, assets: await this.countReleaseAssets(body.id) };
      }
    }
    throw await providerHttpError(created, 'Create GitHub storage release');
  }

  private async discoverRelease(): Promise<ReleaseState> {
    for (let shard = 1; shard <= MAX_RELEASE_SHARDS; shard++) {
      const tag = releaseTagForShard(this.config.releaseTag, shard);
      const tagResponse = await githubFetch(
        this.config.token,
        this.repoUrl(`/releases/tags/${encodeURIComponent(tag)}`),
      );
      let state: ReleaseState;
      if (tagResponse.ok) {
        const release = (await tagResponse.json()) as { id: number; body?: string | null };
        if (shard > 1 && !String(release.body ?? '').includes(RELEASE_BODY_MARKER)) {
          throw new ProviderError(
            `The release tag "${tag}" already exists but was not created by Nimbus. Choose another release tag.`,
            409,
          );
        }
        state = { id: release.id, tag, assets: await this.countReleaseAssets(release.id) };
      } else if (tagResponse.status === 404) {
        state = await this.createRelease(tag, shard);
      } else {
        throw await providerHttpError(tagResponse, 'Look up GitHub release');
      }

      if (state.assets < MAX_ASSETS_PER_RELEASE) {
        releaseStates.set(this.cacheKey, state);
        return state;
      }
    }
    throw new ProviderError(
      'GitHub storage has reached its release limit. Switch to WebDAV for this library or start a new repository.',
      507,
    );
  }

  private async ensureRelease(force = false): Promise<ReleaseState> {
    if (force) this.invalidateRelease();
    const cached = releaseStates.get(this.cacheKey);
    if (cached) return cached;
    const pending = releaseTasks.get(this.cacheKey);
    if (pending) return pending;

    const task = this.discoverRelease();
    releaseTasks.set(this.cacheKey, task);
    try {
      const state = await task;
      // A concurrent force-refresh may have cleared the cache while this
      // lookup was running; publish its result if nothing newer replaced it.
      if (!releaseStates.has(this.cacheKey)) releaseStates.set(this.cacheKey, state);
      return state;
    } finally {
      if (releaseTasks.get(this.cacheKey) === task) releaseTasks.delete(this.cacheKey);
    }
  }

  /**
   * Picks a release with capacity and reserves one asset slot. Reservation is
   * synchronous after the await, so concurrent uploads cannot overfill a shard.
   */
  private async acquireRelease(force = false): Promise<ReleaseState> {
    let state = await this.ensureRelease(force);
    if (state.assets >= MAX_ASSETS_PER_RELEASE) {
      state = await this.ensureRelease(true);
    }
    if (state.assets >= MAX_ASSETS_PER_RELEASE) {
      throw new ProviderError('GitHub storage has no room left in its current release.', 507);
    }
    state.assets += 1;
    return state;
  }

  private releaseFailed(state: ReleaseState): void {
    if (releaseStates.get(this.cacheKey) === state && state.assets > 0) state.assets -= 1;
  }

  private async uploadAsset(
    filePath: string,
    assetName: string,
    label: string,
    start: number,
    end: number,
    mime: string,
  ): Promise<{ release: ReleaseState; assetId: number }> {
    const length = Math.max(0, end - start + 1);
    const upload = async (
      forceReleaseRefresh: boolean,
      capacityRetry: boolean,
    ): Promise<{ release: ReleaseState; assetId: number }> => {
      const release = await this.acquireRelease(forceReleaseRefresh);
      const url = new URL(
        `${UPLOADS}/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}/releases/${release.id}/assets`,
      );
      url.searchParams.set('name', assetName);
      if (label) url.searchParams.set('label', label.slice(0, 120));
      const body = length > 0 ? createReadStream(filePath, { start, end }) : createReadStream(filePath);

      let response: FetchResponse;
      try {
        response = await storageFetch(url, {
          method: 'POST',
          headers: apiHeaders(this.config.token, {
            'content-type': mime || 'application/octet-stream',
            'content-length': String(length),
          }),
          body,
          duplex: 'half',
        });
      } catch (error) {
        this.releaseFailed(release);
        throw new ProviderError(`GitHub upload failed: ${(error as Error).message}`, 502);
      }

      if (!response.ok) {
        this.releaseFailed(release);
        // The cached release can go stale if the user deletes it in GitHub.
        if (response.status === 404 && !forceReleaseRefresh) return upload(true, capacityRetry);
        // A full release returns 422. Rescan and try the next shard once.
        if (response.status === 422 && !capacityRetry) return upload(true, true);
        throw await providerHttpError(response, 'Upload file to GitHub');
      }
      const asset = (await response.json()) as { id: number };
      return { release, assetId: asset.id };
    };

    return upload(false, false);
  }

  async put(
    itemId: string,
    extension: string,
    displayName: string,
    filePath: string,
    size: number,
    mime: string,
  ): Promise<Locator> {
    if (size > this.maxUploadBytes) {
      throw new ProviderError(
        'GitHub repositories are limited to about 100 GB. Use WebDAV or local storage for a library larger than that.',
        413,
      );
    }

    if (!shouldChunkGithubFile(size)) {
      const assetName = `${itemId}${extension}`;
      const result = await this.uploadAsset(
        filePath,
        assetName,
        displayName,
        0,
        Math.max(0, size - 1),
        mime,
      );
      return {
        releaseId: result.release.id,
        releaseTag: result.release.tag,
        assetId: result.assetId,
        name: assetName,
      };
    }

    const ranges = chunkRanges(size, GITHUB_CHUNK_BYTES);
    // A random suffix avoids collisions if an earlier attempt left an orphaned
    // asset behind after a failed rollback.
    const token = sha256(`${itemId}:${size}:${Date.now()}:${Math.random()}`).slice(0, 8);
    const parts: GithubChunkPart[] = [];

    try {
      for (let index = 0; index < ranges.length; index += 1) {
        const chunk = ranges[index];
        const partName = `${itemId}.p${String(index + 1).padStart(3, '0')}-${token}${extension}`;
        const label = `${displayName} (part ${index + 1} of ${ranges.length})`;
        const result = await this.uploadAsset(
          filePath,
          partName,
          label,
          chunk.start,
          chunk.end,
          mime,
        );
        parts.push({
          releaseId: result.release.id,
          releaseTag: result.release.tag,
          assetId: result.assetId,
          name: partName,
          offset: chunk.start,
          size: chunk.end - chunk.start + 1,
        });
      }
    } catch (error) {
      // Never leave half an object behind: the locator is not saved until all
      // parts succeed, so partial uploads would otherwise be unreachable.
      await Promise.allSettled(parts.map((part) => this.deleteAsset(part.assetId)));
      throw error;
    }

    return { chunked: true, size, parts };
  }

  private async downloadAsset(assetId: number, range?: ByteRange): Promise<ProviderDownload> {
    const url = this.repoUrl(`/releases/assets/${assetId}`);

    let response: FetchResponse;
    try {
      response = await storageFetch(url, {
        headers: {
          ...apiHeaders(this.config.token),
          accept: 'application/octet-stream',
          ...rangeHeader(range),
        },
        redirect: 'follow',
      });
    } catch (error) {
      throw new ProviderError(`Could not download from GitHub: ${(error as Error).message}`, 502);
    }
    if (!response.ok) throw await providerHttpError(response, 'Download file from GitHub');
    if (!response.body) throw new ProviderError('GitHub returned an empty response.', 502);

    const contentRange = parseContentRange(response.headers.get('content-range'));
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    let start = 0;
    let end = contentLength > 0 ? contentLength - 1 : 0;
    let size = contentLength;
    if (contentRange && Number.isFinite(contentRange.total)) {
      start = contentRange.start;
      end = contentRange.end;
      size = contentRange.total;
    } else if (range && response.status === 206) {
      throw new ProviderError('GitHub returned an invalid partial response.', 502);
    }

    return {
      stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      size,
      start,
      end,
      status: response.status === 206 ? 206 : 200,
      contentLength: contentRange ? contentRange.end - contentRange.start + 1 : contentLength || end - start + 1,
    };
  }

  private async getChunked(
    locator: Locator,
    parts: GithubChunkPart[],
    range?: ByteRange,
  ): Promise<ProviderDownload> {
    const total = parts.reduce((sum, part) => sum + part.size, 0);
    const declared = Number(locator.size);
    if (!Number.isFinite(declared) || declared !== total) {
      throw new ProviderError('Chunked GitHub locator has an inconsistent size.', 500);
    }

    const plan = planChunkRead(parts, range);
    if (plan.length === 0) throw new ProviderError('The requested range is not available.', 416);
    const start = range ? range.start : 0;
    const end = range ? range.end : total - 1;
    const provider = this;

    async function* stitch(): AsyncGenerator<Buffer> {
      for (const entry of plan) {
        const part = parts[entry.part];
        const download = await provider.downloadAsset(part.assetId, {
          start: entry.localStart,
          end: entry.localEnd,
        });
        try {
          // S3 normally honours Range, but slicing defensively here means a
          // provider that returns the whole part cannot corrupt a ranged read.
          let skip = entry.localStart - download.start;
          let remaining = entry.localEnd - entry.localStart + 1;
          if (skip < 0) throw new ProviderError('GitHub returned an unexpected partial response.', 502);
          for await (const chunk of download.stream) {
            let buffer = chunk as Buffer;
            if (skip >= buffer.length) {
              skip -= buffer.length;
              continue;
            }
            if (skip > 0) {
              buffer = buffer.subarray(skip);
              skip = 0;
            }
            if (buffer.length >= remaining) {
              yield buffer.subarray(0, remaining);
              remaining = 0;
              break;
            }
            yield buffer;
            remaining -= buffer.length;
          }
          if (remaining > 0) throw new ProviderError('GitHub ended the download early.', 502);
        } finally {
          download.stream.destroy();
        }
      }
    }

    return {
      stream: Readable.from(stitch()),
      size: total,
      start,
      end,
      status: range ? 206 : 200,
      contentLength: end - start + 1,
    };
  }

  async get(locator: Locator, range?: ByteRange): Promise<ProviderDownload> {
    const parts = parseChunkParts(locator);
    if (parts) return this.getChunked(locator, parts, range);

    const assetId = Number(locator.assetId);
    if (!Number.isFinite(assetId)) throw new ProviderError('Invalid GitHub asset locator.', 500);
    return this.downloadAsset(assetId, range);
  }

  private async deleteAsset(assetId: number): Promise<void> {
    const response = await githubFetch(this.config.token, this.repoUrl(`/releases/assets/${assetId}`), {
      method: 'DELETE',
    });
    if (response.status === 404 || response.status === 204 || response.ok) return;
    throw await providerHttpError(response, 'Delete file from GitHub');
  }

  async delete(locator: Locator): Promise<void> {
    const parts = parseChunkParts(locator);
    if (parts) {
      let firstError: unknown = null;
      for (const part of parts) {
        try {
          await this.deleteAsset(part.assetId);
        } catch (error) {
          firstError = firstError ?? error;
        }
      }
      if (firstError) throw firstError;
      return;
    }

    const assetId = Number(locator.assetId);
    if (!Number.isFinite(assetId)) return;
    await this.deleteAsset(assetId);
  }

  async test(): Promise<ProviderTestResult> {
    try {
      const userResponse = await githubFetch(this.config.token, `${API}/user`);
      if (!userResponse.ok) throw await providerHttpError(userResponse, 'Authenticate with GitHub');
      const user = (await userResponse.json()) as { login: string };

      const repoResponse = await githubFetch(this.config.token, this.repoUrl());
      if (!repoResponse.ok) throw await providerHttpError(repoResponse, 'Open GitHub repository');
      const repo = (await repoResponse.json()) as {
        private: boolean;
        permissions?: { push?: boolean };
        default_branch?: string;
      };

      const release = await this.ensureRelease();
      const details = {
        login: user.login,
        repository: `${this.config.owner}/${this.config.repo}`,
        private: repo.private,
        writeAccess: Boolean(repo.permissions?.push) ? 'yes' : 'unknown',
        releaseId: release.id,
        releaseTag: release.tag,
        releaseAssets: release.assets,
        defaultBranch: repo.default_branch ?? '',
      };

      if (!repo.private) {
        return {
          ok: false,
          message:
            'Connected to GitHub, but this repository is public. Nimbus will not store a private library in a public repository.',
          warning: 'Make the repository private in GitHub → Settings → General → Danger Zone.',
          details,
        };
      }
      if (repo.permissions && repo.permissions.push === false) {
        return {
          ok: false,
          message: 'Connected to GitHub, but this token cannot write to the repository.',
          warning: 'Use a token with Contents: read & write (fine-grained) or the repo scope (classic).',
          details,
        };
      }

      return {
        ok: true,
        message: 'GitHub storage is ready. Files are stored as assets on private releases.',
        details,
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof ProviderError ? error.message : `GitHub test failed: ${(error as Error).message}`,
      };
    }
  }
}

export interface GithubCleanupResult {
  /** Releases that matched Nimbus ownership and were removed (or already gone). */
  releases: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns true when a release tag belongs to a Nimbus storage shard. The first
 * shard uses the configured tag; later shards append -2, -3, and so on.
 */
export function isNimbusReleaseTag(baseTag: string, tag: string): boolean {
  if (!baseTag || !tag) return false;
  return new RegExp(`^${escapeRegExp(baseTag)}(?:-\\d+)?$`).test(tag);
}

/**
 * Deletes every Nimbus-managed storage release in the configured repository.
 * GitHub removes all assets with the release. Releases Nimbus did not create
 * are never touched. Used by the uninstaller's "delete GitHub data" option.
 */
export async function deleteNimbusGithubReleases(config: GithubConfig): Promise<GithubCleanupResult> {
  const repoUrl = `${API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  const releases: Array<{ id: number; tag_name: string; body?: string | null }> = [];

  for (let page = 1; page <= 20; page += 1) {
    const response = await githubFetch(config.token, `${repoUrl}/releases?per_page=100&page=${page}`);
    if (response.status === 404) return { releases: 0 };
    if (!response.ok) throw await providerHttpError(response, 'List GitHub releases');
    const batch = (await response.json()) as Array<{ id: number; tag_name: string; body?: string | null }>;
    if (!Array.isArray(batch) || batch.length === 0) break;
    releases.push(...batch);
    if (batch.length < 100) break;
  }

  const managed = releases.filter(
    (release) =>
      isNimbusReleaseTag(config.releaseTag, release.tag_name) ||
      String(release.body ?? '').includes(RELEASE_BODY_MARKER),
  );

  let removed = 0;
  for (const release of managed) {
    const response = await githubFetch(config.token, `${repoUrl}/releases/${release.id}`, {
      method: 'DELETE',
    });
    if (response.status === 404 || response.status === 204 || response.ok) {
      removed += 1;
      continue;
    }
    throw await providerHttpError(response, 'Delete GitHub storage release');
  }
  return { releases: removed };
}

export interface CreateRepoResult {
  owner: string;
  repo: string;
  private: boolean;
  created: boolean;
}

/**
 * Deletes the configured repository. The token needs Administration: read &
 * write (fine-grained) or the delete_repo scope (classic). A missing repository
 * counts as success so a retried account deletion stays idempotent.
 */
export async function deleteGithubRepository(config: GithubConfig): Promise<void> {
  const response = await githubFetch(
    config.token,
    `${API}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`,
    { method: 'DELETE' },
  );
  if (response.status === 404 || response.status === 204 || response.ok) return;
  throw await providerHttpError(response, 'Delete GitHub repository');
}

export async function createPrivateGithubRepo(token: string, repoName: string): Promise<CreateRepoResult> {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repoName)) {
    throw new ProviderError('Repository name may only contain letters, numbers, dots, dashes and underscores.', 400);
  }

  const userResponse = await storageFetch(`${API}/user`, { headers: apiHeaders(token) });
  if (!userResponse.ok) throw await providerHttpError(userResponse, 'Authenticate with GitHub');
  const user = (await userResponse.json()) as { login: string };

  const existing = await storageFetch(`${API}/repos/${encodeURIComponent(user.login)}/${encodeURIComponent(repoName)}`, {
    headers: apiHeaders(token),
  });
  if (existing.ok) {
    const repo = (await existing.json()) as { private: boolean };
    if (!repo.private) {
      throw new ProviderError(
        `A public repository named ${repoName} already exists. Choose another name or make that repository private.`,
        409,
      );
    }
    return { owner: user.login, repo: repoName, private: true, created: false };
  }
  if (existing.status !== 404) throw await providerHttpError(existing, 'Look up GitHub repository');

  const created = await storageFetch(`${API}/user/repos`, {
    method: 'POST',
    headers: apiHeaders(token, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      name: repoName,
      private: true,
      // Releases need an existing commit to tag; initialize an empty repo.
      auto_init: true,
      description: 'Private Nimbus file library',
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!created.ok) throw await providerHttpError(created, 'Create GitHub repository');
  return { owner: user.login, repo: repoName, private: true, created: true };
}
