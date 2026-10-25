import { randomUUID } from 'node:crypto';
import { lookup } from 'mime-types';
import type { ItemKind } from '../../shared/types.js';

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function uid(): string {
  return randomUUID();
}

export function now(): number {
  return Date.now();
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  options: {
    maxAge?: number;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'Lax' | 'Strict' | 'None';
    path?: string;
  } = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? '/'}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.httpOnly !== false) parts.push('HttpOnly');
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function safeFilename(input: string, fallback = 'file'): string {
  const name = (input || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/]+/g, ' ').trim();
  return (name || fallback).slice(0, 240);
}

export function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return '';
  const ext = name.slice(index + 1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(ext) ? `.${ext}` : '';
}

export function resolveMime(name: string, supplied?: string | null): string {
  const clean = (supplied || '').split(';')[0].trim().toLowerCase();
  if (clean && clean !== 'application/octet-stream' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(clean)) return clean;
  const guessed = lookup(name);
  return guessed ? String(guessed) : 'application/octet-stream';
}

export function kindForMime(mime: string): ItemKind {
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  return 'file';
}

/** RFC 6266 / RFC 5987 safe Content-Disposition value. */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const name = safeFilename(filename);
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export interface ByteRange {
  start: number;
  end: number;
}

/** Parses a single HTTP byte range. Returns null when absent/unsupported, or 'invalid'. */
export function parseRange(header: string | undefined, size: number): ByteRange | null | 'invalid' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) return 'invalid';
  if (size <= 0) return 'invalid';
  const startRaw = match[1];
  const endRaw = match[2];
  if (!startRaw && !endRaw) return 'invalid';
  let start: number;
  let end: number;
  if (!startRaw) {
    const suffix = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    end = endRaw ? Number.parseInt(endRaw, 10) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
    if (start >= size || start > end) return 'invalid';
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function prettyBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class SlidingWindowLimiter {
  private attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string): boolean {
    const current = Date.now();
    const entry = this.attempts.get(key);
    if (!entry || entry.resetAt <= current) {
      this.attempts.set(key, { count: 1, resetAt: current + this.windowMs });
      return true;
    }
    if (entry.count >= this.limit) return false;
    entry.count += 1;
    return true;
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  prune(): void {
    const current = Date.now();
    for (const [key, entry] of this.attempts) {
      if (entry.resetAt <= current) this.attempts.delete(key);
    }
  }
}

export function isTruthy(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}
