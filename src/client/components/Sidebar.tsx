import type { ProviderId, StorageStats } from '../../../shared/types';
import type { Section, ThemeMode } from '../hooks';
import {
  CheckSquare,
  Heart,
  Image,
  Images,
  Film,
  Files,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  Trash2,
  UploadCloud,
  X,
} from 'lucide-react';
import { Logo } from './ui';
import { formatBytes, providerLabel } from '../format';

interface SidebarProps {
  section: Section;
  vaultName: string;
  stats: StorageStats | null;
  activeProvider: ProviderId;
  theme: ThemeMode;
  resolved: 'light' | 'dark';
  onThemeChange: (theme: ThemeMode) => void;
  onNavigate: (section: Section) => void;
  onUpload: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

const NAV: Array<{
  id: Section;
  label: string;
  icon: typeof Images;
  count?: (stats: StorageStats) => number;
}> = [
  { id: 'all', label: 'All files', icon: Images, count: (stats) => stats.itemCount },
  { id: 'photos', label: 'Photos', icon: Image, count: (stats) => stats.photoCount },
  { id: 'videos', label: 'Videos', icon: Film, count: (stats) => stats.videoCount },
  { id: 'files', label: 'Files', icon: Files, count: (stats) => stats.fileCount },
  { id: 'favorites', label: 'Favorites', icon: Heart, count: (stats) => stats.favorites },
  { id: 'trash', label: 'Trash', icon: Trash2, count: (stats) => stats.trashCount },
];

function nextTheme(theme: ThemeMode): ThemeMode {
  return theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
}

export function Sidebar({
  section,
  vaultName,
  stats,
  activeProvider,
  theme,
  resolved,
  onThemeChange,
  onNavigate,
  onUpload,
  onOpenSettings,
  onLogout,
  mobileOpen,
  onCloseMobile,
}: SidebarProps) {
  const navigate = (next: Section) => {
    onNavigate(next);
    onCloseMobile();
  };

  const ThemeIcon = theme === 'system' ? Monitor : resolved === 'dark' ? Moon : Sun;
  const themeLabel =
    theme === 'system' ? `Theme: system (${resolved})` : `Theme: ${theme}`;

  return (
    <>
      <button
        type="button"
        className={`sidebar-scrim${mobileOpen ? ' is-open' : ''}`}
        onClick={onCloseMobile}
        aria-label="Close navigation"
        tabIndex={mobileOpen ? 0 : -1}
      />
      <aside className={`sidebar${mobileOpen ? ' is-open' : ''}`} aria-label="Library navigation">
        <div className="sidebar-brand">
          <Logo />
          <button type="button" className="sidebar-close" onClick={onCloseMobile} aria-label="Close navigation">
            <X size={19} />
          </button>
        </div>

        <div className="sidebar-vault" title={vaultName}>
          <span className="vault-dot" aria-hidden="true" />
          <span>{vaultName}</span>
        </div>

        <button type="button" className="upload-cta" onClick={onUpload}>
          <span className="upload-cta-icon">
            <UploadCloud size={20} />
          </span>
          <span className="upload-cta-text">
            <strong>Upload</strong>
            <small>Files, photos &amp; videos</small>
          </span>
          <span className="upload-cta-plus">
            <Plus size={16} />
          </span>
        </button>

        <nav className="sidebar-nav" aria-label="Sections">
          {NAV.map((entry) => {
            const Icon = entry.icon;
            const count = stats ? entry.count?.(stats) ?? 0 : 0;
            const active = section === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                className={`nav-item${active ? ' is-active' : ''}`}
                onClick={() => navigate(entry.id)}
                aria-current={active ? 'page' : undefined}
              >
                <Icon size={19} strokeWidth={active ? 2.2 : 1.9} />
                <span className="nav-label">{entry.label}</span>
                {count > 0 ? <span className="nav-count">{count > 9999 ? '9k+' : count.toLocaleString()}</span> : null}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-spacer" />

        <button type="button" className="storage-card" onClick={onOpenSettings}>
          <span className="storage-card-top">
            <span className="storage-card-eyebrow">Storage</span>
            <span className="storage-card-provider">{providerLabel(activeProvider)}</span>
          </span>
          <span className="storage-card-value">{formatBytes(stats?.usedBytes ?? 0)}</span>
          <span className="storage-card-meta">
            {stats ? `${stats.itemCount.toLocaleString()} ${stats.itemCount === 1 ? 'item' : 'items'}` : 'Your library'}
            <span className="storage-card-link">Manage</span>
          </span>
        </button>

        <div className="sidebar-footer">
          <button type="button" className="sidebar-tool" onClick={() => onThemeChange(nextTheme(theme))} title={themeLabel} aria-label={themeLabel}>
            <ThemeIcon size={18} />
          </button>
          <button type="button" className="sidebar-tool" onClick={onOpenSettings} title="Settings" aria-label="Settings">
            <Settings size={18} />
          </button>
          <span className="sidebar-footer-spacer" />
          <button type="button" className="sidebar-tool" onClick={onLogout} title="Sign out" aria-label="Sign out">
            <LogOut size={18} />
          </button>
        </div>
      </aside>
    </>
  );
}

interface TopbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  onMenu: () => void;
  onOpenSettings: () => void;
  onUpload: () => void;
  selectionMode: boolean;
  onToggleSelection: () => void;
  showSelect: boolean;
}

export function Topbar({
  search,
  onSearchChange,
  onMenu,
  onOpenSettings,
  onUpload,
  selectionMode,
  onToggleSelection,
  showSelect,
}: TopbarProps) {
  return (
    <header className="topbar">
      <button type="button" className="icon-btn icon-btn-md topbar-menu" onClick={onMenu} aria-label="Open navigation">
        <Menu size={21} />
      </button>

      <div className="topbar-search">
        <Search size={18} className="topbar-search-icon" aria-hidden="true" />
        <input
          id="nimbus-search"
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search your library"
          aria-label="Search your library"
          autoComplete="off"
          spellCheck={false}
        />
        {search ? (
          <button type="button" className="topbar-search-clear" onClick={() => onSearchChange('')} aria-label="Clear search">
            <X size={15} />
          </button>
        ) : (
          <kbd className="topbar-kbd" aria-hidden="true">
            Ctrl K
          </kbd>
        )}
      </div>

      <div className="topbar-actions">
        {showSelect ? (
          <button
            type="button"
            className={`btn btn-ghost btn-sm topbar-select${selectionMode ? ' is-active' : ''}`}
            onClick={onToggleSelection}
          >
            <CheckSquare size={17} />
            <span>{selectionMode ? 'Done' : 'Select'}</span>
          </button>
        ) : null}
        <button type="button" className="icon-btn icon-btn-md topbar-upload" onClick={onUpload} aria-label="Upload files">
          <Plus size={20} />
        </button>
        <button type="button" className="icon-btn icon-btn-md" onClick={onOpenSettings} aria-label="Settings">
          <Settings size={19} />
        </button>
      </div>
    </header>
  );
}
