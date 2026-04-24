import { describe, it, expect } from 'vitest';

import { buildSafeguardBind } from './safeguardBind.js';

describe('buildSafeguardBind', () => {
  it('maps a runId to the /safeguard bind-mount entry', () => {
    expect(buildSafeguardBind('/var/lib/agent-manager/runs', 42))
      .toBe('/var/lib/agent-manager/runs/42/wip.git:/safeguard:rw');
  });
  it('respects a host bind-prefix override', () => {
    expect(buildSafeguardBind('/srv/runs', 1, '/host/runs'))
      .toBe('/host/runs/1/wip.git:/safeguard:rw');
  });
});
