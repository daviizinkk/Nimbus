import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';

/**
 * Encrypted cache format (chunked AES-256-GCM).
 *
 * Header (20 bytes):
 *   0..7   magic "NIMBENC1"
 *   8..11  chunk size, uint32 BE
 *   12..19 total plaintext size, uint64 BE
 *
 * Records (one per chunk, in order):
 *   12-byte random nonce | 16-byte auth tag | ciphertext
 *
 * Fixed record offsets (except the final partial chunk) make HTTP range
 * requests cheap: only the chunks covering the requested range are decrypted.
 */
export const CACHE_MAGIC = Buffer.from('NIMBENC1', 'ascii');
export const CACHE_CHUNK_SIZE = 1024 * 1024;
export const CACHE_HEADER_SIZE = 20;
const NONCE_SIZE = 12;
const TAG_SIZE = 16;
const RECORD_OVERHEAD = NONCE_SIZE + TAG_SIZE;

function buildHeader(totalSize: number): Buffer {
  const header = Buffer.alloc(CACHE_HEADER_SIZE);
  CACHE_MAGIC.copy(header, 0);
  header.writeUInt32BE(CACHE_CHUNK_SIZE, 8);
  header.writeBigUInt64BE(BigInt(totalSize), 12);
  return header;
}

function aadFor(index: number): Buffer {
  return Buffer.from(`nimbus:chunk:${index}`, 'ascii');
}

export function looksEncrypted(buffer: Buffer): boolean {
  return buffer.length >= CACHE_MAGIC.length && buffer.subarray(0, CACHE_MAGIC.length).equals(CACHE_MAGIC);
}

export function encryptedSizeFor(totalSize: number): number {
  const full = Math.floor(totalSize / CACHE_CHUNK_SIZE);
  const remainder = totalSize % CACHE_CHUNK_SIZE;
  return CACHE_HEADER_SIZE + full * (CACHE_CHUNK_SIZE + RECORD_OVERHEAD) + (remainder > 0 ? remainder + RECORD_OVERHEAD : 0);
}

function encryptChunk(plain: Buffer, key: Buffer, index: number): Buffer {
  const nonce = randomBytes(NONCE_SIZE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aadFor(index));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ciphertext]);
}

export interface EncryptedWriteOptions {
  signal?: AbortSignal;
}

/**
 * Encrypts a byte stream into `destPath`. The total plaintext size must be
 * known up front (it is for every item in the library). The caller should
 * write to a temporary file and rename after this resolves.
 */
export async function writeEncryptedFile(
  source: AsyncIterable<Uint8Array>,
  destPath: string,
  totalSize: number,
  key: Buffer,
  options: EncryptedWriteOptions = {},
): Promise<number> {
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) throw new Error('Invalid plaintext size');
  if (key.length !== 32) throw new Error('Invalid cache encryption key');

  const handle = await open(destPath, 'w', 0o600);
  let written = 0;
  let chunkIndex = 0;
  let pending: Buffer[] = [];
  let pendingLength = 0;
  let closed = false;

  const writeChunk = async (plain: Buffer): Promise<void> => {
    if (plain.length === 0) return;
    if (written + plain.length > totalSize) throw new Error('Source is larger than declared size');
    if (options.signal?.aborted) throw new Error('Aborted');
    const record = encryptChunk(plain, key, chunkIndex);
    await handle.write(record);
    written += plain.length;
    chunkIndex += 1;
  };

  const drainPending = async (): Promise<void> => {
    while (pendingLength >= CACHE_CHUNK_SIZE) {
      const merged = Buffer.concat(pending, pendingLength);
      const plain = merged.subarray(0, CACHE_CHUNK_SIZE);
      await writeChunk(plain);
      const remainder = merged.subarray(CACHE_CHUNK_SIZE);
      pending = remainder.length ? [remainder] : [];
      pendingLength = remainder.length;
    }
  };

  try {
    await handle.write(buildHeader(totalSize));
    for await (const chunk of source) {
      if (options.signal?.aborted) throw new Error('Aborted');
      if (chunk.length === 0) continue;
      pending.push(Buffer.from(chunk));
      pendingLength += chunk.length;
      await drainPending();
    }
    if (pendingLength > 0) {
      await writeChunk(Buffer.concat(pending, pendingLength));
      pending = [];
      pendingLength = 0;
    }
    if (written !== totalSize) {
      throw new Error(`Incomplete source: expected ${totalSize} bytes, received ${written}`);
    }
    await handle.sync();
    await handle.close();
    closed = true;
    return written;
  } finally {
    if (!closed) {
      await handle.close().catch(() => {});
    }
  }
}

