'use strict';

/**
 * Discord Rich Presence for the desktop app.
 *
 * The renderer never talks to Discord directly. It sends a tiny activity
 * object to the main process, which decides what can be shared based on the
 * privacy setting. File names are only sent when the owner explicitly opts in.
 */

const { mkdir, readFile, writeFile } = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');

// Nimbus ships with its own public Discord application. An Application ID is
// not a secret and cannot be used to read a Discord account; friends get Rich
// Presence without creating an app first. Owners can still replace it with
// their own ID in Settings.
const DEFAULT_APPLICATION_ID = '1563561943468351569';

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  applicationId: DEFAULT_APPLICATION_ID,
  showActivity: false,
});

const ID_PATTERN = /^\d{15,22}$/;
const RETRY_MS = 20_000;

function cleanText(value, max = 128) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function errorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  if (
    /unable to find any discord client|could not connect to discord client|connection ended|connection closed|socket closed|econnreset|enoent|econnrefused/i.test(
      raw,
    )
  ) {
    return 'Discord is not running. Open the Discord desktop app, then try again.';
  }
  if (/did not respond|timed out/i.test(raw)) {
    return 'Discord did not respond. Make sure the Discord desktop app is signed in and running.';
  }
  if (/invalid.*client|unknown application|invalid client id/i.test(raw)) {
    return 'Discord rejected this Application ID. Check it in the Discord Developer Portal.';
  }
  return cleanText(raw, 300) || 'Could not connect to Discord.';
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The Discord RPC client scans ten named pipes on Windows. Each attempt to a
 * missing pipe can take a second, which makes “Connecting…” linger for a long
 * time when Discord is simply closed. Probe the pipes ourselves first and hand
 * the working one to the client. Returns null on other platforms, where the
 * library handles Unix sockets itself.
 */
function probeDiscordPipe(pipeId, timeoutMs = 350) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection(`\\\\?\\pipe\\discord-ipc-${pipeId}`);
    const finish = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function findDiscordPipe() {
  if (process.platform !== 'win32') return null;
  for (let pipeId = 0; pipeId < 10; pipeId += 1) {
    if (await probeDiscordPipe(pipeId)) return pipeId;
  }
  return -1;
}

function normaliseConfig(input) {
  return {
    enabled: Boolean(input?.enabled),
    applicationId: cleanText(input?.applicationId, 32),
    showActivity: Boolean(input?.showActivity),
  };
}

class DiscordPresence {
  constructor({ configPath, onStatus }) {
    this.configPath = configPath;
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.config = { ...DEFAULT_CONFIG };
    this.status = {
      state: 'off',
      message: 'Rich Presence is off.',
      user: null,
    };
    this.client = null;
    this.lastActivity = null;
    this.retryTimer = null;
    this.connectedAt = Date.now();
    this.applyToken = 0;
    this.closed = false;
  }

  async init() {
    try {
      const raw = await readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw);
      const saved = normaliseConfig(parsed);
      // Pre-fill the bundled ID for configs written by older versions, while
      // preserving the owner's enabled/disabled choice.
      this.config = saved.applicationId ? saved : { ...saved, applicationId: DEFAULT_APPLICATION_ID };
    } catch {
      this.config = { ...DEFAULT_CONFIG };
    }
    // Load the saved preference before the window opens, but do not make the
    // window wait for Discord's IPC socket. The status is pushed to the
    // renderer as the connection progresses.
    void this.apply().catch(() => {});
  }

  getConfig() {
    return { ...this.config };
  }

  getStatus() {
    return { ...this.status };
  }

  async save(input) {
    const next = normaliseConfig(input);
    if (next.enabled && !ID_PATTERN.test(next.applicationId)) {
      throw new Error('Enter the numeric Application ID from the Discord Developer Portal.');
    }
    this.config = next;
    await mkdir(path.dirname(this.configPath), { recursive: true });
    await writeFile(this.configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await this.apply();
    return { config: this.getConfig(), status: this.getStatus() };
  }

  /** Receives the current view from the renderer. Safe to call at any time. */
  setActivity(activity) {
    this.lastActivity = {
      view: cleanText(activity?.view, 48),
      item: cleanText(activity?.item, 120),
    };
    void this.publishActivity();
  }

  async publishActivity() {
    if (this.status.state !== 'connected' || !this.client?.user) return;
    if (!this.config.enabled) return;
    const view = this.lastActivity?.view || 'the library';
    const details = cleanText(`Browsing ${view}`, 128);
    const state =
      this.config.showActivity && this.lastActivity?.item
        ? cleanText(`Viewing ${this.lastActivity.item}`, 128)
        : 'Private library';
    try {
      await this.client.user.setActivity({
        details,
        state,
        startTimestamp: this.connectedAt,
        instance: false,
      });
    } catch (error) {
      this.setStatus('error', errorMessage(error));
    }
  }

  setStatus(state, message, user = null) {
    this.status = { state, message, user };
    this.onStatus(this.getStatus());
  }

  scheduleRetry() {
    if (this.closed || !this.config.enabled || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.closed && this.config.enabled) void this.apply();
    }, RETRY_MS);
  }

  async apply() {
    const token = ++this.applyToken;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    await this.destroyClient();

    if (this.closed) return;
    if (!this.config.enabled) {
      this.setStatus('off', 'Rich Presence is off.');
      return;
    }
    if (!ID_PATTERN.test(this.config.applicationId)) {
      this.setStatus('error', 'Add a valid Discord Application ID to turn Rich Presence on.');
      return;
    }

    this.setStatus('connecting', 'Connecting to Discord…');
    let client = null;
    try {
      const pipeId = await findDiscordPipe();
      if (token !== this.applyToken || this.closed) return;
      if (pipeId === -1) throw new Error('Unable to find any Discord client');
      const { Client } = await import('@xhayper/discord-rpc');
      if (token !== this.applyToken || this.closed) return;
      client = new Client({
        clientId: this.config.applicationId,
        ...(pipeId === null ? {} : { pipeId }),
      });
      this.client = client;

      client.on('ready', () => {
        if (this.client !== client) return;
        this.connectedAt = Date.now();
        const user = client.user?.username ?? null;
        this.setStatus('connected', user ? `Connected as ${user}.` : 'Connected to Discord.', user);
        void this.publishActivity();
      });
      client.on('disconnected', () => {
        if (this.client !== client) return;
        this.setStatus('disconnected', 'Discord closed the connection. Nimbus will keep trying.');
        this.scheduleRetry();
      });

      await withTimeout(
        client.login(),
        15_000,
        'Discord did not respond while connecting.',
      );
    } catch (error) {
      if (this.client === client) this.client = null;
      if (client) await client.destroy().catch(() => {});
      if (token !== this.applyToken || this.closed) return;
      this.setStatus('error', errorMessage(error));
      this.scheduleRetry();
    }
  }

  async destroyClient() {
    const client = this.client;
    this.client = null;
    if (!client) return;
    await client.destroy().catch(() => {});
  }

  async shutdown() {
    this.closed = true;
    this.applyToken += 1;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    await this.destroyClient();
  }
}

module.exports = { DiscordPresence, DEFAULT_CONFIG, DEFAULT_APPLICATION_ID };
