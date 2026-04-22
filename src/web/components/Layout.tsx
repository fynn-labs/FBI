import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { ThemeToggle } from './ThemeToggle.js';

const VERSION = import.meta.env.VITE_VERSION as string | undefined;

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col bg-white dark:bg-gray-800 dark:text-gray-100">
      <nav aria-label="Main" className="bg-white border-b dark:bg-gray-900 dark:border-gray-700 px-6 py-3 flex gap-6 items-center">
        <Link to="/" className="font-bold text-lg">FBI</Link>
        <Link to="/runs" className="text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100">Runs</Link>
        <Link to="/settings" className="text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100">Settings</Link>
        <div className="ml-auto">
          <ThemeToggle />
        </div>
      </nav>
      <main className="flex-1 p-6">{children}</main>
      {VERSION && (
        <footer className="text-center text-xs text-gray-400 dark:text-gray-500 py-2">{VERSION}</footer>
      )}
    </div>
  );
}
