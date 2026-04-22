import { useEffect, useState } from 'react';
import { applyTheme, resolveInitialTheme, toggleTheme, type Theme } from '@ui/theme.js';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(resolveInitialTheme);
  useEffect(() => { applyTheme(theme); }, [theme]);
  return (
    <button
      onClick={() => setTheme(toggleTheme())}
      aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
      className="text-text-faint hover:text-text text-lg leading-none"
    >
      {theme === 'light' ? '☾' : '☀'}
    </button>
  );
}
