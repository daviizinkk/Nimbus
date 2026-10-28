import { ArrowLeftRight, Command, Keyboard, Maximize2, Monitor, MousePointer2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { isDesktop } from '../desktop';
import { Modal } from './ui';

interface ShortcutItem {
  /** Each entry is rendered as its own key cap. */
  keys: string[];
  label: string;
}

interface ShortcutGroup {
  title: string;
  icon: ReactNode;
  items: ShortcutItem[];
}

const LIBRARY: ShortcutGroup = {
  title: 'Library',
  icon: <Command size={15} />,
  items: [
    { keys: ['Ctrl', 'K'], label: 'Focus search' },
    { keys: ['/'], label: 'Focus search without leaving the grid' },
    { keys: ['Ctrl', 'U'], label: 'Upload files' },
    { keys: ['Ctrl', 'A'], label: 'Select everything in this view' },
    { keys: ['Delete'], label: 'Move selected items to trash' },
    { keys: ['F'], label: 'Favorite the focused or selected item' },
    { keys: ['Esc'], label: 'Clear search or leave selection mode' },
  ],
};

const NAVIGATION: ShortcutGroup = {
  title: 'Go anywhere',
  icon: <MousePointer2 size={15} />,
  items: [
    { keys: ['G', 'A'], label: 'All files' },
    { keys: ['G', 'P'], label: 'Photos' },
    { keys: ['G', 'V'], label: 'Videos' },
    { keys: ['G', 'D'], label: 'Documents and files' },
    { keys: ['G', 'F'], label: 'Favorites' },
    { keys: ['G', 'T'], label: 'Trash' },
    { keys: ['Ctrl', ','], label: 'Settings' },
    { keys: ['?'], label: 'Show this shortcut sheet' },
  ],
};

const GRID: ShortcutGroup = {
  title: 'Grid',
  icon: <ArrowLeftRight size={15} />,
  items: [
    { keys: ['←', '→', '↑', '↓'], label: 'Move between tiles' },
    { keys: ['Home'], label: 'Jump to the first tile' },
    { keys: ['End'], label: 'Jump to the last loaded tile' },
    { keys: ['Enter'], label: 'Open the focused tile' },
    { keys: ['Space'], label: 'Select the focused tile' },
  ],
};

const VIEWER: ShortcutGroup = {
  title: 'Viewer',
  icon: <Maximize2 size={15} />,
  items: [
    { keys: ['←', '→'], label: 'Previous or next item' },
    { keys: ['F'], label: 'Favorite' },
    { keys: ['I'], label: 'Toggle details' },
    { keys: ['D'], label: 'Download original' },
    { keys: ['Delete'], label: 'Move to trash' },
    { keys: ['Esc'], label: 'Close viewer' },
  ],
};

const DESKTOP: ShortcutGroup = {
  title: 'Desktop',
  icon: <Monitor size={15} />,
  items: [
    { keys: ['Close'], label: 'Keeps Nimbus running in the notification area' },
    { keys: ['Tray'], label: 'Open, upload, change settings or quit' },
    { keys: ['Quit'], label: 'Stops the local server completely' },
  ],
};

const BASE_GROUPS = [LIBRARY, NAVIGATION, GRID, VIEWER];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  const groups = isDesktop ? [...BASE_GROUPS, DESKTOP] : BASE_GROUPS;
  return (
    <Modal
      title="Keyboard shortcuts"
      subtitle="Small things that make a library feel fast."
      onClose={onClose}
      size="lg"
      className="shortcuts-modal"
      footer={
        <span className="shortcuts-footnote">
          <Keyboard size={15} /> Press <kbd>?</kbd> anytime to reopen this sheet.
        </span>
      }
    >
      <div className="shortcuts-grid">
        {groups.map((group) => (
          <section className="shortcut-group" key={group.title} aria-label={group.title}>
            <h3>
              <span className="shortcut-group-icon">{group.icon}</span>
              {group.title}
            </h3>
            <dl>
              {group.items.map((item) => (
                <div className="shortcut-row" key={`${group.title}-${item.label}`}>
                  <dt>{item.label}</dt>
                  <dd>
                    {item.keys.map((key) => (
                      <kbd key={`${item.label}-${key}`}>{key}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
