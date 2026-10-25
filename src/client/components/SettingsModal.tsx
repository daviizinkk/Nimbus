import { useEffect, useMemo, useState } from 'react';
import type {
  AppSettingsView,
  CacheStats,
  ProviderId,
  ProviderTestResult,
  StorageStats,
} from '../../../shared/types';
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Database,
  Eye,
  EyeOff,
  FolderOpen,
  GitBranch,
  HardDrive,
  Info,
  KeyRound,
  Laptop,
  LockKeyhole,
  LogOut,
  Monitor,
  Moon,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  UnlockKeyhole,
  User,
} from 'lucide-react';
import { api } from '../api';
import { isDesktop } from '../desktop';
import { formatBytes } from '../format';
import type { ThemeMode } from '../hooks';
import { DeleteLibraryDialog } from './DeleteLibraryDialog';
import { DesktopSettings } from './DesktopSettings';
import { ConfirmDialog, Field, Modal, Spinner, Toggle } from './ui';

export type SettingsTab = 'general' | 'storage' | 'cache' | 'desktop' | 'account' | 'about';

interface SettingsModalProps {
  vaultName: string;
  activeProvider: ProviderId;
  stats: StorageStats | null;
  theme: ThemeMode;
  initialTab?: SettingsTab;
  onThemeChange: (theme: ThemeMode) => void;
  onClose: () => void;
  onSettingsChanged: (settings: AppSettingsView) => void;
  onCacheChanged: (cache: CacheStats) => void;
  onLogout: () => void;
  onAccountDeleted: () => void;
  onDeletionStarted: () => void;
  notify: (message: string, kind?: 'success' | 'error' | 'info') => void;
}

type StorageTestState = {
  provider: ProviderId;
  result: ProviderTestResult;
} | null;

const TABS: Array<{ id: SettingsTab; label: string; icon: typeof SlidersHorizontal }> = [
  { id: 'general', label: 'General', icon: SlidersHorizontal },
  { id: 'storage', label: 'Cloud storage', icon: Cloud },
  { id: 'cache', label: 'Cache & offline', icon: Database },
  { id: 'desktop', label: 'Desktop & Discord', icon: Laptop },
  { id: 'account', label: 'Account', icon: KeyRound },
  { id: 'about', label: 'About', icon: Info },
];

const VISIBLE_TABS = TABS.filter((entry) => entry.id !== 'desktop' || isDesktop);

