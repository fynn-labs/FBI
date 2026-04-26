import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('auto-scroll: stays pinned during steady output', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'chatty' });
  try {
    await run.waitForTerminalText('thinking', { timeoutMs: 15_000 });
    await page.waitForTimeout(2_000);
    await run.expectScrolledToBottom();

    // Manually scroll up: should stop pinning.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="xterm-viewport"]') as HTMLElement;
      el.scrollTop = 0;
    });
    await page.waitForTimeout(2_000);
    const stillTop = await page.evaluate(() =>
      (document.querySelector('[data-testid="xterm-viewport"]') as HTMLElement).scrollTop,
    );
    expect(stillTop).toBeLessThan(50);

    // Scroll back to bottom: should re-pin.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="xterm-viewport"]') as HTMLElement;
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(2_000);
    await run.expectScrolledToBottom();
  } finally {
    await run.destroy();
  }
});
