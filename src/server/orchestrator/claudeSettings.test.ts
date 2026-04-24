import { describe, it, expect } from 'vitest';
import { buildClaudeSettingsJson } from './index.js';

describe('buildClaudeSettingsJson', () => {
  it('produces valid JSON with dangerous-mode flag preserved', () => {
    const parsed = JSON.parse(buildClaudeSettingsJson());
    expect(parsed.skipDangerousModePermissionPrompt).toBe(true);
  });

  it('wires Stop to create /fbi-state/waiting', () => {
    const parsed = JSON.parse(buildClaudeSettingsJson());
    const stop = parsed.hooks?.Stop?.[0]?.hooks?.[0];
    expect(stop).toEqual({
      type: 'command',
      command: 'touch /fbi-state/waiting',
      timeout: 5,
    });
  });

  it('wires UserPromptSubmit to remove /fbi-state/waiting and create /fbi-state/prompted', () => {
    const parsed = JSON.parse(buildClaudeSettingsJson());
    const ups = parsed.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];
    expect(ups).toEqual({
      type: 'command',
      command: 'rm -f /fbi-state/waiting && touch /fbi-state/prompted',
      timeout: 5,
    });
  });
});
