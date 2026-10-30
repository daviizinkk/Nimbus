import type { Database } from './db.js';
import type { VaultSettings } from './settings.js';
import { config } from './config.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_GAP_MS = DAY_MS;
const TIMEOUT_MS = 15_000;

function countBucket(value: number): string {
  if (value <= 0) return '0';
  if (value < 10) return '1-9';
  if (value < 100) return '10-99';
  if (value < 1_000) return '100-999';
  if (value < 10_000) return '1k-10k';
  return '10k+';
}

function sizeBucket(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb < 0.1) return 'under 100 MB';
  if (gb < 1) return '100 MB-1 GB';
  if (gb < 10) return '1-10 GB';
  if (gb < 100) return '10-100 GB';
  if (gb < 1_000) return '100 GB-1 TB';
  return '1 TB+';
}

export interface TelemetryPayload {
  schema: 1;
  installId: string;
  version: string;
  platform: string;
  storage: string;
  library: {
    items: string;
    photos: string;
    videos: string;
    files: string;
    size: string;
  };
  features: string[];
}

/**
 * Builds the anonymous heartbeat. Only coarse buckets are included: never a
 * file name, vault name, path, account identity or exact count.
 */
export function buildTelemetryPayload(
  installId: string,
  database: Pick<Database, 'getStats'>,
  settings: Pick<VaultSettings, 'activeProvider'>,
): TelemetryPayload {
  const stats = database.getStats();
  return {
    schema: 1,
    installId,
    version: config.version,
    platform: process.platform,
    storage: settings.activeProvider,
    library: {
      items: countBucket(stats.itemCount),
      photos: countBucket(stats.photoCount),
      videos: countBucket(stats.videoCount),
      files: countBucket(stats.fileCount),
      size: sizeBucket(stats.usedBytes),
    },
    features: ['public-links', 'pwa'],
  };
}

/**
 * Opt-in, off-by-default anonymous heartbeat. Collection is a no-op while
 * NIMBUS_TELEMETRY_URL is unset, and never happens more than once a day.
 */
export class TelemetryService {
  private timer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  private inFlight = false;

  constructor(
    private readonly db: Database,
    private readonly settings: VaultSettings,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sendNow(), 60 * 60 * 1000);
    this.timer.unref();
    this.firstTimer = setTimeout(() => void this.sendNow(), 25_000);
    this.firstTimer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = null;
    this.firstTimer = null;
  }

  /** Sends a heartbeat when enabled, configured, and the daily gap has elapsed. */
  async sendNow(): Promise<void> {
    if (this.inFlight) return;
    if (!this.settings.onboarded) return;
    if (!this.settings.telemetryConfigured) return;
    if (!this.settings.telemetryView().enabled) return;

    const lastAttempt = this.settings.telemetryLastAttemptAt;
    if (lastAttempt !== null && Date.now() - lastAttempt < MIN_GAP_MS) return;

    this.inFlight = true;
    this.settings.markTelemetryAttempt();
    try {
      const installId = this.settings.getOrCreateTelemetryInstallId();
      const payload = buildTelemetryPayload(installId, this.db, this.settings);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(config.telemetryUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': `Nimbus/${config.version}`,
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Telemetry endpoint returned HTTP ${response.status}.`);
        }
      } finally {
        clearTimeout(timeout);
      }
      this.settings.markTelemetrySuccess();
      console.log('[telemetry] anonymous heartbeat sent');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.settings.markTelemetryError(message);
      console.warn(`[telemetry] heartbeat failed: ${message}`);
    } finally {
      this.inFlight = false;
    }
  }
}
