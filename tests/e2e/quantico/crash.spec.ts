import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('crash-fast exits 1 and marks run failed', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'crash-fast' });
  try {
    await expect(page.getByTestId('run-state-badge'))
      .toContainText(/failed|errored/i, { timeout: 30_000 });
    await expect(page.getByTestId('run-exit-code')).toContainText('1');
  } finally {
    await run.destroy();
  }
});

test('hang ignores SIGTERM but is killed when stop is requested', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'hang' });
  try {
    await expect(page.getByTestId('run-state-badge'))
      .toContainText(/running/i, { timeout: 15_000 });
    await page.request.post(`/api/runs/${run.id}/stop`).catch(() => {});
    await expect(page.getByTestId('run-state-badge'))
      .toContainText(/stopped|failed|errored/i, { timeout: 30_000 });
  } finally {
    await run.destroy();
  }
});
