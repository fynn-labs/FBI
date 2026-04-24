import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { snapshotScripts } from './snapshotScripts.js';

describe('snapshotScripts', () => {
  it('copies the three scripts into destDir as executable', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-src-'));
    const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'sx-dst-'));
    const sup = path.join(src, 'supervisor.sh'); fs.writeFileSync(sup, '#!/bin/sh\n');
    const fin = path.join(src, 'finalizeBranch.sh'); fs.writeFileSync(fin, '#!/bin/sh\n');
    const hist = path.join(src, 'fbi-history-op.sh'); fs.writeFileSync(hist, '#!/bin/sh\n');
    snapshotScripts(dst, sup, fin, hist);
    for (const n of ['supervisor.sh', 'finalizeBranch.sh', 'fbi-history-op.sh']) {
      const p = path.join(dst, n);
      expect(fs.existsSync(p)).toBe(true);
      expect((fs.statSync(p).mode & 0o111)).not.toBe(0);
    }
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dst, { recursive: true, force: true });
  });
});
