'use strict';

const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  session,
  shell,
  Tray,
} = require('electron');
const { spawn } = require('node:child_process');
const {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { DiscordPresence } = require('./discord.cjs');
const { resetPassword } = require('./password-reset.cjs');

const APP_ID = 'com.nimbus.vault';
const DEFAULT_PREFERENCES = {
  /** Closing the window keeps Nimbus (and uploads) alive in the notification area. */
  closeToTray: true,
  /** Start Nimbus with Windows, minimised to the tray. */
  launchAtLogin: false,
  /** Native notifications when uploads finish while the window is hidden. */
  notifications: true,
  /** One-time hint shown the first time the window is sent to the tray. */
  trayHintShown: false,
};

let mainWindow = null;
let serverProcess = null;
let serverLog = null;
let serverUrl = null;
let quitting = false;
let presence = null;
let tray = null;
let preferences = { ...DEFAULT_PREFERENCES };

/**
 * Logging must never be able to crash the app or recurse. When the desktop app
 * is launched from a terminal that then closes, stdout becomes a broken pipe;
 * writing to it throws EPIPE, and an uncaught-exception handler that logs would
 * loop forever. Only write to a live console and swallow every write error.
 */
function log(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  if (process.stdout.isTTY) {
    try {
      process.stdout.write(line);
    } catch {
      // The console went away; the file log below still gets the message.
    }
  }
  try {
    serverLog?.write(line);
  } catch {
    // Disk full or stream closed. Logging is best-effort by design.
  }
}

function userDataDirectory() {
  const override = process.env.NIMBUS_DATA_DIR;
  if (override) return path.resolve(override);
  return path.join(app.getPath('userData'), 'library');
}

function logsDirectory() {
  return path.join(app.getPath('userData'), 'logs');
}

function preferencesFile() {
  return path.join(app.getPath('userData'), 'desktop-preferences.json');
}

function sanitisePreferences(input) {
  const next = { ...DEFAULT_PREFERENCES };
  if (input && typeof input === 'object') {
    if (typeof input.closeToTray === 'boolean') next.closeToTray = input.closeToTray;
    if (typeof input.launchAtLogin === 'boolean') next.launchAtLogin = input.launchAtLogin;
    if (typeof input.notifications === 'boolean') next.notifications = input.notifications;
    if (typeof input.trayHintShown === 'boolean') next.trayHintShown = input.trayHintShown;
  }
  return next;
}

function loadPreferences() {
  try {
    preferences = sanitisePreferences(JSON.parse(readFileSync(preferencesFile(), 'utf8')));
  } catch {
    // A missing or damaged file simply means first-run defaults.
    preferences = { ...DEFAULT_PREFERENCES };
  }
  return preferences;
}

function savePreferences(patch) {
  preferences = sanitisePreferences({ ...preferences, ...patch });
  try {
    mkdirSync(app.getPath('userData'), { recursive: true });
    const target = preferencesFile();
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8');
    renameSync(temporary, target);
  } catch (error) {
    log(`could not save desktop preferences: ${error.message}`);
  }
  return preferences;
}

function publicPreferences() {
  return {
    closeToTray: preferences.closeToTray,
    launchAtLogin: preferences.launchAtLogin,
    notifications: preferences.notifications,
  };
}

function applyLoginItemSetting() {
  try {
    const args = app.isPackaged ? ['--tray'] : [app.getAppPath(), '--tray'];
    app.setLoginItemSettings({
      openAtLogin: preferences.launchAtLogin,
      openAsHidden: preferences.launchAtLogin,
      path: process.execPath,
      args: preferences.launchAtLogin ? args : [],
    });
  } catch (error) {
    log(`could not update the Windows startup entry: ${error.message}`);
  }
}

function appIconPath() {
  const icon = path.join(app.getAppPath(), 'build', 'icon.png');
  return existsSync(icon) ? icon : undefined;
}

function notificationIconPath() {
  const icon = path.join(app.getAppPath(), 'build', 'icon-256.png');
  return existsSync(icon) ? icon : appIconPath();
}

function trayIconPath() {
  const icon = path.join(app.getAppPath(), 'build', 'tray.png');
  return existsSync(icon) ? icon : notificationIconPath();
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (serverUrl) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function sendCommand(command) {
  showWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:command', command);
  }
}

function showNotification(title, body) {
  if (!Notification.isSupported()) return false;
  try {
    const icon = notificationIconPath();
    const notification = new Notification({
      title,
      body,
      ...(icon ? { icon } : {}),
      silent: false,
      timeoutType: 'default',
    });
    notification.on('click', () => showWindow());
    notification.show();
    return true;
  } catch (error) {
    log(`could not show a notification: ${error.message}`);
    return false;
  }
}

function windowIsInBackground() {
  if (!mainWindow || mainWindow.isDestroyed()) return true;
  return !mainWindow.isVisible() || mainWindow.isMinimized() || !mainWindow.isFocused();
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Open Nimbus', click: () => showWindow() },
    { label: 'Upload files…', click: () => sendCommand('upload') },
    { label: 'Settings…', click: () => sendCommand('settings') },
    { type: 'separator' },
    {
      label: 'Keep running when the window closes',
      type: 'checkbox',
      checked: preferences.closeToTray,
      click: (item) => {
        savePreferences({ closeToTray: item.checked });
        buildTray();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('desktop:preferences', publicPreferences());
        }
      },
    },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: preferences.launchAtLogin,
      click: (item) => {
        savePreferences({ launchAtLogin: item.checked });
        applyLoginItemSetting();
        buildTray();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('desktop:preferences', publicPreferences());
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Nimbus',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
}

function buildTray() {
  if (!app.isReady()) return;
  const icon = trayIconPath();
  if (!tray && !icon) return;
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(icon).resize({ width: 16, height: 16 }));
    tray.setToolTip('Nimbus — your private library');
    tray.on('click', () => {
      if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized()) {
        mainWindow.focus();
      } else {
        showWindow();
      }
    });
    tray.on('double-click', () => showWindow());
  }
  tray.setContextMenu(buildTrayMenu());
}

function hideToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  if (!preferences.trayHintShown) {
    savePreferences({ trayHintShown: true });
    showNotification(
      'Nimbus is still running',
      'Uploads keep going in the background. Open the tray menu to reopen or quit Nimbus.',
    );
  }
}

function uninstallerFile() {
  return path.join(path.dirname(process.execPath), 'Uninstall Nimbus.exe');
}

async function openDirectory(directory) {
  if (!existsSync(directory)) {
    return { ok: false, error: `The folder does not exist yet: ${directory}` };
  }
  const error = await shell.openPath(directory);
  return error ? { ok: false, error } : { ok: true };
}

function createDesktopShortcut() {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Desktop shortcuts are only supported on Windows.' };
  }
  try {
    const link = path.join(app.getPath('desktop'), 'Nimbus.lnk');
    const options = {
      target: process.execPath,
      cwd: app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(),
      args: app.isPackaged ? '' : `"${app.getAppPath()}"`,
      description: 'Nimbus — private photo, video and file library',
      icon: process.execPath,
      iconIndex: 0,
      appUserModelId: APP_ID,
    };
    // 'create' writes a new shortcut and overwrites an existing one. 'replace'
    // fails when no shortcut exists yet, which is exactly the case for users
    // who skipped the installer's desktop-shortcut option.
    const created = shell.writeShortcutLink(link, 'create', options);
    return created
      ? { ok: true, path: link }
      : { ok: false, error: 'Windows did not create the shortcut. Check that your desktop folder is writable.' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function diagnosticsText() {
  const rpc = presence?.getStatus();
  return [
    'Nimbus desktop diagnostics',
    '',
    `Version: ${app.getVersion()}`,
    `Electron: ${process.versions.electron}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Packaged: ${app.isPackaged ? 'yes' : 'no'}`,
    `Data directory: ${userDataDirectory()}`,
    `Log file: ${path.join(logsDirectory(), 'server.log')}`,
    `Discord: ${rpc ? `${rpc.state} — ${rpc.message}` : 'not initialized'}`,
  ].join('\n');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('Could not reserve a local port.'))));
    });
  });
}

