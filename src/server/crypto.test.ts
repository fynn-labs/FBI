import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, loadKey } from './crypto.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('crypto', () => {
  const key = crypto.randomBytes(32);

  it('round-trips a string', () => {
    const ct = encrypt(key, 'hunter2');
    expect(ct).toBeInstanceOf(Uint8Array);
    expect(decrypt(key, ct)).toBe('hunter2');
  });

  it('produces different ciphertexts for the same plaintext', () => {
    const a = encrypt(key, 'same');
    const b = encrypt(key, 'same');
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).not.toBe(0);
  });

  it('fails on tampered ciphertext', () => {
    const ct = Buffer.from(encrypt(key, 'secret'));
    ct[ct.length - 1] ^= 0xff;
    expect(() => decrypt(key, ct)).toThrow();
  });

  it('loadKey rejects short files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'short.key');
    fs.writeFileSync(p, Buffer.alloc(16));
    expect(() => loadKey(p)).toThrow(/32 bytes/);
    fs.rmSync(dir, { recursive: true });
  });

  it('loadKey returns 32 bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-'));
    const p = path.join(dir, 'k.key');
    fs.writeFileSync(p, Buffer.alloc(32, 7));
    const k = loadKey(p);
    expect(k.length).toBe(32);
    fs.rmSync(dir, { recursive: true });
  });
});
