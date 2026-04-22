import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ThemeToggle } from './ThemeToggle.js';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('light');
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((q: string) => ({
      matches: q === '(prefers-color-scheme: light)' ? false : false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

describe('ThemeToggle', () => {
  it('renders with "Switch to light mode" label when no theme stored (dark default)', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: /switch to light mode/i })).toBeInTheDocument();
  });

  it('after clicking, label becomes "Switch to dark mode" and .light is added', async () => {
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole('button'));
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(screen.getByRole('button', { name: /switch to dark mode/i })).toBeInTheDocument();
  });

  it('pre-storing light theme yields light state at mount', () => {
    localStorage.setItem('fbi-theme', 'light');
    render(<ThemeToggle />);
    expect(screen.getByRole('button', { name: /switch to dark mode/i })).toBeInTheDocument();
  });

  it('clicking from light state removes .light', async () => {
    localStorage.setItem('fbi-theme', 'light');
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole('button'));
    expect(document.documentElement.classList.contains('light')).toBe(false);
    expect(screen.getByRole('button', { name: /switch to light mode/i })).toBeInTheDocument();
  });
});
