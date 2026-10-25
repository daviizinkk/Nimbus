import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CACHE_CHUNK_SIZE,
  CACHE_HEADER_SIZE,
  encryptedSizeFor,
  cacheFileInfo,
  looksEncrypted,
  readEncryptedAll,
  readEncryptedRange,
  writeEncryptedBuffer,
  writeEncryptedFile,
} from '../src/server/cache-crypto.js';

const KEY = randomBytes(32);

function pattern(size: number): Buffer {
  const buffer = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index++) buffer[index] = (index * 31 + 7) & 0xff;
  return buffer;
}

async function* chunks(buffer: Buffer, sizes: number[]): AsyncGenerator<Buffer> {
  let offset = 0;
  let index = 0;
  while (offset < buffer.length) {
    const length = Math.min(sizes[index % sizes.length], buffer.length - offset);
    yield buffer.subarray(offset, offset + length);
    offset += length;
    index += 1;
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of source) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

test('encryptedSizeFor matches the on-disk layout', async (t) => {
  assert.equal(encryptedSizeFor(0), CACHE_HEADER_SIZE);
  assert.equal(encryptedSizeFor(CACHE_CHUNK_SIZE), CACHE_HEADER_SIZE + CACHE_CHUNK_SIZE + 28);
  assert.equal(
    encryptedSizeFor(CACHE_CHUNK_SIZE + 10),
    CACHE_HEADER_SIZE + (CACHE_CHUNK_SIZE + 28) + 10 + 28,
  );

  const dir = await mkdtemp(path.join(os.tmpdir(), 'nimbus-crypto-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'size.bin');
  const data = pattern(CACHE_CHUNK_SIZE + 10);
  await writeEncryptedFile(chunks(data, [16384]), file, data.length, KEY);
  assert.equal((await stat(file)).size, encryptedSizeFor(data.length));
});

test('round-trips a multi-chunk stream and reports plaintext size', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nimbus-crypto-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'blob.bin');
  const data = pattern(CACHE_CHUNK_SIZE * 2 + 12_345);

  const written = await writeEncryptedFile(chunks(data, [7777, 65_536, 3, 1_000_000]), file, data.length, KEY);
  assert.equal(written, data.length);

  const head = await readFile(file);
  assert.equal(looksEncrypted(head), true);
  assert.deepEqual(await cacheFileInfo(file), { size: data.length, encrypted: true });
  assert.deepEqual(await readEncryptedAll(file, KEY), data);

  const offset = CACHE_CHUNK_SIZE - 5;
  const cross = await collect(readEncryptedRange(file, KEY, offset, offset + 10));
  assert.deepEqual(cross, data.subarray(offset, offset + 11));

  const tailStart = data.length - 40;
  assert.deepEqual(await collect(readEncryptedRange(file, KEY, tailStart, data.length - 1)), data.subarray(tailStart));
});

test('rejects a tampered encrypted chunk', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nimbus-crypto-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tampered.bin');
  const data = pattern(4096);
  await writeEncryptedFile(chunks(data, [4096]), file, data.length, KEY);

  const handle = await open(file, 'r+');
  try {
    // Flip the first ciphertext byte of the single record.
    const recordStart = CACHE_HEADER_SIZE + 12 + 16;
    const original = Buffer.alloc(1);
    await handle.read(original, 0, 1, recordStart);
    original[0] ^= 0xff;
    await handle.write(original, 0, 1, recordStart);
  } finally {
    await handle.close();
  }

  await assert.rejects(() => readEncryptedAll(file, KEY));
  await assert.rejects(async () => collect(readEncryptedRange(file, KEY, 0, data.length - 1)));
});

test('rejects a truncated encrypted file', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nimbus-crypto-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'short.bin');
  const data = pattern(4096);
  await writeEncryptedFile(chunks(data, [4096]), file, data.length, KEY);
  const full = await readFile(file);
  await writeFile(file, full.subarray(0, full.length - 3));

  await assert.rejects(() => cacheFileInfo(file));
  await assert.rejects(async () => collect(readEncryptedRange(file, KEY, 0, data.length - 1)));
});

test('cacheFileInfo recognises plain files and readEncryptedAll passes them through', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nimbus-crypto-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'plain.bin');
  const data = Buffer.from('not encrypted, just cached bytes');
  await writeFile(file, data);

  assert.deepEqual(await cacheFileInfo(file), { size: data.length, encrypted: false });
  assert.deepEqual(await readEncryptedAll(file, KEY), data);
});

test('writeEncryptedBuffer round-trips a thumbnail-sized buffer', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nimbus-crypto-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'thumb.enc');
  const data = randomBytes(21_437);
  await writeEncryptedBuffer(data, file, KEY);
  assert.deepEqual(await readEncryptedAll(file, KEY), data);
  assert.deepEqual(await cacheFileInfo(file), { size: data.length, encrypted: true });
});