function ResultBanner({ state }: { state: StorageTestState }) {
  if (!state) return null;
  return (
    <div className={`test-result${state.result.ok ? ' is-ok' : ' is-error'}`} role="status">
      {state.result.ok ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
      <div>
        <strong>{state.result.ok ? 'Connection works' : 'Connection failed'}</strong>
        <p>{state.result.message}</p>
        {state.result.warning ? <p className="test-warning">{state.result.warning}</p> : null}
        {state.result.details ? (
          <dl className="test-details">
            {Object.entries(state.result.details)
              .filter(([, value]) => value !== null && value !== '')
              .slice(0, 7)
              .map(([key, value]) => (
                <div key={key}>
                  <dt>{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</dt>
                  <dd>{String(value)}</dd>
                </div>
              ))}
          </dl>
        ) : null}
      </div>
    </div>
  );
}

export function SettingsModal({
  vaultName,
  activeProvider,
  stats,
  theme,
  initialTab = 'general',
  onThemeChange,
  onClose,
  onSettingsChanged,
  onCacheChanged,
  onLogout,
  onAccountDeleted,
  onDeletionStarted,
  notify,
}: SettingsModalProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [settings, setSettings] = useState<AppSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState(vaultName);
  const [generalBusy, setGeneralBusy] = useState(false);

  const [github, setGithub] = useState({ token: '', owner: '', repo: '', releaseTag: 'nimbus-storage' });
  const [webdav, setWebdav] = useState({ url: '', username: '', password: '', folder: 'nimbus' });
  const [showGithubToken, setShowGithubToken] = useState(false);
  const [showWebdavPassword, setShowWebdavPassword] = useState(false);
  const [newRepoName, setNewRepoName] = useState('nimbus-library');
  const [storageBusy, setStorageBusy] = useState<string | null>(null);
  const [testState, setTestState] = useState<StorageTestState>(null);

  const [cacheLimit, setCacheLimit] = useState('8192');
  const [autoCache, setAutoCache] = useState(true);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheSaving, setCacheSaving] = useState(false);
  const [encryptionTarget, setEncryptionTarget] = useState<boolean | null>(null);
  const [clearTarget, setClearTarget] = useState<boolean | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .getSettings()
      .then((result) => {
        if (cancelled) return;
        setSettings(result);
        setName(result.vaultName);
        setGithub({
          token: '',
          owner: result.storage.github.owner,
          repo: result.storage.github.repo,
          releaseTag: result.storage.github.releaseTag,
        });
        setWebdav({
          url: result.storage.webdav.url,
          username: result.storage.webdav.username,
          password: '',
          folder: result.storage.webdav.folder,
        });
        setNewRepoName(result.storage.github.repo || 'nimbus-library');
        setCacheLimit(String(result.cache.limitMB));
        setAutoCache(result.cache.autoCache);
        setLoading(false);
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setLoadError(error.message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const cache = settings?.cache;
  const cacheDirty = useMemo(
    () => Boolean(cache && (Number(cacheLimit) !== cache.limitMB || autoCache !== cache.autoCache)),
    [autoCache, cache, cacheLimit],
  );

  const activeStorage = settings?.storage.active ?? activeProvider;

  const saveName = async () => {
    if (!name.trim()) {
      notify('Library name cannot be empty.', 'error');
      return;
    }
    setGeneralBusy(true);
    try {
      const result = await api.updateVaultName(name.trim());
      setSettings(result);
      setName(result.vaultName);
      onSettingsChanged(result);
      notify('Library name updated.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not update the library name.', 'error');
    } finally {
      setGeneralBusy(false);
    }
  };

  const applySettings = (result: AppSettingsView) => {
    setSettings(result);
    onSettingsChanged(result);
  };

  const testProvider = async (provider: ProviderId) => {
    setStorageBusy(`test-${provider}`);
    setTestState(null);
    try {
      const config =
        provider === 'github'
          ? {
              token: github.token,
              owner: github.owner,
              repo: github.repo,
              releaseTag: github.releaseTag,
            }
          : provider === 'webdav'
            ? {
                url: webdav.url,
                username: webdav.username,
                password: webdav.password,
                folder: webdav.folder,
              }
            : undefined;
      const result = await api.testStorage(provider, config);
      setTestState({ provider, result });
    } catch (error) {
      setTestState({
        provider,
        result: { ok: false, message: error instanceof Error ? error.message : 'Connection test failed.' },
      });
    } finally {
      setStorageBusy(null);
    }
  };

  const activate = async (provider: ProviderId) => {
    setStorageBusy(`save-${provider}`);
    setTestState(null);
    try {
      const result =
        provider === 'github'
          ? await api.updateStorage({
              active: 'github',
              github: {
                token: github.token,
                owner: github.owner,
                repo: github.repo,
                releaseTag: github.releaseTag,
              },
            })
          : provider === 'webdav'
            ? await api.updateStorage({
                active: 'webdav',
                webdav: {
                  url: webdav.url,
                  username: webdav.username,
                  password: webdav.password,
                  folder: webdav.folder,
                },
              })
            : await api.updateStorage({ active: 'local' });
      applySettings(result.settings);
      setGithub((value) => ({ ...value, token: '' }));
      setWebdav((value) => ({ ...value, password: '' }));
      notify(
        provider === 'local'
          ? 'New uploads will be stored on this device.'
          : `New uploads will be stored in ${provider === 'github' ? 'GitHub' : 'WebDAV'}.`,
        'success',
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not change storage.', 'error');
    } finally {
      setStorageBusy(null);
    }
  };

  const createRepo = async () => {
    if (!github.token.trim()) {
      notify('Paste a GitHub token with repository access first.', 'error');
      return;
    }
    setStorageBusy('create-repo');
    setTestState(null);
    try {
      const result = await api.createGithubRepo(github.token.trim(), newRepoName.trim() || 'nimbus-library');
      setGithub((value) => ({ ...value, owner: result.owner, repo: result.repo, releaseTag: value.releaseTag || 'nimbus-storage' }));
      notify(
        result.created
          ? `Private repository ${result.owner}/${result.repo} created.`
          : `Using existing private repository ${result.owner}/${result.repo}.`,
        'success',
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not create the repository.', 'error');
    } finally {
      setStorageBusy(null);
    }
  };

  const saveCache = async () => {
    const limit = Number(cacheLimit);
    if (!Number.isFinite(limit) || limit < 0) {
      notify('Enter a valid cache limit in megabytes.', 'error');
      return;
    }
    setCacheSaving(true);
    try {
      const result = await api.updateCache({ limitMB: Math.floor(limit), autoCache });
      setSettings((value) =>
        value ? { ...value, cache: { ...value.cache, ...result.cache } } : value,
      );
      setCacheLimit(String(result.cache.limitMB));
      setAutoCache(result.cache.autoCache);
      onCacheChanged(result.cache);
      notify('Cache settings saved.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not save cache settings.', 'error');
    } finally {
      setCacheSaving(false);
    }
  };

  const toggleEncryption = async () => {
    if (encryptionTarget === null) return;
    const target = encryptionTarget;
    setEncryptionTarget(null);
    setCacheBusy(true);
    try {
      const result = await api.updateCache({ encrypted: target });
      setSettings((value) => (value ? { ...value, cache: { ...value.cache, ...result.cache } } : value));
      onCacheChanged(result.cache);
      notify(
        target
          ? 'Cache encryption is on. New offline copies will be encrypted.'
          : 'Cache encryption is off. Files in the local cache are stored unencrypted.',
        'success',
      );
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not change cache encryption.', 'error');
    } finally {
      setCacheBusy(false);
    }
  };

  const clearCache = async () => {
    if (clearTarget === null) return;
    const includePinned = clearTarget;
    setClearTarget(null);
    setCacheBusy(true);
    try {
      const result = await api.clearCache(includePinned);
      setSettings((value) => (value ? { ...value, cache: { ...value.cache, ...result.cache } } : value));
      onCacheChanged(result.cache);
      notify(includePinned ? 'Cache cleared, including offline copies.' : 'Cached originals cleared. Offline copies were kept.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not clear the cache.', 'error');
    } finally {
      setCacheBusy(false);
    }
  };

  const changePassword = async () => {
    setAccountError(null);
    if (newPassword.length < 8) {
      setAccountError('The new password must be at least 8 characters long.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setAccountError('The new passwords do not match.');
      return;
    }
    setAccountBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      notify('Password changed. Other sessions were signed out.', 'success');
    } catch (error) {
      setAccountError(error instanceof Error ? error.message : 'Could not change the password.');
    } finally {
      setAccountBusy(false);
    }
  };

  const settingView = settings;

  return (
    <Modal
      title="Settings"
      subtitle={settingView ? `${settingView.vaultName} · Nimbus ${settingView.version}` : 'Your private library'}
      onClose={onClose}
      size="xl"
      className="settings-modal"
    >
      {loading ? (
        <div className="settings-loading">
          <Spinner size={26} />
          <span>Loading settings…</span>
        </div>
      ) : loadError ? (
        <div className="empty-state compact">
          <span className="empty-icon empty-icon-error">
            <AlertCircle size={28} />
          </span>
          <h2>Could not load settings</h2>
          <p>{loadError}</p>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      ) : (
        <div className="settings-layout">
          <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
            {VISIBLE_TABS.map((entry) => {
              const Icon = entry.icon;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.id}
                  className={`settings-tab${tab === entry.id ? ' is-active' : ''}`}
                  onClick={() => setTab(entry.id)}
                >
                  <Icon size={17} />
                  <span>{entry.label}</span>
                </button>
              );
            })}
            <div className="settings-tabs-spacer" />
            <div className="settings-brand">
              <Sparkles size={16} />
              <span>Private by design</span>
            </div>
          </nav>

          <div className="settings-panel" role="tabpanel">
            {tab === 'general' ? (
              <div className="settings-section">
                <div className="settings-section-head">
                  <h3>General</h3>
                  <p>The essentials for your Nimbus library.</p>
                </div>

                <div className="settings-card">
                  <Field label="Library name" hint="Shown in the sidebar and on the sign-in screen." htmlFor="settings-vault-name">
                    <div className="input-row">
                      <input
                        id="settings-vault-name"
                        className="input"
                        value={name}
                        onChange={(event) => setName(event.target.value)}
                        maxLength={60}
                      />
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void saveName()}
                        disabled={generalBusy || !name.trim() || name.trim() === settingView?.vaultName}
                      >
                        {generalBusy ? <Spinner size={16} /> : null}
                        Save
                      </button>
                    </div>
                  </Field>
                </div>

                <div className="settings-card">
                  <div className="settings-card-head">
                    <div>
                      <h4>Appearance</h4>
                      <p>Choose how Nimbus looks on this browser.</p>
                    </div>
                  </div>
                  <div className="segmented segmented-wide" role="group" aria-label="Theme">
                    {([
                      { id: 'light', label: 'Light', icon: Sun },
                      { id: 'dark', label: 'Dark', icon: Moon },
                      { id: 'system', label: 'System', icon: Monitor },
                    ] as const).map((option) => {
                      const Icon = option.icon;
                      return (
                        <button
                          key={option.id}
                          type="button"
                          className={`segment${theme === option.id ? ' is-active' : ''}`}
                          onClick={() => onThemeChange(option.id as ThemeMode)}
                          aria-pressed={theme === option.id}
                        >
                          <Icon size={15} />
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="form-note">Appearance is remembered on this device.</p>
                </div>

                <div className="settings-card">
                  <div className="settings-stat-grid">
                    <div>
                      <span>Active storage</span>
                      <strong>{activeStorage === 'local' ? 'This device' : activeStorage === 'github' ? 'GitHub' : 'WebDAV'}</strong>
                    </div>
                    <div>
                      <span>Library size</span>
                      <strong>{formatBytes(stats?.usedBytes ?? 0)}</strong>
                    </div>
                    <div>
                      <span>Items</span>
                      <strong>{(stats?.itemCount ?? 0).toLocaleString()}</strong>
                    </div>
                    <div>
                      <span>Favorites</span>
                      <strong>{(stats?.favorites ?? 0).toLocaleString()}</strong>
                    </div>
                  </div>
                  <button type="button" className="link-button" onClick={() => setTab('storage')}>
                    Manage cloud storage →
                  </button>
                </div>
              </div>
            ) : null}

            {tab === 'storage' ? (
              <div className="settings-section">
                <div className="settings-section-head">
                  <h3>Cloud storage</h3>
                  <p>
                    Choose where the original files live. New uploads use the active provider; existing
                    items keep working from wherever they were saved.
                  </p>
                </div>

                <div className="provider-list">
                  <div className={`provider-card${activeStorage === 'local' ? ' is-active' : ''}`}>
                    <div className="provider-card-top">
                      <span className="provider-icon local">
                        <HardDrive size={20} />
                      </span>
                      <div className="provider-title">
                        <h4>This device</h4>
                        <p>Fast, private and unlimited. Files stay on the machine running Nimbus.</p>
                      </div>
                      <span className={`provider-state${activeStorage === 'local' ? ' is-active' : ''}`}>
                        {activeStorage === 'local' ? 'Active' : 'Ready'}
                      </span>
                    </div>
                    <div className="provider-path">
                      <FolderOpen size={15} />
                      <code>{settingView?.storage.local.path ?? 'Local storage'}</code>
                    </div>
                    {activeStorage !== 'local' ? (
                      <div className="provider-actions">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => void activate('local')}
                          disabled={storageBusy !== null}
                        >
                          {storageBusy === 'save-local' ? <Spinner size={15} /> : null}
                          Use this device
                        </button>
                      </div>
                    ) : (
                      <p className="provider-note">New uploads are already stored locally.</p>
                    )}
                  </div>

                  <div className={`provider-card${activeStorage === 'github' ? ' is-active' : ''}`}>
                    <div className="provider-card-top">
                      <span className="provider-icon github">
                        <GitBranch size={20} />
                      </span>
                      <div className="provider-title">
                        <h4>GitHub Releases</h4>
                        <p>Private repository storage with up to 100 GiB per file, split into 1 GiB parts automatically.</p>
                      </div>
                      <span className={`provider-state${activeStorage === 'github' ? ' is-active' : ''}`}>
                        {activeStorage === 'github' ? 'Active' : settingView?.storage.github.configured ? 'Configured' : 'Not set up'}
                      </span>
                    </div>

                    <div className="provider-form">
                      <div className="form-grid two">
                        <Field label="Owner" htmlFor="github-owner">
                          <input
                            id="github-owner"
                            className="input"
                            placeholder="your-username"
                            value={github.owner}
                            onChange={(event) => setGithub((value) => ({ ...value, owner: event.target.value }))}
                            autoComplete="off"
                          />
                        </Field>
                        <Field label="Repository" htmlFor="github-repo">
                          <input
                            id="github-repo"
                            className="input"
                            placeholder="nimbus-library"
                            value={github.repo}
                            onChange={(event) => setGithub((value) => ({ ...value, repo: event.target.value }))}
                            autoComplete="off"
                          />
                        </Field>
                      </div>
                      <Field
                        label="Access token"
                        htmlFor="github-token"
                        hint={
                          settingView?.storage.github.hasToken
                            ? `A token is saved (${settingView.storage.github.tokenHint}). Leave blank to keep it.`
                            : 'Fine-grained token with Contents: Read and write on this repository.'
                        }
                      >
                        <div className="input-with-action">
                          <input
                            id="github-token"
                            className="input"
                            type={showGithubToken ? 'text' : 'password'}
                            placeholder={settingView?.storage.github.hasToken ? '••••••••••••' : 'github_pat_…'}
                            value={github.token}
                            onChange={(event) => setGithub((value) => ({ ...value, token: event.target.value }))}
                            autoComplete="new-password"
                            spellCheck={false}
                          />
                          <button
                            type="button"
                            className="input-action"
                            onClick={() => setShowGithubToken((value) => !value)}
                            aria-label={showGithubToken ? 'Hide token' : 'Show token'}
                          >
                            {showGithubToken ? <EyeOff size={17} /> : <Eye size={17} />}
                          </button>
                        </div>
                      </Field>
                      <details className="inline-details">
                        <summary>First time? Create a private repository automatically</summary>
                        <div className="inline-details-body">
                          <p>
                            Paste a token with permission to create repositories, then choose a name. The
                            repository and storage release are created for you.
                          </p>
                          <div className="input-row">
                            <input
                              className="input"
                              value={newRepoName}
                              onChange={(event) => setNewRepoName(event.target.value)}
                              placeholder="nimbus-library"
                              aria-label="New repository name"
                            />
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={() => void createRepo()}
                              disabled={storageBusy !== null || !github.token.trim()}
                            >
                              {storageBusy === 'create-repo' ? <Spinner size={15} /> : null}
                              Create private repo
                            </button>
                          </div>
                        </div>
                      </details>
                      <Field label="Release tag" htmlFor="github-release" hint="Nimbus starts with this release and creates numbered releases automatically when one reaches GitHub's 1,000-asset limit.">
                        <input
                          id="github-release"
                          className="input"
                          value={github.releaseTag}
                          onChange={(event) => setGithub((value) => ({ ...value, releaseTag: event.target.value }))}
                          autoComplete="off"
                        />
                      </Field>

                      <ResultBanner state={testState?.provider === 'github' ? testState : null} />

                      <div className="provider-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void testProvider('github')}
                          disabled={storageBusy !== null}
                        >
                          {storageBusy === 'test-github' ? <Spinner size={15} /> : null}
                          Test connection
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => void activate('github')}
                          disabled={storageBusy !== null || (!github.token && !settingView?.storage.github.hasToken)}
                        >
                          {storageBusy === 'save-github' ? <Spinner size={15} /> : null}
                          {activeStorage === 'github' ? 'Save changes' : 'Save & use GitHub'}
                        </button>
                      </div>
                      <p className="provider-note">
                        Nimbus splits files over 1 GiB into 1 GiB assets (up to 100 GiB per file) and
                        creates additional releases automatically once a release reaches GitHub&apos;s 1,000
                        asset limit. Public repositories are not allowed for private storage — Nimbus refuses
                        to activate one.
                      </p>
                    </div>
                  </div>

                  <div className={`provider-card${activeStorage === 'webdav' ? ' is-active' : ''}`}>
                    <div className="provider-card-top">
                      <span className="provider-icon webdav">
                        <Server size={20} />
                      </span>
                      <div className="provider-title">
                        <h4>WebDAV</h4>
                        <p>Bring any WebDAV server: Nextcloud, ownCloud, Synology, InfiniCLOUD and more.</p>
                      </div>
                      <span className={`provider-state${activeStorage === 'webdav' ? ' is-active' : ''}`}>
                        {activeStorage === 'webdav' ? 'Active' : settingView?.storage.webdav.configured ? 'Configured' : 'Not set up'}
                      </span>
                    </div>

                    <div className="provider-form">
                      <Field
                        label="Server URL"
                        htmlFor="webdav-url"
                        hint="Use the WebDAV base URL, for example https://cloud.example.com/remote.php/dav/files/me"
                      >
                        <input
                          id="webdav-url"
                          className="input"
                          placeholder="https://cloud.example.com/remote.php/dav/files/me"
                          value={webdav.url}
                          onChange={(event) => setWebdav((value) => ({ ...value, url: event.target.value }))}
                          autoComplete="off"
                          spellCheck={false}
                        />
                      </Field>
                      <div className="form-grid two">
                        <Field label="Username" htmlFor="webdav-user">
                          <input
                            id="webdav-user"
                            className="input"
                            value={webdav.username}
                            onChange={(event) => setWebdav((value) => ({ ...value, username: event.target.value }))}
                            autoComplete="username"
                          />
                        </Field>
                        <Field
                          label="Password / app password"
                          htmlFor="webdav-password"
                          hint={settingView?.storage.webdav.hasPassword ? 'A password is saved. Leave blank to keep it.' : undefined}
                        >
                          <div className="input-with-action">
                            <input
                              id="webdav-password"
                              className="input"
                              type={showWebdavPassword ? 'text' : 'password'}
                              placeholder={settingView?.storage.webdav.hasPassword ? '••••••••••••' : ''}
                              value={webdav.password}
                              onChange={(event) => setWebdav((value) => ({ ...value, password: event.target.value }))}
                              autoComplete="new-password"
                            />
                            <button
                              type="button"
                              className="input-action"
                              onClick={() => setShowWebdavPassword((value) => !value)}
                              aria-label={showWebdavPassword ? 'Hide password' : 'Show password'}
                            >
                              {showWebdavPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                            </button>
                          </div>
                        </Field>
                      </div>
                      <Field label="Folder" htmlFor="webdav-folder" hint="Created automatically inside the WebDAV root.">
                        <input
                          id="webdav-folder"
                          className="input"
                          value={webdav.folder}
                          onChange={(event) => setWebdav((value) => ({ ...value, folder: event.target.value }))}
                          autoComplete="off"
                        />
                      </Field>

                      <ResultBanner state={testState?.provider === 'webdav' ? testState : null} />

                      <div className="provider-actions">
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void testProvider('webdav')}
                          disabled={storageBusy !== null}
                        >
                          {storageBusy === 'test-webdav' ? <Spinner size={15} /> : null}
                          Test connection
                        </button>
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => void activate('webdav')}
                          disabled={storageBusy !== null || (!webdav.url && !settingView?.storage.webdav.configured)}
                        >
                          {storageBusy === 'save-webdav' ? <Spinner size={15} /> : null}
                          {activeStorage === 'webdav' ? 'Save changes' : 'Save & use WebDAV'}
                        </button>
                      </div>
                      <p className="provider-note">
                        Use HTTPS for any server on the internet. Nimbus creates a test file to verify read
                        and write access, then removes it.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="settings-callout">
                  <ShieldCheck size={18} />
                  <div>
                    <strong>Credentials are encrypted at rest</strong>
                    <p>
                      Tokens and passwords are sealed with a master key stored on this server. This protects
                      backups and casual access to the data directory, but it cannot defend against someone
                      who already controls the operating system account running Nimbus.
                    </p>
                  </div>
                </div>
              </div>
            ) : null}

            {tab === 'cache' ? (
              <div className="settings-section">
                <div className="settings-section-head">
                  <h3>Cache &amp; offline</h3>
                  <p>Nimbus keeps previews and recently opened originals close by for instant browsing.</p>
                </div>

                <div className="cache-stat-grid">
                  <div className="cache-stat">
                    <span>Originals cached</span>
                    <strong>{formatBytes(settingView?.cache.blobBytes ?? 0)}</strong>
                    <small>{settingView?.cache.blobCount ?? 0} files</small>
                  </div>
                  <div className="cache-stat">
                    <span>Previews</span>
                    <strong>{formatBytes(settingView?.cache.previewBytes ?? 0)}</strong>
                    <small>Fast thumbnails</small>
                  </div>
                  <div className="cache-stat">
                    <span>Offline copies</span>
                    <strong>{formatBytes(settingView?.cache.pinnedBytes ?? 0)}</strong>
                    <small>{settingView?.cache.pinnedCount ?? 0} pinned · never evicted</small>
                  </div>
                  <div className="cache-stat">
                    <span>Cache limit</span>
                    <strong>{settingView?.cache.limitMB ? formatBytes(settingView.cache.limitMB * 1024 * 1024) : 'Off'}</strong>
                    <small>Oldest files are evicted first</small>
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card-head">
                    <div>
                      <h4>Local cache</h4>
                      <p>Change how much space Nimbus may use on this server.</p>
                    </div>
                  </div>
                  <Field
                    label="Maximum cache size (MB)"
                    htmlFor="cache-limit"
                    hint="Set to 0 to disable caching originals. Previews stay available."
                  >
                    <div className="input-row">
                      <input
                        id="cache-limit"
                        className="input"
                        type="number"
                        min={0}
                        max={1048576}
                        value={cacheLimit}
                        onChange={(event) => setCacheLimit(event.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => void saveCache()}
                        disabled={!cacheDirty || cacheSaving || cacheBusy}
                      >
                        {cacheSaving ? <Spinner size={16} /> : null}
                        Save
                      </button>
                    </div>
                  </Field>
                  <div className="preset-row">
                    {[2048, 8192, 32768, 131072].map((size) => (
                      <button
                        key={size}
                        type="button"
                        className={`chip${Number(cacheLimit) === size ? ' is-active' : ''}`}
                        onClick={() => setCacheLimit(String(size))}
                      >
                        {formatBytes(size * 1024 * 1024)}
                      </button>
                    ))}
                  </div>
                  <Toggle
                    checked={autoCache}
                    onChange={setAutoCache}
                    label="Cache originals as I open them"
                    description="Photos and videos from cloud providers are downloaded in the background when you view them, up to 128 MB each."
                  />
                  <Toggle
                    checked={settingView?.cache.encrypted ?? true}
                    onChange={(checked) => setEncryptionTarget(checked)}
                    label="Encrypt local cache files"
                    description="AES-256-GCM with a key stored on this server. Toggling clears cached originals; pinned items are downloaded again."
                    disabled={cacheBusy}
                  />
                  {cacheBusy ? (
                    <p className="form-note with-spinner">
                      <Spinner size={14} /> Rewriting cache files…
                    </p>
                  ) : null}
                </div>

                <div className="settings-card">
                  <div className="settings-card-head">
                    <div>
                      <h4>Storage cleanup</h4>
                      <p>Clearing the cache never touches your cloud originals.</p>
                    </div>
                  </div>
                  <div className="provider-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setClearTarget(false)}
                      disabled={cacheBusy}
                    >
                      Clear cached originals
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger-ghost btn-sm"
                      onClick={() => setClearTarget(true)}
                      disabled={cacheBusy}
                    >
                      Clear originals, including offline copies
                    </button>
                  </div>
                  <div className="lock-explainer">
                    {settingView?.cache.encrypted ? (
                      <>
                        <LockKeyhole size={17} />
                        <div>
                          <strong>Cache encryption is on</strong>
                          <p>
                            Blobs are split into 1 MiB chunks and sealed with AES-256-GCM. The key lives at
                            <code> data/.cache-key</code>, so encryption protects copied cache files and backups
                            without that key — not a compromised machine.
                          </p>
                        </div>
                      </>
                    ) : (
                      <>
                        <UnlockKeyhole size={17} />
                        <div>
                          <strong>Cache encryption is off</strong>
                          <p>
                            Cached originals and previews are written as plain files. The option affects local
                            cache only; cloud providers still store your originals under their own security.
                          </p>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {tab === 'account' ? (
              <div className="settings-section">
                <div className="settings-section-head">
                  <h3>Account</h3>
                  <p>Nimbus is a single-owner library. Your password protects this browser session.</p>
                </div>

                <div className="settings-card">
                  <div className="settings-card-head">
                    <div>
                      <h4>Change password</h4>
                      <p>At least 8 characters. Other active sessions will be signed out.</p>
                    </div>
                    <span className="account-avatar" aria-hidden="true">
                      <User size={20} />
                    </span>
                  </div>
                  {accountError ? (
                    <div className="form-error-banner" role="alert">
                      <AlertCircle size={16} /> {accountError}
                    </div>
                  ) : null}
                  <Field label="Current password" htmlFor="account-current">
                    <input
                      id="account-current"
                      className="input"
                      type="password"
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                      autoComplete="current-password"
                    />
                  </Field>
                  <div className="form-grid two">
                    <Field label="New password" htmlFor="account-new">
                      <input
                        id="account-new"
                        className="input"
                        type="password"
                        value={newPassword}
                        onChange={(event) => setNewPassword(event.target.value)}
                        autoComplete="new-password"
                      />
                    </Field>
                    <Field label="Confirm new password" htmlFor="account-confirm">
                      <input
                        id="account-confirm"
                        className="input"
                        type="password"
                        value={confirmPassword}
                        onChange={(event) => setConfirmPassword(event.target.value)}
                        autoComplete="new-password"
                      />
                    </Field>
                  </div>
                  <div className="provider-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => void changePassword()}
                      disabled={accountBusy || !currentPassword || !newPassword || !confirmPassword}
                    >
                      {accountBusy ? <Spinner size={16} /> : null}
                      Update password
                    </button>
                  </div>
                </div>

                <div className="settings-card">
                  <div className="settings-card-head">
                    <div>
                      <h4>Session</h4>
                      <p>Signing out ends this browser session. Your library and files stay intact.</p>
                    </div>
                  </div>
                  <button type="button" className="btn btn-ghost" onClick={onLogout}>
                    <LogOut size={16} /> Sign out
                  </button>
                </div>

                <div className="settings-card danger-zone">
                  <div className="settings-card-head">
                    <div>
                      <h4>Danger zone</h4>
                      <p>Permanently erase this account and everything in the library.</p>
                    </div>
                  </div>
                  <div className="danger-zone-row">
                    <div>
                      <strong>Delete library and account</strong>
                      <p>
                        Removes the local library, cache, credentials and sessions, then deletes stored originals.
                        You can optionally delete the GitHub repository too.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn btn-danger-ghost"
                      onClick={() => setDeleteOpen(true)}
                      disabled={accountBusy}
                    >
                      <Trash2 size={16} /> Delete library…
                    </button>
                  </div>
                </div>

                <div className="settings-callout">
                  <KeyRound size={18} />
                  <div>
                    <strong>Forgot your password?</strong>
                    {isDesktop ? (
                      <p>
                        Sign out, then choose <strong>Forgot password?</strong> on the sign-in screen. The
                        desktop app can reset the password locally without any commands. Existing sessions
                        are signed out.
                      </p>
                    ) : (
                      <p>
                        Because there is no email recovery, reset it from the machine running Nimbus with
                        <code> npm run reset-password</code>. You will need access to the data directory.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            ) : null}

            {tab === 'desktop' ? <DesktopSettings notify={notify} /> : null}

            {tab === 'about' ? (
              <div className="settings-section about-section">
                <div className="about-hero">
                  <div className="about-mark">
                    <Cloud size={28} />
                  </div>
                  <div>
                    <h3>Nimbus</h3>
                    <p>Version {settingView?.version ?? '1.1.0'} · A private cloud you actually own.</p>
                  </div>
                </div>

                <div className="settings-card">
                  <h4>Where your files live</h4>
                  <ul className="about-list">
                    <li>
                      <HardDrive size={17} />
                      <div>
                        <strong>This device</strong>
                        <span>Originals on local disk. Fast, unlimited, and fully under your control.</span>
                      </div>
                    </li>
                    <li>
                      <GitBranch size={17} />
                      <div>
                        <strong>GitHub Releases</strong>
                        <span>Assets on private releases in a repository you own. Files over 1 GiB are split into 1 GiB parts automatically, up to 100 GiB per file. New releases are created as they fill.</span>
                      </div>
                    </li>
                    <li>
                      <Server size={17} />
                      <div>
                        <strong>WebDAV</strong>
                        <span>Any compatible server or NAS. Nimbus streams uploads and range downloads directly.</span>
                      </div>
                    </li>
                    <li>
                      <Database size={17} />
                      <div>
                        <strong>SQLite + local cache</strong>
                        <span>Metadata stays on this server. Previews and offline copies are cached in <code>data/cache</code>.</span>
                      </div>
                    </li>
                  </ul>
                </div>

                <div className="settings-card">
                  <h4>Why not YouTube or Instagram?</h4>
                  <p className="about-copy">
                    Neither service offers a private file-storage API. Their terms prohibit using them as
                    general-purpose storage, and unofficial workarounds would put your accounts and files at
                    risk. Nimbus deliberately uses storage APIs that are meant for this: a private GitHub
                    repository, your own WebDAV server, or local disk. It will never pretend a social platform
                    is a safe cloud drive.
                  </p>
                </div>

                <div className="settings-card">
                  <h4>Privacy &amp; security model</h4>
                  <ul className="about-points">
                    <li>Single-owner access with scrypt password hashing and DB-backed sessions.</li>
                    <li>HttpOnly, SameSite=Lax cookies plus a CSRF header on every mutation.</li>
                    <li>Storage credentials sealed with AES-256-GCM; cache encryption is toggleable.</li>
                    <li>No analytics, no third-party scripts, no outbound traffic except to your chosen storage provider.</li>
                    <li>Strict CSP, nosniff, frameguard and restrictive permissions headers.</li>
                  </ul>
                  <div className="settings-callout inside">
                    <ShieldCheck size={18} />
                    <div>
                      <strong>Honest limits</strong>
                      <p>
                        Encryption keys live on the server. If someone has full access to the OS account
                        running Nimbus, they can read the keys and the library. Use full-disk encryption and a
                        dedicated user account for the strongest protection.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="settings-card">
                  <h4>Limits worth knowing</h4>
                  <ul className="about-points">
                    <li>GitHub allows 1,000 assets per release and about 100 GB per repository. Nimbus splits large files into 1 GiB parts, presents them as one file, and rotates releases automatically.</li>
                    <li>WebDAV upload size depends on your server configuration.</li>
                    <li>Deleting a file in the provider outside Nimbus breaks that item&apos;s download until removed.</li>
                    <li>Trash items are permanently deleted after 30 days. Emptying trash is immediate.</li>
                  </ul>
                </div>

                <div className="settings-card">
                  <h4>Credits</h4>
                  <ul className="credits-list">
                    <li>
                      <span>Creator &amp; maintainer</span>
                      <a href="https://github.com/SimplyDaviiz" target="_blank" rel="noreferrer">
                        @SimplyDaviiz
                      </a>
                    </li>
                    <li>
                      <span>Development assistant</span>
                      <span>OpenCode AI</span>
                    </li>
                    <li>
                      <span>Built with</span>
                      <span>React · Fastify · Electron · Sharp</span>
                    </li>
                  </ul>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={encryptionTarget !== null}
        title={encryptionTarget ? 'Turn on cache encryption?' : 'Turn off cache encryption?'}
        description={
          <span>
            {encryptionTarget
              ? 'Cached originals will be cleared and re-downloaded when needed. Previews will be rewritten encrypted. Pinned offline copies will be downloaded again in the encrypted format.'
              : 'Cached files will be rewritten without encryption. Anyone with access to the data directory could read them. Pinned offline copies will be downloaded again.'}
            <br />
            <br />
            This can take a moment and requires an internet connection to restore pinned offline copies.
          </span>
        }
        confirmLabel={encryptionTarget ? 'Encrypt cache' : 'Remove encryption'}
        tone={encryptionTarget ? 'primary' : 'danger'}
        busy={cacheBusy}
        onCancel={() => setEncryptionTarget(null)}
        onConfirm={() => void toggleEncryption()}
      />

      <DeleteLibraryDialog
        open={deleteOpen}
        vaultName={settingView?.vaultName ?? vaultName}
        itemCount={stats?.itemCount ?? 0}
        usedBytes={stats?.usedBytes ?? 0}
        github={{
          configured: Boolean(settingView?.storage.github.configured),
          owner: settingView?.storage.github.owner ?? '',
          repo: settingView?.storage.github.repo ?? '',
        }}
        webdav={{ configured: Boolean(settingView?.storage.webdav.configured) }}
        onClose={() => setDeleteOpen(false)}
        onDeleted={() => {
          setDeleteOpen(false);
          onAccountDeleted();
        }}
        onDeletionStarted={onDeletionStarted}
      />

      <ConfirmDialog
        open={clearTarget !== null}
        title={clearTarget ? 'Clear all cached originals?' : 'Clear cached originals?'}
        description={
          clearTarget
            ? 'This removes every cached original, including pinned offline copies, from this server. Previews stay so the gallery loads instantly. Cloud originals are not affected. Items will download again when opened.'
            : 'This removes cached originals that are not pinned for offline use. Previews and offline copies are kept. Cloud originals are not affected.'
        }
        confirmLabel={clearTarget ? 'Clear all originals' : 'Clear cache'}
        tone="danger"
        busy={cacheBusy}
        onCancel={() => setClearTarget(null)}
        onConfirm={() => void clearCache()}
      />
    </Modal>
  );
}
