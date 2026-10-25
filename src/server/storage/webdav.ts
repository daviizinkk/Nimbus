import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import type { RequestInit as FetchRequestInit, Response as FetchResponse } from 'undici';
import type { ProviderTestResult } from '../../../shared/types.js';
import type { WebdavConfig } from '../settings.js';
import type { ByteRange } from '../utils.js';
import { parseContentRange, providerHttpError, rangeHeader, storageFetch } from './http.js';
import type { Locator, ProviderDownload, StorageProvider } from './types.js';
import { ProviderError } from './types.js';

function encodePath(segment: string): string {
  return segment
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

export class WebdavProvider implements StorageProvider {
  readonly id = 'webdav' as const;
  readonly maxUploadBytes = Number.POSITIVE_INFINITY;
  private readonly base: string;
  private readonly folderSegments: string[];
  private readonly authHeader: Record<string, string>;
  private folderPromise: Promise<void> | null = null;

  constructor(private readonly config: WebdavConfig) {
    this.base = config.url.replace(/\/+$/, '');
    this.folderSegments = config.folder.split('/').filter(Boolean);
    this.authHeader =
      config.username || config.password
        ? { authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}` }
        : {};
  }

  private collectionUrl(depth: number): string {
    const suffix = this.folderSegments.slice(0, depth).map(encodeURIComponent).join('/');
    return suffix ? `${this.base}/${suffix}/` : `${this.base}/`;
  }

  private fileUrl(name: string): string {
    const suffix = this.folderSegments.map(encodeURIComponent).join('/');
    return `${this.base}/${suffix ? `${suffix}/` : ''}${encodeURIComponent(name)}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...this.authHeader,
      'user-agent': 'Nimbus-Vault/1.1',
      ...extra,
    };
  }

  private async ensureFolder(): Promise<void> {
    if (this.folderPromise) return this.folderPromise;
    this.folderPromise = (async () => {
      for (let depth = 1; depth <= this.folderSegments.length; depth++) {
        const url = this.collectionUrl(depth);
        let response: FetchResponse;
        try {
          response = await storageFetch(url, {
            method: 'MKCOL',
            headers: this.headers(),
            signal: AbortSignal.timeout(30_000),
          });
        } catch (error) {
          throw new ProviderError(`Could not reach WebDAV server: ${(error as Error).message}`, 502);
        }
        if (response.ok || response.status === 405 || response.status === 301) {
          continue;
        }
        if (response.status === 401) throw await providerHttpError(response, 'Create WebDAV folder');
        throw await providerHttpError(response, `Create WebDAV folder “${this.collectionUrl(depth)}”`);
      }
    })();
    try {
      await this.folderPromise;
    } catch (error) {
      this.folderPromise = null;
      throw error;
    }
  }

  async put(
    itemId: string,
    extension: string,
    _displayName: string,
    filePath: string,
    size: number,
    mime: string,
  ): Promise<Locator> {
    await this.ensureFolder();
    const name = `${itemId}${extension}`;
    const url = this.fileUrl(name);
    let response: FetchResponse;
    try {
      response = await storageFetch(url, {
        method: 'PUT',
        headers: this.headers({
          'content-type': mime || 'application/octet-stream',
          'content-length': String(size),
        }),
        body: createReadStream(filePath),
        duplex: 'half',
      });
    } catch (error) {
      throw new ProviderError(`WebDAV upload failed: ${(error as Error).message}`, 502);
    }
    if (!response.ok) throw await providerHttpError(response, 'Upload to WebDAV');
    await response.body?.cancel().catch(() => {});
    return { file: name, folder: this.folderSegments.join('/') };
  }

  async get(locator: Locator, range?: ByteRange): Promise<ProviderDownload> {
    const name = typeof locator.file === 'string' ? locator.file : '';
    if (!name || name.includes('/') || name.includes('\\')) {
      throw new ProviderError('Invalid WebDAV locator.', 500);
    }
    let response: FetchResponse;
    try {
      response = await storageFetch(this.fileUrl(name), {
        headers: this.headers(rangeHeader(range)),
        redirect: 'follow',
      });
    } catch (error) {
      throw new ProviderError(`Could not download from WebDAV: ${(error as Error).message}`, 502);
    }
    if (!response.ok) throw await providerHttpError(response, 'Download from WebDAV');
    if (!response.body) throw new ProviderError('WebDAV returned an empty response.', 502);

    const contentRange = parseContentRange(response.headers.get('content-range'));
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    let start = 0;
    let end = contentLength > 0 ? contentLength - 1 : 0;
    let total = contentLength;
    if (contentRange && Number.isFinite(contentRange.total)) {
      start = contentRange.start;
      end = contentRange.end;
      total = contentRange.total;
    }

    return {
      stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      size: total,
      start,
      end,
      status: response.status === 206 ? 206 : 200,
      contentLength: contentRange ? contentRange.end - contentRange.start + 1 : contentLength || end - start + 1,
    };
  }

  async delete(locator: Locator): Promise<void> {
    const name = typeof locator.file === 'string' ? locator.file : '';
    if (!name) return;
    let response: FetchResponse;
    try {
      response = await storageFetch(this.fileUrl(name), {
        method: 'DELETE',
        headers: this.headers(),
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      throw new ProviderError(`Could not delete from WebDAV: ${(error as Error).message}`, 502);
    }
    if (response.status === 404 || response.ok) return;
    throw await providerHttpError(response, 'Delete from WebDAV');
  }

  async test(): Promise<ProviderTestResult> {
    const probeName = `.nimbus-test-${Date.now()}`;
    try {
      await this.ensureFolder();
      const upload = await storageFetch(this.fileUrl(probeName), {
        method: 'PUT',
        headers: this.headers({ 'content-type': 'text/plain', 'content-length': '7' }),
        body: 'nimbus',
        signal: AbortSignal.timeout(45_000),
      });
      if (!upload.ok) throw await providerHttpError(upload, 'Write test file to WebDAV');
      await upload.body?.cancel().catch(() => {});

      const download = await storageFetch(this.fileUrl(probeName), {
        headers: this.headers(),
        signal: AbortSignal.timeout(45_000),
      });
      if (!download.ok) throw await providerHttpError(download, 'Read test file from WebDAV');
      const text = await download.text();
      if (text !== 'nimbus') throw new Error('Read-back mismatch');

      await storageFetch(this.fileUrl(probeName), {
        method: 'DELETE',
        headers: this.headers(),
        signal: AbortSignal.timeout(45_000),
      }).catch(() => {});

      return {
        ok: true,
        message: 'WebDAV storage is ready.',
        warning:
          this.base.startsWith('http://') && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(this.base)
            ? 'This WebDAV URL uses plain HTTP. Use HTTPS to protect your credentials and files in transit.'
            : undefined,
        details: {
          server: new URL(this.base).host,
          folder: this.folderSegments.join('/'),
        },
      };
    } catch (error) {
      await storageFetch(this.fileUrl(probeName), {
        method: 'DELETE',
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
      return {
        ok: false,
        message: error instanceof ProviderError ? error.message : `WebDAV test failed: ${(error as Error).message}`,
      };
    }
  }
}
