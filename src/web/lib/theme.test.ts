import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTheme } from './theme.js';

function mockMatchMedia(prefersDark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockReturnValue({
      matches: prefersDark,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

function mockLocalStorage() {
  const store: Record<string, string> = {};

  const localStorageMock = {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      for (const key of Object.keys(store)) {
        delete store[key];
      }
    },
    key: (index: number) => Object.keys(store)[index] || null,
    length: 0,
  };

  Object.defineProperty(localStorageMock, 'length', {
    get: () => Object.keys(store).length,
  });

  Object.defineProperty(window, 'localStorage', {
    writable: true,
    value: localStorageMock,
  });
}

beforeEach(() => {
  mockLocalStorage();
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  mockMatchMedia(false);
});

describe('useTheme', () => {
  it('defaults to light when no localStorage and system is light', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('defaults to dark when system prefers dark and no localStorage', () => {
    mockMatchMedia(true);
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('respects localStorage light over system dark', () => {
    mockMatchMedia(true);
    localStorage.setItem('fbi-theme', 'light');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('respects localStorage dark over system light', () => {
    localStorage.setItem('fbi-theme', 'dark');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggle switches from light to dark, persists to localStorage, adds class', () => {
    const { result } = renderHook(() => useTheme());
    act(() => { result.current.toggle(); });
    expect(result.current.theme).toBe('dark');
    expect(localStorage.getItem('fbi-theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggle switches from dark to light, persists to localStorage, removes class', () => {
    localStorage.setItem('fbi-theme', 'dark');
    const { result } = renderHook(() => useTheme());
    act(() => { result.current.toggle(); });
    expect(result.current.theme).toBe('light');
    expect(localStorage.getItem('fbi-theme')).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
