'use strict';

/**
 * Offline password reset for the desktop app.
 *
 * The renderer has no direct database access. This helper runs in the Electron
 * main process, opens the same SQLite database as the local server and replaces
 * the password hash. Existing sessions are removed so every browser has to sign
 * in again. No old password and no command line are required.
 */

const { randomBytes, scrypt: scryptCallback } = require('node:crypto');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(scryptCallback);
const MIN_LENGTH = 8;
const MAX_LENGTH = 200;

function messageOf(error) {
  return error instanceof Error && error.message ? error.message : 'Could not reset the password.';
}

async function resetPassword(dataDir, newPassword) {
  if (typeof newPassword !== 'string' || newPassword.length < MIN_LENGTH) {
    return { ok: false, error: `The new password must be at least ${MIN_LENGTH} characters long.` };
  }
  if (newPassword.length > MAX_LENGTH) {
    return { ok: false, error: 'Password is too long.' };
  }

  const dbPath = path.join(dataDir, 'nimbus.db');
  if (!existsSync(dbPath)) {
    return { ok: false, error: 'No Nimbus library was found on this computer. Finish setup first.' };
  }

  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout = 5000;');

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
      .get();
    if (!table) {
      return { ok: false, error: 'This library database is not ready yet. Finish setup first.' };
    }
    const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get('password.hash');
    if (!existing) {
      return { ok: false, error: 'Nimbus has not been set up yet. Finish setup in the app first.' };
    }

    const salt = randomBytes(16);
    const hash = await scrypt(newPassword, salt, 64);
    const stored = `scrypt$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`;

    db.exec('BEGIN IMMEDIATE;');
    try {
      db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run('password.hash', stored);
      db.prepare('DELETE FROM sessions').run();
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  } finally {
    try {
      db?.close();
    } catch {
      // Closing is best-effort; the database has already been updated.
    }
  }
}

module.exports = { resetPassword };
