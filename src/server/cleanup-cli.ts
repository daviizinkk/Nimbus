/**
 * Called by the Windows uninstaller when the owner chooses to delete GitHub
 * storage data. It runs under Electron's Node mode, reads the encrypted
 * credentials from the local database, and deletes Nimbus-created releases or
 * the configured repository. It never touches unrelated repositories.
 *
 * Usage:
 *   cleanup.js --data-dir <dir> --github
 *   cleanup.js --data-dir <dir> --github --repository
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Database } from './db.js';
import { VaultSettings } from './settings.js';
import { deleteGithubRepository, deleteNimbusGithubReleases } from './storage/github.js';

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  const github = process.argv.includes('--github');
  const repository = process.argv.includes('--repository');
  if (!github && !repository) {
    console.log('No cleanup options were requested.');
    return;
  }

  const dataDir = path.resolve(argValue('--data-dir') || process.env.DATA_DIR || 'data');
  const dbPath = path.join(dataDir, 'nimbus.db');
  if (!existsSync(dbPath)) {
    console.log(`No Nimbus database found at ${dbPath}; nothing to delete on GitHub.`);
    return;
  }

  const keyPath = path.join(dataDir, '.master-key');
  if (!existsSync(keyPath)) {
    console.log('No master key found; GitHub credentials cannot be read. Nothing was deleted.');
    process.exitCode = 2;
    return;
  }
  const key = await readFile(keyPath);
  if (key.length < 32) {
    console.log('The Nimbus master key is invalid; GitHub credentials cannot be read. Nothing was deleted.');
    process.exitCode = 2;
    return;
  }

  const db = new Database(dbPath);
  try {
    const settings = new VaultSettings(db, key.subarray(0, 32));
    const config = settings.github;
    if (!config) {
      console.log('GitHub storage is not configured; nothing to delete.');
      return;
    }

    console.log(`Repository: ${config.owner}/${config.repo}`);
    if (repository) {
      try {
        await deleteGithubRepository(config);
        console.log('Deleted the GitHub repository and all of its storage data.');
        return;
      } catch (error) {
        console.error(`The repository could not be deleted: ${messageOf(error)}`);
        console.log('Trying to delete Nimbus-managed releases instead…');
      }
    }

    const result = await deleteNimbusGithubReleases(config);
    console.log(`Deleted ${result.releases} Nimbus storage release${result.releases === 1 ? '' : 's'}.`);
    if (repository) {
      console.log('The repository itself was kept because GitHub rejected the repository deletion.');
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(messageOf(error));
  process.exitCode = 1;
});
