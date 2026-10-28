import type {
  DesktopActionResult,
  DesktopActivity,
  DesktopCommand,
  DesktopDiscordConfig,
  DesktopDiscordStatus,
  DesktopInfo,
  DesktopNotificationResult,
  DesktopPreferences,
  DesktopPreferencesResult,
  DesktopUploadSummary,
} from '../../shared/types';

export interface DesktopBridge {
  platform: string;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  hideToTray: () => void;
  isMaximized: () => Promise<boolean>;
  getInfo: () => Promise<DesktopInfo>;
  getPreferences: () => Promise<DesktopPreferences>;
  savePreferences: (preferences: DesktopPreferences) => Promise<DesktopPreferencesResult>;
  notifyUpload: (summary: DesktopUploadSummary) => Promise<DesktopNotificationResult>;
  onPreferences: (callback: (preferences: DesktopPreferences) => void) => () => void;
  onCommand: (callback: (command: DesktopCommand) => void) => () => void;
  onMaximized: (callback: (maximized: boolean) => void) => () => void;
  resetPassword: (password: string) => Promise<DesktopActionResult>;
  openDataFolder: () => Promise<DesktopActionResult>;
  openLogsFolder: () => Promise<DesktopActionResult>;
  createShortcut: () => Promise<DesktopActionResult>;
  copyDiagnostics: () => Promise<DesktopActionResult>;
  openUninstaller: () => Promise<DesktopActionResult>;
  rpc: {
    get: () => Promise<{ config: DesktopDiscordConfig; status: DesktopDiscordStatus }>;
    save: (
      config: DesktopDiscordConfig,
    ) => Promise<
      | { ok: true; config: DesktopDiscordConfig; status: DesktopDiscordStatus }
      | { ok: false; error: string }
    >;
    setActivity: (activity: DesktopActivity) => void;
    onStatus: (callback: (status: DesktopDiscordStatus) => void) => () => void;
  };
}

declare global {
  interface Window {
    nimbusDesktop?: DesktopBridge;
  }
}

export const desktop = typeof window !== 'undefined' ? window.nimbusDesktop : undefined;
export const isDesktop = Boolean(desktop);
