import crypto from 'node:crypto';
import fs from 'node:fs';

const NONCE_LEN = 12;
const TAG_LEN = 16;

export function encrypt(key: Buffer, plaintext: string): Uint8Array {
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ct, tag]);
}

export function decrypt(key: Buffer, blob: Uint8Array): string {
  const b = Buffer.from(blob);
  const nonce = b.subarray(0, NONCE_LEN);
  const tag = b.subarray(b.length - TAG_LEN);
  const ct = b.subarray(NONCE_LEN, b.length - TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function loadKey(path: string): Buffer {
  const raw = fs.readFileSync(path);
  if (raw.length !== 32) {
    throw new Error(
      `Secrets key file must be exactly 32 bytes, got ${raw.length}`
    );
  }
  return raw;
}
