import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeToClipboard } from './clipboard.js';

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

describe('writeToClipboard', () => {
  let mockWriteText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockWriteText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      writable: true,
      configurable: true,
    });
    // @ts-expect-error
    delete window.__TAURI_INTERNALS__;
  });

  afterEach(() => {
    // @ts-expect-error
    delete window.__TAURI_INTERNALS__;
  });

  it('calls navigator.clipboard.writeText in browser context', async () => {
    await writeToClipboard('hello world');
    expect(mockWriteText).toHaveBeenCalledWith('hello world');
  });

  it('calls navigator.clipboard.writeText with empty string', async () => {
    await writeToClipboard('');
    expect(mockWriteText).toHaveBeenCalledWith('');
  });

  it('calls tauri-plugin-clipboard-manager writeText in Tauri context', async () => {
    const tauriMock = await import('@tauri-apps/plugin-clipboard-manager');
    const tauriWriteText = vi.mocked(tauriMock.writeText);
    tauriWriteText.mockResolvedValue(undefined);
    // @ts-expect-error
    window.__TAURI_INTERNALS__ = {};
    await writeToClipboard('tauri text');
    expect(tauriWriteText).toHaveBeenCalledWith('tauri text');
    expect(mockWriteText).not.toHaveBeenCalled();
  });
});
