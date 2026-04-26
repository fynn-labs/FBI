/**
 * Validates snapshot-reload equality for the truecolor scenario.
 *
 * truecolor writes 24-bit RGB color escape sequences (both foreground and
 * background). The NIF snapshot must store full RGB color attributes per cell
 * rather than approximating to the nearest 256-color palette entry, so that the
 * rebuilt terminal renders the same colors as the live view.
 */

import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('truecolor: snapshot reload reproduces live state', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'truecolor' });
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
