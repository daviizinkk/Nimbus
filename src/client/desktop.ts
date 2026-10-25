import type {
  DesktopActionResult,
  DesktopActivity,
  DesktopDiscordConfig,
  DesktopDiscordStatus,
  DesktopInfo,
} from '../../shared/types';

export interface DesktopBridge {
  platform: string;
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  isMaximized: () => Promise<boolean>;
  getInfo: () => Promise<DesktopInfo>;
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
