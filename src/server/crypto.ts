import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Reads a 32-byte key, creating it atomically with restrictive permissions if needed. */
export async function loadOrCreateKey(file: string): Promise<Buffer> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const existing = await fs.readFile(file);
    if (existing.length >= 32) return existing.subarray(0, 32);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const key = randomBytes(32);
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    try {
      await handle.writeFile(key);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = await fs.readFile(file);
      return existing.subarray(0, 32);
    }
    throw error;
  }
}

export function sealJson(value: unknown, key: Buffer, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
}

export function openJson<T>(value: string | null | undefined, key: Buffer, context: string): T | null {
  if (!value) return null;
  if (!value.startsWith('v1.')) return null;
  try {
    const raw = Buffer.from(value.slice(3), 'base64');
    if (raw.length < 28) return null;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const encrypted = raw.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
