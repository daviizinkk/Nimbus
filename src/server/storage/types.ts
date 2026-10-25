import type { Readable } from 'node:stream';
import type { ProviderId, ProviderTestResult } from '../../../shared/types.js';
import type { ByteRange } from '../utils.js';

export type Locator = Record<string, unknown>;

export interface ProviderDownload {
  stream: Readable;
  /** Total size of the full object. */
  size: number;
  /** Inclusive range returned. */
  start: number;
  end: number;
  /** 200 for a full body, 206 for a partial body. */
  status: 200 | 206;
  contentLength: number;
}

export interface StorageProvider {
  readonly id: ProviderId;
  readonly maxUploadBytes: number;
  put(
    itemId: string,
    extension: string,
    displayName: string,
    filePath: string,
    size: number,
    mime: string,
  ): Promise<Locator>;
  get(locator: Locator, range?: ByteRange): Promise<ProviderDownload>;
  delete(locator: Locator): Promise<void>;
  test(): Promise<ProviderTestResult>;
}

export class ProviderError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 502, code = 'storage_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
