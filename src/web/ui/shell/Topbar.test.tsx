import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Topbar } from './Topbar.js';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    close: vi.fn(),
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
  }),
}));

describe('Topbar (Tauri mode)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders traffic light buttons', () => {
    render(<Topbar breadcrumb="/runs/1" onOpenPalette={() => {}} />);
    expect(screen.getByRole('button', { name: 'Close window' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Minimize window' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Maximize window' })).toBeInTheDocument();
  });

  it('renders the FBI logo and breadcrumb', () => {
    render(<Topbar breadcrumb="/runs/42" onOpenPalette={() => {}} />);
    expect(screen.getByText('▮ FBI')).toBeInTheDocument();
    expect(screen.getByText('/runs/42')).toBeInTheDocument();
  });
});
