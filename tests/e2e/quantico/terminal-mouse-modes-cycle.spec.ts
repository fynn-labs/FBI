/**
 * Validates snapshot-reload equality for the mouse-modes-cycle scenario.
 *
 * mouse-modes-cycle exercises enabling and disabling various mouse-tracking
 * modes (X10, normal, button-event, any-event, SGR extended). The NIF snapshot
 * must capture the active mouse mode in the terminal's mode flags so a reloaded
 * controller restores the same mode state and rendered output.
 */

import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('mouse-modes-cycle: snapshot reload reproduces live state', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'mouse-modes-cycle' });
  try {
    await page.waitForTimeout(2000);
    const liveText = await run.terminalText();

    await page.reload();
    await page.waitForTimeout(2000);
    const rebuiltText = await run.terminalText();

    expect(rebuiltText).toEqual(liveText);
  } finally {
    await run.destroy();
  }
});
