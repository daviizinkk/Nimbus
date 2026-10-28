import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import { desktop } from '../desktop';
import { Logo } from './ui';

/**
 * The desktop shell is frameless, so the window needs its own drag region and
 * controls. This only renders inside the Electron app; the web build never
 * sees it.
 */
export function DesktopTitlebar() {
  const [maximized, setMaximized] = useState(false);
  const [closeToTray, setCloseToTray] = useState(true);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void desktop.isMaximized().then((value) => {
      if (active) setMaximized(value);
    });
    void desktop.getPreferences().then((value) => {
      if (active) setCloseToTray(value.closeToTray);
    });
    const unsubscribe = desktop.onMaximized((value) => {
      if (active) setMaximized(value);
    });
    const unsubscribePreferences = desktop.onPreferences((value) => {
      if (active) setCloseToTray(value.closeToTray);
    });
    return () => {
      active = false;
      unsubscribe?.();
      unsubscribePreferences?.();
    };
  }, []);

  const bridge = desktop;
  if (!bridge) return null;

  return (
    <header
      className="desktop-titlebar"
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        bridge.toggleMaximize();
      }}
    >
      <div className="desktop-titlebar-brand">
        <Logo size={19} wordmark={false} />
        <span className="desktop-titlebar-name">Nimbus</span>
        <span className="desktop-titlebar-badge">Desktop</span>
      </div>
      <div className="desktop-titlebar-drag" aria-hidden="true" />
      <div className="desktop-window-controls">
        <button type="button" className="desktop-window-btn" aria-label="Minimize" title="Minimize" onClick={() => bridge.minimize()}>
          <Minus size={16} />
        </button>
        <button
          type="button"
          className="desktop-window-btn"
          aria-label={maximized ? 'Restore' : 'Maximize'}
          title={maximized ? 'Restore' : 'Maximize'}
          onClick={() => bridge.toggleMaximize()}
        >
          {maximized ? <Copy size={14} /> : <Square size={13} />}
        </button>
        <button
          type="button"
          className="desktop-window-btn is-close"
          aria-label={closeToTray ? 'Close to tray' : 'Close'}
          title={closeToTray ? 'Close to tray — Nimbus keeps running' : 'Close'}
          onClick={() => bridge.close()}
        >
          <X size={17} />
        </button>
      </div>
    </header>
  );
}
