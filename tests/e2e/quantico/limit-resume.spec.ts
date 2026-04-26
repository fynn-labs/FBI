import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('limit-breach triggers waiting-state, then auto-resumes', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'limit-breach' });
  try {
    await run.waitForTerminalText('Claude usage limit reached', { timeoutMs: 30_000 });

    const stateBadge = page.getByTestId('run-state-badge');
    await expect(stateBadge).toContainText(/awaiting|waiting|paused/i, { timeout: 15_000 });

    await page.request.post(`/api/runs/${run.id}/resume-now`);
    await expect(stateBadge).toContainText(/running/i, { timeout: 30_000 });

    await run.waitForTerminalText('[quantico] resumed from', { timeoutMs: 30_000 });
  } finally {
    await run.destroy();
  }
});
