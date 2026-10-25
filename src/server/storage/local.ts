import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ProviderTestResult } from '../../../shared/types.js';
import type { ByteRange } from '../utils.js';
import type { Locator, ProviderDownload, StorageProvider } from './types.js';
import { ProviderError } from './types.js';

export class LocalProvider implements StorageProvider {
  readonly id = 'local' as const;
  readonly maxUploadBytes = Number.POSITIVE_INFINITY;

  constructor(private readonly root: string) {}

  private resolve(locator: Locator): string {
    const name = typeof locator.file === 'string' ? locator.file : '';
    const safe = path.basename(name);
    if (!safe || safe !== name) throw new ProviderError('Invalid local storage locator.', 500);
    return path.join(this.root, safe);
  }

  async put(itemId: string, extension: string, _displayName: string, filePath: string): Promise<Locator> {
    return this.importFile(itemId, extension, filePath);
  }

  async get(locator: Locator, range?: ByteRange): Promise<ProviderDownload> {
    const file = this.resolve(locator);
    let info;
    try {
      info = await stat(file);
    } catch {
      throw new ProviderError('This file is missing from local storage.', 404);
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, info.size - 1);
    return {
      stream: createReadStream(file, range ? { start, end } : undefined),
      size: info.size,
      start,
      end,
      status: range ? 206 : 200,
      contentLength: Math.max(0, end - start + 1),
    };
  }

  async delete(locator: Locator): Promise<void> {
    await unlink(this.resolve(locator)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  async importFile(itemId: string, extension: string, sourcePath: string): Promise<Locator> {
    await mkdir(this.root, { recursive: true });
    const name = `${itemId}${extension}`;
    const target = path.join(this.root, name);
    try {
      await rename(sourcePath, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        await pipeline(createReadStream(sourcePath), createWriteStream(target));
        await unlink(sourcePath).catch(() => {});
      } else {
        throw error;
      }
    }
    return { file: name };
  }

  async test(): Promise<ProviderTestResult> {
    try {
      await mkdir(this.root, { recursive: true });
      const probe = path.join(this.root, `.nimbus-test-${Date.now()}`);
      await writeFile(probe, 'nimbus');
      const content = await new Promise<string>((resolve, reject) => {
        let value = '';
        const stream = createReadStream(probe);
        stream.on('data', (chunk) => {
          value += chunk.toString();
        });
        stream.on('end', () => resolve(value));
        stream.on('error', reject);
      });
      await unlink(probe);
      if (content !== 'nimbus') throw new Error('Read-back mismatch');
      return {
        ok: true,
        message: 'Local storage is ready.',
        details: { path: this.root },
      };
    } catch (error) {
      return {
        ok: false,
        message: `Local storage is not writable: ${(error as Error).message}`,
        details: { path: this.root },
      };
    }
  }
}

export async function moveIntoLocalStore(
  provider: LocalProvider,
  itemId: string,
  extension: string,
  tempPath: string,
): Promise<Locator> {
  return provider.importFile(itemId, extension, tempPath);
}

/** Copies a local library file into the cache directory. */
export async function copyFileTo(source: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await copyFile(source, target);
  } catch (error) {
    throw error;
  }
}
