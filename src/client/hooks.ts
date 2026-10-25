import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export type Section = 'all' | 'photos' | 'videos' | 'files' | 'favorites' | 'trash';
export type ThemeMode = 'light' | 'dark' | 'system';

const SECTIONS: Section[] = ['all', 'photos', 'videos', 'files', 'favorites', 'trash'];
const THEME_KEY = 'nimbus-theme';

export function isSection(value: string): value is Section {
  return (SECTIONS as string[]).includes(value);
}

export function readSectionFromHash(): Section {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0].toLowerCase();
  return isSection(raw) ? raw : 'all';
}

export function useHashSection(): [Section, (section: Section) => void] {
  const [section, setSection] = useState<Section>(() => readSectionFromHash());

  useEffect(() => {
    const onChange = () => setSection(readSectionFromHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const navigate = useCallback((next: Section) => {
    if (readSectionFromHash() === next) {
      setSection(next);
      return;
    }
    window.location.hash = `/${next}`;
    setSection(next);
  }, []);

  return [section, navigate];
}

function systemTheme(): 'light' | 'dark' {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(mode: ThemeMode): void {
  const resolved = mode === 'system' ? systemTheme() : mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0b0d12' : '#f7f8fb');
}

export function useTheme(): {
  theme: ThemeMode;
  resolved: 'light' | 'dark';
  setTheme: (mode: ThemeMode) => void;
} {
  const [theme, setThemeState] = useState<ThemeMode>(() => {
    const stored = localStorage.getItem(THEME_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system';
  });
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    theme === 'system' ? systemTheme() : theme,
  );

  useEffect(() => {
    applyTheme(theme);
    setResolved(theme === 'system' ? systemTheme() : theme);
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (theme === 'system') {
        applyTheme('system');
        setResolved(systemTheme());
      }
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((mode: ThemeMode) => {
    localStorage.setItem(THEME_KEY, mode);
    setThemeState(mode);
  }, []);

  return { theme, resolved, setTheme };
}

export function useDebouncedValue<T>(value: T, delay = 250): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useBodyLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const previousOverflow = document.body.style.overflow;
    const previousPadding = document.body.style.paddingRight;
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.paddingRight = previousPadding;
    };
  }, [active]);
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    media.addEventListener('change', onChange);
    setMatches(media.matches);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export function useClickOutside<T extends HTMLElement>(
  ref: RefObject<T | null>,
  handler: () => void,
  active = true,
): void {
  useEffect(() => {
    if (!active) return;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) {
        handler();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handler();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [ref, handler, active]);
}

export function useElementSize<T extends HTMLElement>(): [
  RefObject<T | null>,
  { width: number; height: number },
] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · Nimbus` : 'Nimbus';
  }, [title]);
}
