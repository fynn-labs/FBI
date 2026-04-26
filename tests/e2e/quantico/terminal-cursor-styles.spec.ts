/**
 * Validates snapshot-reload equality for the cursor-styles scenario.
 *
 * cursor-styles cycles through all DECSCUSR cursor shape/blink variants
 * (block blinking/steady, underline blinking/steady, bar blinking/steady).
 * The NIF snapshot must encode the current cursor style so the rebuilt
 * terminal displays the same cursor appearance as the live view.
 */

import { test, expect } from '@playwright/test';
import { createMockRun } from './helpers.js';

test('cursor-styles: snapshot reload reproduces live state', async ({ page }) => {
  const run = await createMockRun(page, { scenario: 'cursor-styles' });
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