function pingHealth(baseUrl) {
  return new Promise((resolve) => {
    const request = http.get(`${baseUrl}/api/health`, { timeout: 1200 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

async function waitForServer(baseUrl, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingHealth(baseUrl)) return;
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(`The Nimbus server stopped with code ${serverProcess.exitCode}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The Nimbus server did not become ready in time.');
}

function serverEnvironment(dataDir, port) {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    DATA_DIR: dataDir,
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    NIMBUS_DESKTOP: '1',
  };
}

async function startServerOnce(dataDir) {
  const port = process.env.NIMBUS_PORT ? Number(process.env.NIMBUS_PORT) : await freePort();
  if (!Number.isInteger(port) || port <= 0) throw new Error('NIMBUS_PORT must be a valid port number.');
  const entry = path.join(app.getAppPath(), 'dist', 'server', 'index.js');
  if (!existsSync(entry)) {
    throw new Error('The Nimbus server build is missing. Run "npm run build" before starting the desktop app.');
  }

  log(`starting server on port ${port} (data: ${dataDir})`);
  serverProcess = spawn(process.execPath, [entry], {
    cwd: app.getAppPath(),
    env: serverEnvironment(dataDir, port),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serverProcess.stdout?.pipe(serverLog, { end: false });
  serverProcess.stderr?.pipe(serverLog, { end: false });
  const child = serverProcess;
  child.on('exit', (code) => {
    if (quitting || serverProcess !== child) return;
    serverProcess = null;
    if (mainWindow) {
      dialog.showErrorBox(
        'Nimbus server stopped',
        `The local server stopped unexpectedly (code ${code ?? 'unknown'}).\n\nLog: ${path.join(app.getPath('userData'), 'logs', 'server.log')}`,
      );
      app.quit();
    }
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl);
  } catch (error) {
    child.kill();
    serverProcess = null;
    throw error;
  }
  return baseUrl;
}

async function startServer(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await startServerOnce(dataDir);
    } catch (error) {
      lastError = error;
      log(`server start attempt ${attempt + 1} failed: ${error.message}`);
    }
  }
  throw lastError;
}

function sendMaximised() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:maximized', mainWindow.isMaximized());
  }
}

function createWindow() {
  const icon = path.join(app.getAppPath(), 'build', 'icon.png');
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 620,
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    // Match the OS theme until the renderer paints, so a dark desktop does not
    // flash a white rectangle while the library boots.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#f7f8fb',
    ...(existsSync(icon) ? { icon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!process.argv.includes('--tray')) mainWindow?.show();
  });
  mainWindow.on('maximize', sendMaximised);
  mainWindow.on('unmaximize', sendMaximised);
  mainWindow.on('close', (event) => {
    if (quitting || !preferences.closeToTray) return;
    event.preventDefault();
    hideToTray();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (serverUrl && url.startsWith(serverUrl)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });

  mainWindow.loadURL(serverUrl).catch((error) => {
    log(`could not load the window: ${error.message}`);
    dialog.showErrorBox('Nimbus could not open', error.message);
    app.quit();
  });

  mainWindow.webContents.once('did-finish-load', () => {
    log('desktop window loaded');
    const screenshot = process.env.NIMBUS_DESKTOP_SCREENSHOT;
    if (screenshot) {
      setTimeout(async () => {
        try {
          const image = await mainWindow?.webContents.capturePage();
          if (image) writeFileSync(path.resolve(screenshot), image.toPNG());
          log(`wrote desktop screenshot to ${path.resolve(screenshot)}`);
        } catch (error) {
          log(`screenshot failed: ${error.message}`);
        } finally {
          if (process.env.NIMBUS_DESKTOP_EXIT_AFTER_SHOT === '1') app.quit();
        }
      }, 2500);
    }
  });

  if (process.argv.includes('--devtools') || process.env.NIMBUS_DESKTOP_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function registerIpc() {
  ipcMain.on('desktop:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });
  ipcMain.on('desktop:toggle-maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.on('desktop:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });
  ipcMain.on('desktop:hide-to-tray', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window) window.hide();
  });
  ipcMain.handle('desktop:preferences:get', () => publicPreferences());
  ipcMain.handle('desktop:preferences:save', (event, input) => {
    if (!input || typeof input !== 'object') {
      return { ok: false, error: 'Desktop preferences must be an object.' };
    }
    const patch = {};
    for (const key of ['closeToTray', 'launchAtLogin', 'notifications']) {
      if (typeof input[key] !== 'boolean') {
        return { ok: false, error: `Invalid desktop preference: ${key}.` };
      }
      patch[key] = input[key];
    }
    savePreferences(patch);
    applyLoginItemSetting();
    buildTray();
    if (event.sender && !event.sender.isDestroyed()) {
      event.sender.send('desktop:preferences', publicPreferences());
    }
    return { ok: true, preferences: publicPreferences() };
  });
  ipcMain.handle('desktop:notify-upload', (_event, payload) => {
    if (!preferences.notifications) return { shown: false, reason: 'disabled' };
    if (!Notification.isSupported()) return { shown: false, reason: 'unsupported' };
    if (!windowIsInBackground()) return { shown: false, reason: 'focused' };
    const rawCount = Number(payload?.count);
    const count = Number.isFinite(rawCount) ? Math.min(Math.max(Math.round(rawCount), 1), 10_000) : 1;
    const rawFailed = Number(payload?.failed);
    const failed = Number.isFinite(rawFailed) ? Math.min(Math.max(Math.round(rawFailed), 0), count) : 0;
    const names = Array.isArray(payload?.names)
      ? payload.names
          .filter((name) => typeof name === 'string' && name.trim())
          .map((name) => name.trim().replace(/[\r\n]+/g, ' ').slice(0, 90))
          .slice(0, 3)
      : [];
    const succeeded = Math.max(0, count - failed);
    const title =
      failed > 0
        ? failed === count
          ? 'Upload failed'
          : 'Uploads finished with errors'
        : succeeded === 1
          ? 'Upload complete'
          : `${succeeded} uploads complete`;
    const body = (() => {
      if (succeeded === 1 && failed === 0) {
        return names[0] ? `“${names[0]}” is ready in your library.` : 'Your file is ready in the library.';
      }
      if (failed > 0 && succeeded === 0) {
        return `${failed} ${failed === 1 ? 'upload needs' : 'uploads need'} attention. Open Nimbus to retry.`;
      }
      if (failed > 0) {
        return `${succeeded} saved to your library · ${failed} failed. Open Nimbus for details.`;
      }
      return names.length > 0
        ? `${succeeded} files saved, including ${names.slice(0, 2).map((name) => `“${name}”`).join(' and ')}.`
        : `${succeeded} files saved to your library.`;
    })();
    return { shown: showNotification(title, body) };
  });
  ipcMain.handle('desktop:is-maximized', (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });
  ipcMain.handle('desktop:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    packaged: app.isPackaged,
    dataDir: userDataDirectory(),
    logsDir: logsDirectory(),
    canUninstall: app.isPackaged && existsSync(uninstallerFile()),
  }));

  ipcMain.handle('desktop:reset-password', async (_event, password) => {
    if (typeof password !== 'string') {
      return { ok: false, error: 'Enter a new password.' };
    }
    return resetPassword(userDataDirectory(), password);
  });

  ipcMain.handle('desktop:open-data-folder', () => openDirectory(userDataDirectory()));
  ipcMain.handle('desktop:open-logs-folder', () => openDirectory(logsDirectory()));
  ipcMain.handle('desktop:create-shortcut', () => createDesktopShortcut());
  ipcMain.handle('desktop:copy-diagnostics', () => {
    try {
      clipboard.writeText(diagnosticsText());
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('desktop:open-uninstaller', async () => {
    if (!app.isPackaged) {
      return { ok: false, error: 'The uninstaller is available after installing Nimbus with the Windows installer.' };
    }
    const uninstaller = uninstallerFile();
    if (!existsSync(uninstaller)) {
      return {
        ok: false,
        error: 'The uninstaller was not found. Open Windows Settings → Apps → Installed apps and uninstall Nimbus there.',
      };
    }
    const error = await shell.openPath(uninstaller);
    if (error) return { ok: false, error };
    // Let the uninstaller take over. It waits for Nimbus to close before
    // touching any files.
    setTimeout(() => app.quit(), 1_200);
    return { ok: true };
  });

  ipcMain.handle('desktop:rpc:get', () => ({
    config: presence?.getConfig() ?? {
      enabled: true,
      applicationId: '1563561943468351569',
      showActivity: false,
    },
    status: presence?.getStatus() ?? { state: 'off', message: 'Rich Presence is off.', user: null },
  }));
  ipcMain.handle('desktop:rpc:save', async (_event, input) => {
    if (!presence) return { ok: false, error: 'Discord support is not ready yet.' };
    try {
      const result = await presence.save(input);
      return { ok: true, ...result };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.on('desktop:rpc:activity', (_event, activity) => {
    presence?.setActivity(activity);
  });
}

function installSecurityPolicies() {
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

async function boot() {
  Menu.setApplicationMenu(null);
  app.setAppUserModelId(APP_ID);
  installSecurityPolicies();
  loadPreferences();
  applyLoginItemSetting();
  registerIpc();
  buildTray();

  const logDir = path.join(app.getPath('userData'), 'logs');
  mkdirSync(logDir, { recursive: true });
  const logStream = createWriteStream(path.join(logDir, 'server.log'), { flags: 'a' });
  logStream.on('error', () => {
    if (serverLog === logStream) serverLog = null;
  });
  serverLog = logStream;

  const dataDir = userDataDirectory();
  serverUrl = await startServer(dataDir);

  presence = new DiscordPresence({
    configPath: path.join(app.getPath('userData'), 'discord.json'),
    onStatus: (status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('desktop:rpc:status', status);
      }
    },
  });
  // Loading discord.json is a tiny file read; awaiting it closes the race where
  // Settings could open with the defaults before the saved config arrives.
  await presence.init();

  createWindow();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showWindow();
  });

  app.whenReady().then(boot).catch((error) => {
    log(`startup failed: ${error?.stack || error}`);
    dialog.showErrorBox(
      'Nimbus could not start',
      `${error instanceof Error ? error.message : String(error)}\n\nLog: ${path.join(app.getPath('userData'), 'logs', 'server.log')}`,
    );
    app.quit();
  });

  app.on('activate', () => showWindow());

  app.on('window-all-closed', () => {
    // With close-to-tray enabled the window is hidden rather than destroyed, so
    // this only runs if the renderer crashed or the user disabled the tray.
    if (!preferences.closeToTray) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    try {
      tray?.destroy();
    } catch {
      // Ignore.
    }
    tray = null;
    const logStream = serverLog;
    serverLog = null;
    try {
      logStream?.end();
    } catch {
      // Ignore.
    }
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill();
      serverProcess = null;
    }
    if (presence) {
      void presence.shutdown();
      presence = null;
    }
  });
}

process.on('uncaughtException', (error) => log(`uncaught exception: ${error.stack || error}`));
process.on('unhandledRejection', (error) => log(`unhandled rejection: ${error?.stack || error}`));
