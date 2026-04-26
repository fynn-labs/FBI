/**
 * Validates the TerminalTakeoverBanner UI behavior:
 * - A second viewer whose viewport dimensions differ from the focused viewer's
 *   sees the dim-mismatch banner ("Take over").
 * - Clicking the banner transfers focus: the PTY resizes to the new viewer's
 *   dims, the banner disappears on the clicker, and appears on the former
 *   focused viewer.
 *
 * This tests the full round-trip: WS focus_state propagation, frontend
 * TakeoverBanner rendering, and the takeover click handler.
 */

import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('takeover-banner: appears for non-driving viewer; click takes over', async ({ browser }) => {
  // Two contexts at different viewport sizes connecting to the same run.
  const ctxA = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const pageA = await ctxA.newPage();
  const run = await createMockRun(pageA, { scenario: 'chatty' });

  const ctxB = await browser.newContext({ viewport: { width: 600, height: 400 } });
  const pageB = await ctxB.newPage();
  await pageB.goto(pageA.url());

  // B's viewport is much smaller than A's. Since A connected first, A is the
  // focused viewer; B sees the dim-mismatch banner.
  await expect(pageB.getByText(/Take over/)).toBeVisible({ timeout: 10000 });

  // Click takeover on B; PTY resizes to B's dims; banner disappears on B,
  // appears on A (now driving at smaller dims than A's viewport).
  await pageB.getByRole('button', { name: /Take over/ }).click();
  await expect(pageB.getByText(/Take over/)).toBeHidden({ timeout: 10000 });
  await expect(pageA.getByText(/Take over/)).toBeVisible({ timeout: 10000 });

  await run.destroy();
  await ctxA.close();
  await ctxB.close();
});
