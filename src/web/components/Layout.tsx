import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <nav aria-label="Main" className="bg-white border-b px-6 py-3 flex gap-6 items-center">
        <Link to="/" className="font-bold text-lg">FBI</Link>
        <Link to="/runs" className="text-gray-700 hover:text-gray-900">Runs</Link>
      </nav>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
