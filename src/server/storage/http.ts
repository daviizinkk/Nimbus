import { Agent, fetch, type RequestInit as UndiciRequestInit, type Response as UndiciResponse } from 'undici';
import { ProviderError } from './types.js';

/**
 * Shared HTTP agent for cloud providers.
 *
 * Uploads can legitimately take much longer than undici's default five minute
 * headers timeout, so those limits are disabled while connect timeouts remain.
 */
export const storageAgent = new Agent({
  connect: { timeout: 30_000 },
  headersTimeout: 0,
  bodyTimeout: 0,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 120_000,
});

export function storageFetch(url: string | URL, init: UndiciRequestInit = {}): Promise<UndiciResponse> {
  return fetch(url, { ...init, dispatcher: storageAgent });
}

/** Extracts a concise, safe error message from a failed provider response. */
export async function providerHttpError(response: UndiciResponse, action: string): Promise<ProviderError> {
  let detail = '';
  try {
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      const body = (await response.json()) as {
        message?: string;
        error?: string;
        errors?: Array<string | { message?: string; code?: string }>;
      };
      const extra = Array.isArray(body?.errors)
        ? body.errors
            .map((entry) => (typeof entry === 'string' ? entry : entry?.message || entry?.code || ''))
            .filter(Boolean)
        : [];
      detail = [body?.message || body?.error || '', ...extra].filter(Boolean).join(' — ');
    } else {
      const text = await response.text();
      detail = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  } catch {
    detail = '';
  }
  const suffix = detail ? `: ${detail.slice(0, 280)}` : '';
  let message = `${action} failed (HTTP ${response.status})${suffix}`;
  let status = 502;
  if (response.status === 401) {
    message = `${action} was rejected — check your credentials.${suffix}`;
    status = 401;
  } else if (response.status === 403) {
    message = `${action} was forbidden — the token may lack the required permissions.${suffix}`;
    status = 403;
  } else if (response.status === 404) {
    message = `${action} could not find the configured resource.${suffix}`;
    status = 404;
  } else if (response.status === 422) {
    message = `${action} was rejected.${suffix}`;
    status = 422;
  } else if (response.status === 429) {
    message = `${action} was rate limited. Try again shortly.${suffix}`;
    status = 429;
  }
  return new ProviderError(message, status);
}

export function rangeHeader(range: { start: number; end: number } | undefined): Record<string, string> {
  return range ? { range: `bytes=${range.start}-${range.end}` } : {};
}

export function parseContentRange(value: string | null): { start: number; end: number; total: number } | null {
  if (!value) return null;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match) return null;
  const total = match[3] === '*' ? Number.NaN : Number.parseInt(match[3], 10);
  return {
    start: Number.parseInt(match[1], 10),
    end: Number.parseInt(match[2], 10),
    total,
  };
}

export async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
