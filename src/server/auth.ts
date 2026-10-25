import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyRequest } from 'fastify';
import { config } from './config.js';
import { randomToken, sha256 } from './crypto.js';
import type { Database } from './db.js';
import type { VaultSettings } from './settings.js';
import { parseCookies, serializeCookie } from './utils.js';

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = 'nimbus_session';

async function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return (await scrypt(password, salt, 64)) as Buffer;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derivePassword(password, salt);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'base64');
    const expected = Buffer.from(parts[2], 'base64');
    const actual = await derivePassword(password, salt);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export interface AuthSession {
  tokenHash: string;
}

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly settings: VaultSettings,
  ) {}

  get onboarded(): boolean {
    return this.settings.onboarded;
  }

  sessionTokenFromRequest(request: FastifyRequest): string | null {
    const cookie = parseCookies(request.headers.cookie)[COOKIE_NAME];
    if (cookie && cookie.length >= 20) return cookie;
    return null;
  }

  authenticate(request: FastifyRequest): AuthSession | null {
    const token = this.sessionTokenFromRequest(request);
    if (!token) return null;
    const tokenHash = sha256(token);
    const session = this.db.getSession(tokenHash);
    if (!session) return null;
    return { tokenHash };
  }

  async login(password: string): Promise<string> {
    const stored = this.settings.passwordHash;
    if (!stored) throw new Error('Not set up');
    const valid = await verifyPassword(password, stored);
    if (!valid) throw new Error('Invalid password');
    return this.createSession();
  }

  createSession(userAgent?: string): string {
    const token = randomToken(32);
    const tokenHash = sha256(token);
    const expiresAt = Date.now() + config.sessionDays * 24 * 60 * 60 * 1000;
    this.db.createSession(tokenHash, expiresAt, userAgent?.slice(0, 300) ?? null);
    return token;
  }

  logout(session: AuthSession | null): void {
    if (session) this.db.deleteSession(session.tokenHash);
  }

  setSessionCookie(request: FastifyRequest, reply: { header: (key: string, value: string) => unknown }, token: string): void {
    reply.header(
      'set-cookie',
      serializeCookie(COOKIE_NAME, token, {
        maxAge: config.sessionDays * 24 * 60 * 60,
        httpOnly: true,
        sameSite: 'Lax',
        secure: request.protocol === 'https',
      }),
    );
  }

  clearSessionCookie(request: FastifyRequest, reply: { header: (key: string, value: string) => unknown }): void {
    reply.header(
      'set-cookie',
      serializeCookie(COOKIE_NAME, '', {
        maxAge: 0,
        httpOnly: true,
        sameSite: 'Lax',
        secure: request.protocol === 'https',
      }),
    );
  }

  pruneSessions(): void {
    this.db.pruneSessions();
  }
}
