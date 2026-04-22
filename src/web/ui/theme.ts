export type Theme = 'dark' | 'light';
const STORAGE_KEY = 'fbi-theme';

export function getStoredTheme(): Theme | null {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'dark' || v === 'light' ? v : null;
}

export function setStoredTheme(theme: Theme): void {
  localStorage.setItem(STORAGE_KEY, theme);
}

export function systemPrefersLight(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches;
}

export function resolveInitialTheme(): Theme {
  const stored = getStoredTheme();
  if (stored) return stored;
  return systemPrefersLight() ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle('light', theme === 'light');
}

export function toggleTheme(): Theme {
  const current: Theme = document.documentElement.classList.contains('light') ? 'light' : 'dark';
  const next: Theme = current === 'light' ? 'dark' : 'light';
  setStoredTheme(next);
  applyTheme(next);
  return next;
}

export function subscribeSystemTheme(handler: (theme: Theme) => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: light)');
  const listener = (e: MediaQueryListEvent) => handler(e.matches ? 'light' : 'dark');
  mq.addEventListener('change', listener);
  return () => mq.removeEventListener('change', listener);
}

// Inline script string — injected into index.html to prevent flash on load.
export const NO_FLASH_SCRIPT = `(function(){try{var s=localStorage.getItem('${STORAGE_KEY}');var m=window.matchMedia('(prefers-color-scheme: light)').matches;if(s==='light'||(!s&&m)){document.documentElement.classList.add('light');}}catch(e){}})();`;
