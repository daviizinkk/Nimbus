import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Bell,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  FileText,
  FolderOpen,
  Gamepad2,
  Laptop,
  MonitorDown,
  Power,
  Radio,
  Save,
  ShieldCheck,
  Trash2,
  Wrench,
} from 'lucide-react';
import type {
  DesktopDiscordConfig,
  DesktopDiscordStatus,
  DesktopInfo,
  DesktopPreferences,
} from '../../../shared/types';
import { desktop } from '../desktop';
import { ConfirmDialog, Field, Spinner, Toggle } from './ui';

const DEFAULT_CONFIG: DesktopDiscordConfig = {
  enabled: true,
  applicationId: '1563561943468351569',
  showActivity: false,
};

const OFF_STATUS: DesktopDiscordStatus = {
  state: 'off',
  message: 'Rich Presence is off.',
  user: null,
};

type ToolAction = 'data' | 'logs' | 'shortcut' | 'diagnostics';

interface DesktopSettingsProps {
  notify: (message: string, kind?: 'success' | 'error' | 'info') => void;
}

function sameConfig(a: DesktopDiscordConfig, b: DesktopDiscordConfig): boolean {
  return (
    a.enabled === b.enabled &&
    a.applicationId === b.applicationId &&
    a.showActivity === b.showActivity
  );
}

function statusTone(state: DesktopDiscordStatus['state']): string {
  if (state === 'connected') return 'is-ok';
  if (state === 'error') return 'is-error';
  if (state === 'disconnected') return 'is-warn';
  if (state === 'connecting') return 'is-pending';
  return 'is-off';
}

const TOOL_MESSAGES: Record<ToolAction, string> = {
  data: 'Opened the library folder.',
  logs: 'Opened the logs folder.',
  shortcut: 'Desktop shortcut created.',
  diagnostics: 'Diagnostics copied to the clipboard.',
};

const DEFAULT_PREFERENCES: DesktopPreferences = {
  closeToTray: true,
  launchAtLogin: false,
  notifications: true,
};

