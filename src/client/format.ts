import type { ItemKind, ProviderId } from '../../shared/types';

// The interface copy is English, so dates use a fixed English locale instead of
// the browser locale. That keeps headings like "Sat, Oct 24" consistent with
// "Today" and the rest of the UI.
export const DATE_LOCALE = 'en-US';

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const precision = value >= 100 || index === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision).replace(/\.0+$/, '')} ${units[index]}`;
}

export function formatDate(timestamp: number | null | undefined): string {
  if (!timestamp) return '—';
  const date = new Date(timestamp);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startToday - startDate) / 86_400_000);
  if (dayDiff === 0) return 'Today';
  if (dayDiff === 1) return 'Yesterday';
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(DATE_LOCALE, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(DATE_LOCALE, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDateTime(timestamp: number | null | undefined): string {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString(DATE_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

export function kindLabel(kind: ItemKind): string {
  if (kind === 'photo') return 'Photo';
  if (kind === 'video') return 'Video';
  return 'File';
}

export function providerLabel(provider: ProviderId): string {
  if (provider === 'github') return 'GitHub';
  if (provider === 'webdav') return 'WebDAV';
  return 'This device';
}

export function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return '';
  return name.slice(index + 1).toUpperCase().slice(0, 5);
}

export function folderSafeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-');
}

export function isTextPreviewable(mime: string, name: string): boolean {
  if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/x-yaml' ||
    mime === 'application/javascript' ||
    mime === 'application/x-sh'
  ) {
    return true;
  }
  const extension = name.split('.').pop()?.toLowerCase();
  return Boolean(
    extension &&
      [
        'txt',
        'md',
        'markdown',
        'log',
        'csv',
        'tsv',
        'json',
        'xml',
        'yml',
        'yaml',
        'ini',
        'conf',
        'cfg',
        'toml',
        'js',
        'mjs',
        'cjs',
        'ts',
        'tsx',
        'jsx',
        'css',
        'scss',
        'html',
        'htm',
        'svg',
        'sh',
        'bash',
        'ps1',
        'py',
        'rb',
        'go',
        'rs',
        'java',
        'c',
        'h',
        'cpp',
        'sql',
        'env',
        'srt',
        'vtt',
      ].includes(extension),
  );
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : plural ?? `${singular}s`}`;
}

export function titleForSection(section: string): string {
  switch (section) {
    case 'photos':
      return 'Photos';
    case 'videos':
      return 'Videos';
    case 'files':
      return 'Files';
    case 'favorites':
      return 'Favorites';
    case 'recent':
      return 'Recently added';
    case 'trash':
      return 'Trash';
    default:
      return 'Your library';
  }
}
