import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('continue-run path: second run sees prior session and emits resume marker', async ({ page }) => {
  const first = await createMockRun(page, { scenario: 'default' });
  await first.waitForTerminalText('Done.', { timeoutMs: 30_000 });

  await page.getByRole('button', { name: /Continue run/i }).click();
  await page.waitForURL(/\/projects\/\d+\/runs\/\d+/);
  const secondId = Number(page.url().match(/runs\/(\d+)/)![1]);

  await expect(page.getByTestId('xterm'))
    .toContainText('[quantico] resumed from', { timeout: 30_000 });

  await page.request.delete(`/api/runs/${first.id}`).catch(() => {});
  await page.request.delete(`/api/runs/${secondId}`).catch(() => {});
});
