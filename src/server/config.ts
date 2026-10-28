import path from 'node:path';

// Load .env if present. Existing environment variables always win.
try {
  process.loadEnvFile('.env');
} catch {
  // No .env file — that's fine.
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

const dataDir = path.resolve(process.env.DATA_DIR || 'data');

export const config = {
  version: '1.2.0',
  brand: 'Nimbus',
  env: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  host: process.env.HOST || '127.0.0.1',
  port: intEnv('PORT', 8787),
  dataDir,
  storageDir: path.join(dataDir, 'storage'),
  cacheDir: path.join(dataDir, 'cache'),
  tmpDir: path.join(dataDir, 'tmp'),
  dbPath: path.join(dataDir, 'nimbus.db'),
  masterKeyPath: path.join(dataDir, '.master-key'),
  cacheKeyPath: path.join(dataDir, '.cache-key'),
  trustProxy: boolEnv('TRUST_PROXY', false),
  maxUploadBytes: Math.max(0, intEnv('MAX_UPLOAD_MB', 4096)) * 1024 * 1024,
  sessionDays: Math.max(1, intEnv('SESSION_DAYS', 30)),
  defaultCacheLimitMB: Math.max(0, intEnv('CACHE_LIMIT_MB', 8192)),
  autoCacheMaxBytes: 128 * 1024 * 1024,
  publicUrl: process.env.PUBLIC_URL || '',
  // Cache files are encrypted at rest by default.
  defaultCacheEncrypted: true,
};
