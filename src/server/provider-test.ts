import type { ProviderId, ProviderTestResult } from '../../shared/types.js';
import { config } from './config.js';
import type { GithubConfigInput, VaultSettings, WebdavConfigInput } from './settings.js';
import { mergeGithubConfig, mergeWebdavConfig } from './settings.js';
import { GithubProvider, LocalProvider, WebdavProvider } from './storage/index.js';
import type { StorageProvider } from './storage/index.js';

export interface ProviderInput {
  token?: string;
  owner?: string;
  repo?: string;
  releaseTag?: string;
  url?: string;
  username?: string;
  password?: string;
  folder?: string;
}

/**
 * Builds a provider from a form submission without persisting it. When
 * `allowSaved` is true, omitted/blank fields inherit the saved configuration.
 */
export function providerFromInput(
  settings: VaultSettings,
  id: ProviderId,
  input: ProviderInput | undefined,
  allowSaved: boolean,
): StorageProvider {
  if (id === 'local') return new LocalProvider(config.storageDir);
  if (id === 'github') {
    const merged = mergeGithubConfig(allowSaved ? settings.github : null, (input ?? {}) as GithubConfigInput);
    return new GithubProvider(merged);
  }
  if (id === 'webdav') {
    const merged = mergeWebdavConfig(allowSaved ? settings.webdav : null, (input ?? {}) as WebdavConfigInput);
    return new WebdavProvider(merged);
  }
  throw new Error(`Unknown provider: ${String(id)}`);
}

export async function testProviderInput(
  settings: VaultSettings,
  id: ProviderId,
  input: ProviderInput | undefined,
  allowSaved: boolean,
): Promise<ProviderTestResult> {
  try {
    const provider = providerFromInput(settings, id, input, allowSaved);
    return await provider.test();
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Could not test this storage provider.',
    };
  }
}
