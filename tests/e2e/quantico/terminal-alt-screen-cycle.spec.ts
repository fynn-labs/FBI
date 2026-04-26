/**
 * Validates that a forced page reload (destroying and recreating the terminal
 * controller + WebSocket connection) produces a snapshot-faithful replica of
 * the live terminal state for the alt-screen-cycle scenario.
 *
 * The alt-screen-cycle scenario exercises repeated switches between the
 * primary and alternate screen buffers (e.g. as vim/less would trigger).
 * A correct Rust NIF snapshot must capture which buffer is active and its
 * full content, so the rebuilt terminal matches the pre-reload view exactly.
 */

import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('alt-screen-cycle: snapshot reload reproduces live state', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'alt-screen-cycle' });
  try {
    // Wait for the scenario to run to completion (small + sleeps).
    await page.waitForTimeout(2000);
    const liveText = await run.terminalText();

    // Force a reload — fresh controller, fresh WS connection, fresh snapshot.
    await page.reload();
    await page.waitForTimeout(2000);
    const rebuiltText = await run.terminalText();

    expect(rebuiltText).toEqual(liveText);
  } finally {
    await run.destroy();
  }
});
