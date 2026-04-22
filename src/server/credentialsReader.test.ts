import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CredentialsReader } from './credentialsReader.js';

describe('CredentialsReader', () => {
  let tmpDir: string;
  let file: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-creds-'));
    file = path.join(tmpDir, '.credentials.json');
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('read() returns null when file is missing', () => {
    const r = new CredentialsReader({ file });
    expect(r.read()).toBe(null);
  });

  it('read() returns accessToken when file exists', () => {
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-abc' } }));
    const r = new CredentialsReader({ file });
    expect(r.read()).toBe('tok-abc');
  });

  it('read() returns null on invalid JSON', () => {
    fs.writeFileSync(file, 'not-json');
    const r = new CredentialsReader({ file });
    expect(r.read()).toBe(null);
  });

  it('onChange fires after debounce when file is rewritten', async () => {
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'one' } }));
    const r = new CredentialsReader({ file, debounceMs: 50 });
    const cb = vi.fn();
    r.onChange(cb);
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'two' } }));
    await new Promise(res => setTimeout(res, 150));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(r.read()).toBe('two');
    r.close();
  });
});
