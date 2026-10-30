import { useMemo, useState } from 'react';
import type { AppStatus, ProviderId, ProviderTestResult, SetupRequest } from '../../../shared/types';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Cloud,
  Eye,
  EyeOff,
  GitBranch,
  HardDrive,
  HardDriveDownload,
  KeyRound,
  LockKeyhole,
  Server,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react';
import { api } from '../api';
import { isDesktop } from '../desktop';
import { Logo, Spinner, Toggle } from './ui';

interface OnboardingProps {
  onComplete: (status: AppStatus) => void;
  telemetryConfigured: boolean;
}

const STORAGE_OPTIONS: Array<{
  id: ProviderId;
  title: string;
  blurb: string;
  icon: typeof HardDrive;
}> = [
  {
    id: 'local',
    title: 'This device',
    blurb: 'Store originals on this computer. Fastest setup, unlimited space.',
    icon: HardDrive,
  },
  {
    id: 'github',
    title: 'GitHub Releases',
    blurb: 'Private repo storage. Free, off-site and available anywhere.',
    icon: GitBranch,
  },
  {
    id: 'webdav',
    title: 'WebDAV',
    blurb: 'Connect Nextcloud, Synology, ownCloud or any WebDAV server.',
    icon: Server,
  },
];

export function Onboarding({ onComplete, telemetryConfigured }: OnboardingProps) {
  const [step, setStep] = useState(1);
  const [vaultName, setVaultName] = useState('My Nimbus');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [provider, setProvider] = useState<ProviderId>('local');
  const [github, setGithub] = useState({ token: '', owner: '', repo: '', releaseTag: 'nimbus-storage' });
  const [webdav, setWebdav] = useState({ url: '', username: '', password: '', folder: 'nimbus' });
  const [repoName, setRepoName] = useState('nimbus-library');
  const [telemetry, setTelemetry] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);

  const passwordScore = useMemo(() => {
    let score = 0;
    if (password.length >= 8) score += 1;
    if (password.length >= 12) score += 1;
    if (/[A-Z]/.test(password) && /[a-z]/.test(password)) score += 1;
    if (/\d/.test(password) || /[^A-Za-z0-9]/.test(password)) score += 1;
    return score;
  }, [password]);

  const stepOneValid = vaultName.trim().length > 0 && password.length >= 8 && password === confirm;

  const testConnection = async () => {
    setError(null);
    setTestResult(null);
    setBusy('test');
    try {
      const config =
        provider === 'github'
          ? { token: github.token, owner: github.owner, repo: github.repo, releaseTag: github.releaseTag }
          : provider === 'webdav'
            ? { url: webdav.url, username: webdav.username, password: webdav.password, folder: webdav.folder }
            : undefined;
      const result = await api.testStorage(provider, config);
      setTestResult(result);
    } catch (caught) {
      setTestResult({
        ok: false,
        message: caught instanceof Error ? caught.message : 'Could not test this storage provider.',
      });
    } finally {
      setBusy(null);
    }
  };

  const createRepo = async () => {
    if (!github.token.trim()) {
      setError('Paste a GitHub token before creating a repository.');
      return;
    }
    setError(null);
    setBusy('repo');
    try {
      const result = await api.createGithubRepo(github.token.trim(), repoName.trim() || 'nimbus-library');
      setGithub((value) => ({ ...value, owner: result.owner, repo: result.repo }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create the repository.');
    } finally {
      setBusy(null);
    }
  };

  const next = () => {
    setError(null);
    setTestResult(null);
    if (step === 1) {
      if (!stepOneValid) {
        setError(
          password.length < 8
            ? 'Choose a password with at least 8 characters.'
            : password !== confirm
              ? 'The passwords do not match.'
              : 'Give your library a name.',
        );
        return;
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      if (provider === 'github' && (!github.token || !github.owner || !github.repo)) {
        setError('Enter the GitHub token, owner and repository name, or switch back to local storage.');
        return;
      }
      if (provider === 'webdav' && !webdav.url.trim()) {
        setError('Enter the WebDAV server URL, or switch back to local storage.');
        return;
      }
      setStep(3);
    }
  };

  const create = async () => {
    setError(null);
    setBusy('create');
    try {
      const storage: NonNullable<SetupRequest['storage']> =
        provider === 'github'
          ? {
              active: 'github',
              github: {
                token: github.token,
                owner: github.owner,
                repo: github.repo,
                releaseTag: github.releaseTag,
              },
            }
          : provider === 'webdav'
            ? {
                active: 'webdav',
                webdav: {
                  url: webdav.url,
                  username: webdav.username,
                  password: webdav.password,
                  folder: webdav.folder,
                },
              }
            : { active: 'local' };
      const status = await api.setup({
        vaultName: vaultName.trim(),
        password,
        telemetry,
        storage,
      });
      onComplete(status);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create your library.');
      setBusy(null);
      setStep(3);
    }
  };

  const providerLabel =
    provider === 'github' ? `GitHub · ${github.owner || 'owner'}/${github.repo || 'repository'}` : provider === 'webdav' ? `WebDAV · ${webdav.url || 'server'}` : 'This device';

  return (
    <div className="onboarding">
      <aside className="onboarding-brand">
        <div className="onboarding-brand-top">
          <Logo size={34} />
          <span className="onboarding-badge">Self-hosted</span>
        </div>
        <div className="onboarding-pitch">
          <h1>Your memories. Your cloud. Your rules.</h1>
          <p>
            Nimbus is a private photo, video and file library backed by storage you already own.
            Beautiful to browse, encrypted on the ground, and free from subscriptions.
          </p>
          <ul className="onboarding-features">
            <li>
              <span><Cloud size={17} /></span>
              <div>
                <strong>Any cloud you trust</strong>
                <p>Local disk, a private GitHub repo, or your own WebDAV server.</p>
              </div>
            </li>
            <li>
              <span><HardDriveDownload size={17} /></span>
              <div>
                <strong>Instant, private cache</strong>
                <p>Previews and pinned originals are available even when the cloud is slow.</p>
              </div>
            </li>
            <li>
              <span><ShieldCheck size={17} /></span>
              <div>
                <strong>Encrypted local cache</strong>
                <p>AES-256-GCM by default, with a switch you control at any time.</p>
              </div>
            </li>
            <li>
              <span><Zap size={17} /></span>
              <div>
                <strong>No subscriptions</strong>
                <p>No accounts to rent, no ads, no lock-in. Just your library.</p>
              </div>
            </li>
          </ul>
        </div>
        <p className="onboarding-foot">Nimbus 1.3 · Built for one owner: you.</p>
      </aside>

      <main className="onboarding-main">
        <div className="onboarding-card">
          <div className="onboarding-progress" aria-label={`Step ${step} of 3`}>
            {[1, 2, 3].map((value) => (
              <span key={value} className={value === step ? 'is-current' : value < step ? 'is-done' : ''}>
                {value < step ? <CheckCircle2 size={14} /> : value}
              </span>
            ))}
            <small>{step === 1 ? 'Account' : step === 2 ? 'Storage' : 'Review'}</small>
          </div>

          {error ? (
            <div className="form-error-banner" role="alert">
              <AlertCircle size={17} /> {error}
            </div>
          ) : null}

          {step === 1 ? (
            <div className="onboarding-step">
              <header className="onboarding-step-head">
                <span className="step-eyebrow">Welcome aboard</span>
                <h2>Create your private cloud</h2>
                <p>One password protects this library. There are no accounts to create anywhere else.</p>
              </header>

              <label className="field-label" htmlFor="setup-name">Library name</label>
              <input
                id="setup-name"
                className="input input-lg"
                value={vaultName}
                onChange={(event) => setVaultName(event.target.value)}
                maxLength={60}
                placeholder="My Nimbus"
                autoFocus
              />

              <div className="form-grid two onboarding-passwords">
                <div>
                  <label className="field-label" htmlFor="setup-password">Password</label>
                  <div className="input-with-action">
                    <input
                      id="setup-password"
                      className="input input-lg"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      autoComplete="new-password"
                      placeholder="At least 8 characters"
                    />
                    <button
                      type="button"
                      className="input-action"
                      onClick={() => setShowPassword((value) => !value)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>
                <div>
                  <label className="field-label" htmlFor="setup-confirm">Confirm password</label>
                  <input
                    id="setup-confirm"
                    className="input input-lg"
                    type={showPassword ? 'text' : 'password'}
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    autoComplete="new-password"
                    placeholder="Type it again"
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') next();
                    }}
                  />
                </div>
              </div>

              <div className="password-meter" aria-hidden="true">
                {[1, 2, 3, 4].map((value) => (
                  <span key={value} className={value <= passwordScore ? `score-${passwordScore}` : ''} />
                ))}
                <small>
                  {password.length === 0
                    ? 'Use a long, unique password.'
                    : passwordScore <= 1
                      ? 'Weak — add more characters.'
                      : passwordScore === 2
                        ? 'Okay — longer is better.'
                        : passwordScore === 3
                          ? 'Good password.'
                          : 'Excellent password.'}
                </small>
              </div>

              <div className="onboarding-hint">
                <LockKeyhole size={17} />
                {isDesktop ? (
                  <p>
                    Store this password in a password manager. If you lose it, sign out and choose
                    <strong> Forgot password?</strong> on the sign-in screen to reset it locally. Existing
                    sessions are signed out.
                  </p>
                ) : (
                  <p>
                    Store this password in a password manager. If you lose it, run
                    <code> npm run reset-password</code> on the server.
                  </p>
                )}
              </div>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="onboarding-step">
              <header className="onboarding-step-head">
                <span className="step-eyebrow">Step 2 of 3</span>
                <h2>Where should originals live?</h2>
                <p>Pick one now. You can add another provider later without moving existing files.</p>
              </header>

              <div className="storage-choice-list">
                {STORAGE_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  const selected = provider === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={`storage-choice${selected ? ' is-selected' : ''}`}
                      onClick={() => {
                        setProvider(option.id);
                        setTestResult(null);
                        setError(null);
                      }}
                      aria-pressed={selected}
                    >
                      <span className={`storage-choice-icon ${option.id}`}>
                        <Icon size={20} />
                      </span>
                      <span className="storage-choice-copy">
                        <strong>{option.title}</strong>
                        <small>{option.blurb}</small>
                      </span>
                      <span className="radio-dot" aria-hidden="true" />
                    </button>
                  );
                })}
              </div>

              {provider === 'github' ? (
                <div className="onboarding-provider-form">
                  <div className="form-grid two">
                    <div>
                      <label className="field-label" htmlFor="setup-gh-owner">GitHub owner</label>
                      <input
                        id="setup-gh-owner"
                        className="input"
                        value={github.owner}
                        onChange={(event) => setGithub((value) => ({ ...value, owner: event.target.value }))}
                        placeholder="your-username"
                        autoComplete="off"
                      />
                    </div>
                    <div>
                      <label className="field-label" htmlFor="setup-gh-repo">Repository</label>
                      <input
                        id="setup-gh-repo"
                        className="input"
                        value={github.repo}
                        onChange={(event) => setGithub((value) => ({ ...value, repo: event.target.value }))}
                        placeholder="nimbus-library"
                        autoComplete="off"
                      />
                    </div>
                  </div>
                  <label className="field-label" htmlFor="setup-gh-token">Fine-grained access token</label>
                  <div className="input-with-action">
                    <input
                      id="setup-gh-token"
                      className="input"
                      type={showPassword ? 'text' : 'password'}
                      value={github.token}
                      onChange={(event) => setGithub((value) => ({ ...value, token: event.target.value }))}
                      placeholder="github_pat_…"
                      autoComplete="new-password"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="input-action"
                      onClick={() => setShowPassword((value) => !value)}
                      aria-label={showPassword ? 'Hide token' : 'Show token'}
                    >
                      {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                  <p className="field-hint">
                    Token needs <strong>Contents: Read and write</strong> on a private repository. Nimbus
                    creates a dedicated release, never commits to the branch.
                  </p>
                  <details className="inline-details">
                    <summary>Don&apos;t have a repository yet? Create one now</summary>
                    <div className="inline-details-body">
                      <div className="input-row">
                        <input
                          className="input"
                          value={repoName}
                          onChange={(event) => setRepoName(event.target.value)}
                          placeholder="nimbus-library"
                          aria-label="Repository name"
                        />
                        <button
                          type="button"
                          className="btn btn-ghost"
                          onClick={() => void createRepo()}
                          disabled={busy !== null || !github.token.trim()}
                        >
                          {busy === 'repo' ? <Spinner size={15} /> : null}
                          Create private repo
                        </button>
                      </div>
                      <p className="field-hint">Requires a token that can create repositories on your account.</p>
                    </div>
                  </details>
                </div>
              ) : null}

              {provider === 'webdav' ? (
                <div className="onboarding-provider-form">
                  <label className="field-label" htmlFor="setup-dav-url">Server URL</label>
                  <input
                    id="setup-dav-url"
                    className="input"
                    value={webdav.url}
                    onChange={(event) => setWebdav((value) => ({ ...value, url: event.target.value }))}
                    placeholder="https://cloud.example.com/remote.php/dav/files/me"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <div className="form-grid two">
                    <div>
                      <label className="field-label" htmlFor="setup-dav-user">Username</label>
                      <input
                        id="setup-dav-user"
                        className="input"
                        value={webdav.username}
                        onChange={(event) => setWebdav((value) => ({ ...value, username: event.target.value }))}
                        autoComplete="username"
                      />
                    </div>
                    <div>
                      <label className="field-label" htmlFor="setup-dav-pass">Password</label>
                      <input
                        id="setup-dav-pass"
                        className="input"
                        type="password"
                        value={webdav.password}
                        onChange={(event) => setWebdav((value) => ({ ...value, password: event.target.value }))}
                        autoComplete="new-password"
                      />
                    </div>
                  </div>
                  <label className="field-label" htmlFor="setup-dav-folder">Folder</label>
                  <input
                    id="setup-dav-folder"
                    className="input"
                    value={webdav.folder}
                    onChange={(event) => setWebdav((value) => ({ ...value, folder: event.target.value }))}
                    autoComplete="off"
                  />
                  <p className="field-hint">The folder is created automatically and can be changed later.</p>
                </div>
              ) : null}

              {provider !== 'local' ? (
                <div className="onboarding-test-row">
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void testConnection()} disabled={busy !== null}>
                    {busy === 'test' ? <Spinner size={15} /> : <ShieldCheck size={15} />}
                    Test connection
                  </button>
                  {testResult ? (
                    <span className={`inline-test${testResult.ok ? ' is-ok' : ' is-error'}`}>
                      {testResult.ok ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
                      {testResult.ok ? testResult.message : testResult.message}
                    </span>
                  ) : null}
                </div>
              ) : (
                <div className="onboarding-hint">
                  <HardDrive size={17} />
                  <p>
                    Local storage lives in <code>data/storage</code>. You can move the data directory or switch
                    providers whenever you like.
                  </p>
                </div>
              )}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="onboarding-step">
              <header className="onboarding-step-head">
                <span className="step-eyebrow">Final check</span>
                <h2>Ready for takeoff</h2>
                <p>Review the essentials, then open your library.</p>
              </header>

              <div className="review-card">
                <div className="review-row">
                  <span>Library name</span>
                  <strong>{vaultName.trim()}</strong>
                </div>
                <div className="review-row">
                  <span>Storage for new files</span>
                  <strong>{providerLabel}</strong>
                </div>
                <div className="review-row">
                  <span>Local cache</span>
                  <strong><LockKeyhole size={14} /> Encrypted · 8 GB</strong>
                </div>
                <div className="review-row">
                  <span>Access</span>
                  <strong><KeyRound size={14} /> Single owner · this password</strong>
                </div>
                <div className="review-row">
                  <span>Anonymous statistics</span>
                  <strong><Activity size={14} /> {telemetry ? 'Opted in' : 'Off'}</strong>
                </div>
              </div>

              <div className="onboarding-telemetry">
                <Toggle
                  checked={telemetry}
                  onChange={setTelemetry}
                  disabled={!telemetryConfigured}
                  label="Send anonymous usage statistics"
                  description="Optional, off by default. At most a daily heartbeat with the Nimbus version, platform, storage provider and coarse library size. No file names, vault names or exact counts."
                />
                <p className="field-hint">
                  {telemetryConfigured
                    ? 'You can change this later in Settings → General. Turning it off deletes the random install ID.'
                    : 'This server has no telemetry endpoint configured, so nothing can be sent. The switch stays disabled until the owner sets NIMBUS_TELEMETRY_URL.'}
                </p>
              </div>

              {provider !== 'local' ? (
                <p className="review-note">
                  Nimbus will verify the connection during setup. If the provider rejects it, your library is
                  not created and you can come back to fix the details.
                </p>
              ) : null}

              <div className="onboarding-hint">
                <Sparkles size={17} />
                <p>
                  Cache encryption starts enabled. You can toggle it off in Settings → Cache &amp; offline at
                  any time. Your cloud originals are independent of this setting.
                </p>
              </div>

              <button
                type="button"
                className="btn btn-primary btn-lg onboarding-create"
                onClick={() => void create()}
                disabled={busy !== null}
              >
                {busy === 'create' ? <Spinner size={18} /> : <Sparkles size={18} />}
                {busy === 'create' ? 'Creating your library…' : 'Create my library'}
              </button>
            </div>
          ) : null}

          <footer className="onboarding-actions">
            {step > 1 ? (
              <button type="button" className="btn btn-ghost" onClick={() => { setStep(step - 1); setError(null); }} disabled={busy !== null}>
                <ArrowLeft size={16} /> Back
              </button>
            ) : (
              <span />
            )}
            {step < 3 ? (
              <button type="button" className="btn btn-primary" onClick={next} disabled={busy !== null}>
                Continue <ArrowRight size={16} />
              </button>
            ) : (
              <span className="onboarding-actions-note">Your files never pass through a third party.</span>
            )}
          </footer>
        </div>
      </main>
    </div>
  );
}