export function DesktopSettings({ notify }: DesktopSettingsProps) {
  const [info, setInfo] = useState<DesktopInfo | null>(null);
  const [config, setConfig] = useState<DesktopDiscordConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState<DesktopDiscordConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<DesktopDiscordStatus>(OFF_STATUS);
  const [preferences, setPreferences] = useState<DesktopPreferences>(DEFAULT_PREFERENCES);
  const [savedPreferences, setSavedPreferences] = useState<DesktopPreferences>(DEFAULT_PREFERENCES);
  const [preferencesBusy, setPreferencesBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toolBusy, setToolBusy] = useState<ToolAction | 'uninstall' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uninstallOpen, setUninstallOpen] = useState(false);

  useEffect(() => {
    if (!desktop) {
      setLoading(false);
      return;
    }
    let active = true;
    void desktop
      .getInfo()
      .then((value) => {
        if (active) setInfo(value);
      })
      .catch(() => {});
    void desktop
      .getPreferences()
      .then((value) => {
        if (!active) return;
        setPreferences(value);
        setSavedPreferences(value);
      })
      .catch(() => {});
    void desktop.rpc
      .get()
      .then((result) => {
        if (!active) return;
        setConfig(result.config);
        setSaved(result.config);
        setStatus(result.status);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : 'Could not load desktop settings.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const unsubscribe = desktop.rpc.onStatus((next) => {
      if (active) setStatus(next);
    });
    const unsubscribePreferences = desktop.onPreferences((next) => {
      if (!active) return;
      setPreferences(next);
      setSavedPreferences(next);
    });

    return () => {
      active = false;
      unsubscribe?.();
      unsubscribePreferences?.();
    };
  }, []);

  const dirty = useMemo(() => !sameConfig(config, saved), [config, saved]);
  const preferencesDirty = useMemo(
    () =>
      preferences.closeToTray !== savedPreferences.closeToTray ||
      preferences.launchAtLogin !== savedPreferences.launchAtLogin ||
      preferences.notifications !== savedPreferences.notifications,
    [preferences, savedPreferences],
  );

  const savePreferences = async () => {
    if (!desktop || preferencesBusy) return;
    setPreferencesBusy(true);
    try {
      const result = await desktop.savePreferences(preferences);
      if (!result.ok || !result.preferences) {
        notify(result.error ?? 'Could not save desktop preferences.', 'error');
        return;
      }
      setPreferences(result.preferences);
      setSavedPreferences(result.preferences);
      notify(
        result.preferences.closeToTray
          ? 'Desktop preferences saved. Closing the window keeps Nimbus in the tray.'
          : 'Desktop preferences saved. Closing the window now quits Nimbus.',
        'success',
      );
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : 'Could not save desktop preferences.', 'error');
    } finally {
      setPreferencesBusy(false);
    }
  };

  const save = async () => {
    if (!desktop || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await desktop.rpc.save(config);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setConfig(result.config);
      setSaved(result.config);
      setStatus(result.status);
      notify(
        result.config.enabled && result.status.state === 'connected'
          ? 'Discord Rich Presence is on.'
          : 'Desktop settings saved.',
        result.config.enabled && result.status.state !== 'connected' ? 'info' : 'success',
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save desktop settings.');
    } finally {
      setSaving(false);
    }
  };

  const runTool = async (action: ToolAction) => {
    if (!desktop || toolBusy) return;
    setToolBusy(action);
    try {
      const result =
        action === 'data'
          ? await desktop.openDataFolder()
          : action === 'logs'
            ? await desktop.openLogsFolder()
            : action === 'shortcut'
              ? await desktop.createShortcut()
              : await desktop.copyDiagnostics();
      if (!result.ok) {
        notify(result.error ?? 'The desktop action could not be completed.', 'error');
      } else {
        notify(TOOL_MESSAGES[action], 'success');
      }
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : 'The desktop action could not be completed.', 'error');
    } finally {
      setToolBusy(null);
    }
  };

  const openUninstaller = async () => {
    if (!desktop || toolBusy) return;
    setToolBusy('uninstall');
    try {
      const result = await desktop.openUninstaller();
      if (!result.ok) {
        notify(result.error ?? 'Could not open the uninstaller.', 'error');
      }
    } catch (caught) {
      notify(caught instanceof Error ? caught.message : 'Could not open the uninstaller.', 'error');
    } finally {
      setToolBusy(null);
      setUninstallOpen(false);
    }
  };

  if (!desktop) {
    return (
      <div className="settings-section">
        <div className="settings-section-head">
          <h3>Desktop</h3>
          <p>Discord Rich Presence and window controls are available in the Nimbus desktop app.</p>
        </div>
        <div className="settings-callout">
          <Laptop size={18} />
          <div>
            <strong>Open Nimbus for Windows</strong>
            <p>Install the desktop build from the release installer, or run <code>npm run desktop:dev</code>.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <div className="settings-section-head">
        <h3>Desktop &amp; Discord</h3>
        <p>Optional extras for the Nimbus desktop app. These settings are stored on this computer.</p>
      </div>

      <div className="settings-card">
        <div className="settings-card-head">
          <div>
            <h4>Nimbus Desktop</h4>
            <p>
              {info ? `Version ${info.version} · Electron ${info.electron}` : 'Running as a desktop app.'}
            </p>
          </div>
          <span className="desktop-setting-badge">
            <Laptop size={14} /> This PC
          </span>
        </div>
        <p className="desktop-setting-copy">
          The library runs locally and opens in its own window.{' '}
          {preferences.closeToTray
            ? 'Closing the window keeps Nimbus and any running uploads alive in the notification area. Use Quit Nimbus in the tray menu to stop the local server.'
            : 'Closing the window quits Nimbus and stops the local server once state is saved.'}
        </p>
        {info ? (
          <p className="desktop-setting-copy desktop-path" title={info.dataDir}>
            Library: {info.dataDir}
          </p>
        ) : null}

        <div className="desktop-tools-grid">
          <button
            type="button"
            className="desktop-tool"
            onClick={() => void runTool('data')}
            disabled={toolBusy !== null}
          >
            {toolBusy === 'data' ? <Spinner size={17} /> : <FolderOpen size={17} />}
            <span>
              <strong>Open library folder</strong>
              <small>Database, originals and cache</small>
            </span>
          </button>
          <button
            type="button"
            className="desktop-tool"
            onClick={() => void runTool('logs')}
            disabled={toolBusy !== null}
          >
            {toolBusy === 'logs' ? <Spinner size={17} /> : <FileText size={17} />}
            <span>
              <strong>Open logs</strong>
              <small>Troubleshooting and startup errors</small>
            </span>
          </button>
          <button
            type="button"
            className="desktop-tool"
            onClick={() => void runTool('shortcut')}
            disabled={toolBusy !== null}
          >
            {toolBusy === 'shortcut' ? <Spinner size={17} /> : <MonitorDown size={17} />}
            <span>
              <strong>Create desktop shortcut</strong>
              <small>Put Nimbus back on your desktop</small>
            </span>
          </button>
          <button
            type="button"
            className="desktop-tool"
            onClick={() => void runTool('diagnostics')}
            disabled={toolBusy !== null}
          >
            {toolBusy === 'diagnostics' ? <Spinner size={17} /> : <ClipboardCheck size={17} />}
            <span>
              <strong>Copy diagnostics</strong>
              <small>Version, paths and Discord status</small>
            </span>
          </button>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-head">
          <div className="desktop-setting-title">
            <span className="desktop-setting-icon">
              <Bell size={18} />
            </span>
            <div>
              <h4>Window &amp; notifications</h4>
              <p>Keep uploads moving when Nimbus is out of the way.</p>
            </div>
          </div>
          <span className="desktop-setting-badge">
            <Power size={14} /> Native
          </span>
        </div>

        <div className="desktop-preference-list">
          <Toggle
            checked={preferences.closeToTray}
            onChange={(checked) => setPreferences((current) => ({ ...current, closeToTray: checked }))}
            label="Keep running in the notification area"
            description="The close button hides the window instead of stopping the server. Right-click the tray icon to quit."
            disabled={preferencesBusy}
          />
          <Toggle
            checked={preferences.launchAtLogin}
            onChange={(checked) => setPreferences((current) => ({ ...current, launchAtLogin: checked }))}
            label="Start with Windows"
            description="Nimbus opens quietly in the tray when you sign in, ready to finish uploads."
            disabled={preferencesBusy}
          />
          <Toggle
            checked={preferences.notifications}
            onChange={(checked) => setPreferences((current) => ({ ...current, notifications: checked }))}
            label="Notify me when uploads finish"
            description="Shows a Windows notification when the window is hidden or in the background."
            disabled={preferencesBusy}
          />
        </div>

        <div className="desktop-preference-actions">
          <span className="desktop-setting-note">
            <ShieldCheck size={14} /> Preferences stay on this PC. No file names leave your machine.
          </span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void savePreferences()}
            disabled={!preferencesDirty || preferencesBusy}
          >
            {preferencesBusy ? <Spinner size={16} /> : <Save size={16} />}
            {preferencesBusy ? 'Saving…' : 'Save preferences'}
          </button>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card-head">
          <div className="desktop-setting-title">
            <span className="desktop-setting-icon">
              <Gamepad2 size={18} />
            </span>
            <div>
              <h4>Discord Rich Presence</h4>
              <p>Show a small “Browsing Nimbus” card on your Discord profile.</p>
            </div>
          </div>
          <span className={`desktop-rpc-status ${statusTone(status.state)}`} role="status">
            {status.state === 'connecting' ? (
              <Spinner size={12} />
            ) : status.state === 'connected' ? (
              <CheckCircle2 size={13} />
            ) : status.state === 'off' ? (
              <Radio size={13} />
            ) : (
              <AlertCircle size={13} />
            )}
            <span>{status.state === 'connected' ? 'Connected' : status.state === 'off' ? 'Off' : status.state === 'connecting' ? 'Connecting' : 'Attention'}</span>
          </span>
        </div>

        <p className="desktop-setting-copy">{status.message}</p>

        {loading ? (
          <div className="desktop-rpc-loading">
            <Spinner size={16} /> Loading Discord settings…
          </div>
        ) : (
          <div className="desktop-rpc-form">
            <Toggle
              checked={config.enabled}
              onChange={(checked) => setConfig((current) => ({ ...current, enabled: checked }))}
              label="Enable Discord Rich Presence"
              description="Requires the Discord desktop app to be running on this PC."
              disabled={saving}
            />

            <Field
              label="Discord Application ID"
              htmlFor="discord-application-id"
              hint={
                <>
                  Nimbus includes a public Application ID, so this works out of the box. You can also create
                  your own in the{' '}
                  <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">
                    Discord Developer Portal <ExternalLink size={11} />
                  </a>
                  . Nimbus never asks for a bot token or your Discord password.
                </>
              }
            >
              <input
                id="discord-application-id"
                className="input desktop-rpc-id"
                value={config.applicationId}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    applicationId: event.target.value.replace(/[^\d]/g, '').slice(0, 22),
                  }))
                }
                placeholder="123456789012345678"
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                disabled={!config.enabled || saving}
              />
            </Field>

            <Toggle
              checked={config.showActivity}
              onChange={(checked) => setConfig((current) => ({ ...current, showActivity: checked }))}
              label="Show the file name I am viewing"
              description="Off by default. When off, Discord only shows “Private library”."
              disabled={!config.enabled || saving}
            />

            {error ? (
              <div className="form-error-banner" role="alert">
                <AlertCircle size={16} /> {error}
              </div>
            ) : null}

            <div className="desktop-rpc-actions">
              <span className="desktop-rpc-privacy">
                <ShieldCheck size={14} /> Nothing about your files is shared unless you enable it above.
              </span>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void save()}
                disabled={!dirty || saving}
              >
                {saving ? <Spinner size={16} /> : null}
                {saving ? 'Saving…' : 'Save Discord settings'}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-card-head">
          <div className="desktop-setting-title">
            <span className="desktop-setting-icon">
              <Wrench size={18} />
            </span>
            <div>
              <h4>Uninstall Nimbus</h4>
              <p>Use the standard Windows uninstaller when you want to remove the desktop app.</p>
            </div>
          </div>
        </div>
        <p className="desktop-setting-copy">
          Nimbus asks whether to keep your local library and whether to delete GitHub storage data. Keeping
          local data lets a future install open the same library again.
        </p>
        <div className="desktop-maintenance">
          <p>
            Your browser library is unaffected while Nimbus is installed. This only starts the Windows
            uninstaller for the desktop app.
          </p>
          <button
            type="button"
            className="btn btn-danger-ghost"
            onClick={() => setUninstallOpen(true)}
            disabled={toolBusy !== null || (info ? !info.canUninstall : false)}
          >
            {toolBusy === 'uninstall' ? <Spinner size={16} /> : <Trash2 size={16} />}
            Open uninstaller…
          </button>
        </div>
        {info && !info.canUninstall ? (
          <p className="desktop-setting-copy">
            The uninstaller appears after Nimbus has been installed with the Windows setup file.
          </p>
        ) : null}
      </div>

      <ConfirmDialog
        open={uninstallOpen}
        title="Open the Nimbus uninstaller?"
        description="Nimbus will close and the Windows uninstaller will start. It lets you keep or delete the local library and GitHub storage data."
        confirmLabel="Open uninstaller"
        tone="danger"
        busy={toolBusy === 'uninstall'}
        onConfirm={() => void openUninstaller()}
        onCancel={() => setUninstallOpen(false)}
      />
    </div>
  );
}
