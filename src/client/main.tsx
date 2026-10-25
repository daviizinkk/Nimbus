import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { DesktopTitlebar } from './components/DesktopTitlebar';
import { isDesktop } from './desktop';
import './styles.css';
import './styles-gallery.css';
import './styles-overlays.css';
import './styles-activity.css';
import './styles-viewer.css';
import './styles-settings.css';
import './styles-auth.css';
import './styles-responsive.css';
import './styles-desktop.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Nimbus could not find its root element.');
}

if (isDesktop) {
  document.documentElement.classList.add('nimbus-desktop');
}

createRoot(container).render(
  <StrictMode>
    {isDesktop ? <DesktopTitlebar /> : null}
    <App />
  </StrictMode>,
);
