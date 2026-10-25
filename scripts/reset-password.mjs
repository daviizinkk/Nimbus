#!/usr/bin/env node
/**
 * Resets the single-owner password without starting Nimbus.
 * Usage:
 *   npm run reset-password
 *   NIMBUS_NEW_PASSWORD="new password" npm run reset-password
 *   npm run reset-password -- --password "new password"   (avoid: shell history)
 */
import { scrypt as scryptCallback, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(scryptCallback);

try {
  process.loadEnvFile('.env');
} catch {
  // No .env file; environment variables or defaults are used.
}

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const dbPath = path.join(dataDir, 'nimbus.db');

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function askHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }

    process.stdout.write(question);
    const stdin = process.stdin;
    const chars = [];
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();

    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003' || char === '\u0004') {
          cleanup();
          reject(new Error('Cancelled.'));
          return;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          resolve(chars.join(''));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (chars.length > 0) {
            chars.pop();
            process.stdout.write('\b \b');
          }
          continue;
        }
        if (char >= ' ') {
          chars.push(char);
          process.stdout.write('*');
        }
      }
    };

    stdin.on('data', onData);
  });
}

async function main() {
  if (!existsSync(dbPath)) {
    console.error(`No Nimbus database found at ${dbPath}.`);
    console.error('Start Nimbus once and complete the setup screen first.');
    process.exit(1);
  }

  const inlinePassword = argValue('--password') ?? process.env.NIMBUS_NEW_PASSWORD;
  let password = inlinePassword ?? '';

  if (!inlinePassword) {
    if (!process.stdin.isTTY) {
      console.error('No terminal available. Set NIMBUS_NEW_PASSWORD or pass --password.');
      process.exit(1);
    }
    password = await askHidden('New password: ');
    if (password.length < 8) {
      console.error('Password must be at least 8 characters long.');
      process.exit(1);
    }
    const confirmation = await askHidden('Confirm new password: ');
    if (password !== confirmation) {
      console.error('Passwords do not match.');
      process.exit(1);
    }
  }

  if (password.length < 8) {
    console.error('Password must be at least 8 characters long.');
    process.exit(1);
  }
  if (password.length > 1024) {
    console.error('Password is too long (maximum 1024 characters).');
    process.exit(1);
  }

  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
      .get();
    if (!table) {
      console.error('This database has no Nimbus settings table. Complete setup first.');
      process.exit(1);
    }
    const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get('password.hash');
    if (!existing) {
      console.error('Nimbus has not been set up yet. Finish setup in the browser first.');
      process.exit(1);
    }

    const salt = randomBytes(16);
    const hash = await scrypt(password, salt, 64);
    const stored = `scrypt$${salt.toString('base64')}$${Buffer.from(hash).toString('base64')}`;

    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run('password.hash', stored);
    // Password rotation signs out every existing browser session.
    db.prepare('DELETE FROM sessions').run();

    console.log('');
    console.log('Password updated. All browser sessions were signed out.');
    console.log(`Database: ${dbPath}`);
    if (existing && !inlinePassword) {
      console.log('If the Nimbus server is running, no restart is required.');
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
