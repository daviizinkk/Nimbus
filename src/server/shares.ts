import type { FastifyRequest } from 'fastify';
import type { ShareDTO, ShareExpiry } from '../../shared/types.js';
import { randomToken, sha256 } from './crypto.js';
import { config } from './config.js';
import type { AppContext } from './context.js';
import type { DbItem, DbShare } from './db.js';
import { ApiError, safeFilename, uid } from './utils.js';

const DAY = 24 * 60 * 60 * 1000;

export const SHARE_EXPIRY_MS: Record<Exclude<ShareExpiry, 'never'>, number> = {
  '1d': DAY,
  '7d': 7 * DAY,
  '30d': 30 * DAY,
  '90d': 90 * DAY,
};

export const SHARE_EXPIRY_OPTIONS: ShareExpiry[] = ['1d', '7d', '30d', '90d', 'never'];
export const MAX_ACTIVE_SHARES = 8;

export function parseShareExpiry(value: unknown): ShareExpiry {
  return SHARE_EXPIRY_OPTIONS.includes(value as ShareExpiry) ? (value as ShareExpiry) : '7d';
}

export function expiryToTimestamp(expiry: ShareExpiry, from = Date.now()): number | null {
  if (expiry === 'never') return null;
  return from + SHARE_EXPIRY_MS[expiry];
}

export function isShareActive(share: DbShare, at = Date.now()): boolean {
  return share.revoked_at === null && (share.expires_at === null || share.expires_at > at);
}

export function shareBaseUrl(request: FastifyRequest): string {
  if (config.publicUrl) return config.publicUrl;
  const host = request.headers.host || `localhost:${config.port}`;
  return `${request.protocol}://${host}`;
}

export function shareLink(request: FastifyRequest, token: string): string {
  return `${shareBaseUrl(request)}/s/${encodeURIComponent(token)}`;
}

export function shareDTO(
  ctx: AppContext,
  share: DbShare,
  request: FastifyRequest,
): ShareDTO | null {
  const token = ctx.settings.openShareToken(share.id, share.token_sealed);
  if (!token) return null;
  return {
    id: share.id,
    itemId: share.item_id,
    url: shareLink(request, token),
    createdAt: share.created_at,
    expiresAt: share.expires_at,
    revokedAt: share.revoked_at,
    lastAccessAt: share.last_access_at,
    accessCount: share.access_count,
    active: isShareActive(share),
  };
}

export function createShare(
  ctx: AppContext,
  item: DbItem,
  expiry: ShareExpiry,
  request: FastifyRequest,
): ShareDTO {
  if (item.status !== 'ready') throw new ApiError(409, 'Wait for this file to finish saving before sharing it.');
  if (item.trashed_at) throw new ApiError(409, 'Restore this file before sharing it.');
  if (ctx.db.countActiveShares(item.id) >= MAX_ACTIVE_SHARES) {
    throw new ApiError(409, `This file already has ${MAX_ACTIVE_SHARES} active links. Revoke one before creating another.`);
  }

  const id = uid();
  const token = randomToken(24);
  ctx.db.createShare({
    id,
    itemId: item.id,
    tokenHash: sha256(token),
    tokenSealed: ctx.settings.sealShareToken(id, token),
    expiresAt: expiryToTimestamp(expiry),
  });
  const share = ctx.db.getShare(id);
  if (!share) throw new ApiError(500, 'Could not create the share link.');
  const dto = shareDTO(ctx, share, request);
  if (!dto) throw new ApiError(500, 'Could not create the share link.');
  return dto;
}

export interface ResolvedShare {
  share: DbShare;
  item: DbItem;
}

/** Looks up an unguessable token and verifies the item is still shareable. */
export function resolveShare(ctx: AppContext, token: string): ResolvedShare | null {
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(token)) return null;
  const share = ctx.db.getShareByTokenHash(sha256(token));
  if (!share || !isShareActive(share)) return null;
  const item = ctx.db.getItemRecord(share.item_id);
  if (!item || item.status !== 'ready' || item.trashed_at) return null;
  return { share, item };
}

export function shareFilename(item: DbItem): string {
  return safeFilename(item.name, 'file');
}

export function revocationLabel(share: DbShare): string {
  if (share.revoked_at) return 'Revoked';
  if (share.expires_at !== null && share.expires_at <= Date.now()) return 'Expired';
  return 'Active';
}