interface ParsedHeader {
  chunkSize: number;
  totalSize: number;
}

function parseHeader(header: Buffer): ParsedHeader {
  if (!looksEncrypted(header)) throw new Error('Not an encrypted cache file');
  const chunkSize = header.readUInt32BE(8);
  const totalSizeBig = header.readBigUInt64BE(12);
  if (chunkSize < 4096 || chunkSize > 64 * 1024 * 1024) throw new Error('Unsupported cache chunk size');
  if (totalSizeBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Cache file too large');
  return { chunkSize, totalSize: Number(totalSizeBig) };
}

async function readHeader(handle: Awaited<ReturnType<typeof open>>): Promise<ParsedHeader> {
  const header = Buffer.alloc(CACHE_HEADER_SIZE);
  const { bytesRead } = await handle.read(header, 0, CACHE_HEADER_SIZE, 0);
  if (bytesRead !== CACHE_HEADER_SIZE) throw new Error('Truncated encrypted cache file');
  return parseHeader(header);
}

/** Returns plaintext size and whether the file is encrypted. */
export async function cacheFileInfo(file: string): Promise<{ size: number; encrypted: boolean }> {
  const info = await stat(file);
  if (info.size < CACHE_MAGIC.length) return { size: info.size, encrypted: false };
  const handle = await open(file, 'r');
  try {
    const probe = Buffer.alloc(CACHE_MAGIC.length);
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0);
    if (bytesRead === probe.length && looksEncrypted(probe)) {
      const header = await readHeader(handle);
      // Header-only reads are cheap, but a file truncated by an interrupted
      // copy or disk problem must be treated as corrupt rather than served.
      if (info.size < encryptedSizeFor(header.totalSize)) {
        throw new Error('Truncated encrypted cache file');
      }
      return { size: header.totalSize, encrypted: true };
    }
    return { size: info.size, encrypted: false };
  } finally {
    await handle.close();
  }
}

async function* decryptRange(
  file: string,
  key: Buffer,
  start: number,
  end: number,
): AsyncGenerator<Buffer, void, unknown> {
  const handle = await open(file, 'r');
  try {
    const header = await readHeader(handle);
    if (key.length !== 32) throw new Error('Invalid cache encryption key');
    if (start < 0 || end < start || end >= header.totalSize) throw new RangeError('Range outside cache file');

    const firstChunk = Math.floor(start / header.chunkSize);
    const lastChunk = Math.floor(end / header.chunkSize);
    for (let index = firstChunk; index <= lastChunk; index++) {
      const plainLength = Math.min(header.chunkSize, header.totalSize - index * header.chunkSize);
      const recordLength = plainLength + RECORD_OVERHEAD;
      const offset = CACHE_HEADER_SIZE + index * (header.chunkSize + RECORD_OVERHEAD);
      const record = Buffer.allocUnsafe(recordLength);
      const { bytesRead } = await handle.read(record, 0, recordLength, offset);
      if (bytesRead !== recordLength) throw new Error('Truncated encrypted cache chunk');

      const nonce = record.subarray(0, NONCE_SIZE);
      const tag = record.subarray(NONCE_SIZE, NONCE_SIZE + TAG_SIZE);
      const ciphertext = record.subarray(NONCE_SIZE + TAG_SIZE);

      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(aadFor(index));
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

      const chunkStart = index * header.chunkSize;
      const from = Math.max(0, start - chunkStart);
      const to = Math.min(plain.length, end - chunkStart + 1);
      if (to > from) yield plain.subarray(from, to);
    }
  } finally {
    await handle.close();
  }
}

/** Reads a range of an encrypted cache file. `end` is inclusive. */
export function readEncryptedRange(
  file: string,
  key: Buffer,
  start: number,
  end: number,
): AsyncGenerator<Buffer, void, unknown> {
  return decryptRange(file, key, start, end);
}

export async function readEncryptedAll(file: string, key: Buffer): Promise<Buffer> {
  const info = await cacheFileInfo(file);
  if (!info.encrypted) return readFile(file);
  if (info.size === 0) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  for await (const chunk of readEncryptedRange(file, key, 0, info.size - 1)) {
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

/** Writes a small buffer (thumbnail, poster) using the same format. */
export async function writeEncryptedBuffer(buffer: Buffer, destPath: string, key: Buffer): Promise<void> {
  async function* single(): AsyncGenerator<Buffer> {
    yield buffer;
  }
  await writeEncryptedFile(single(), destPath, buffer.length, key);
}
