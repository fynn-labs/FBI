import crypto from 'node:crypto';

const TOKEN_RE = /^[0-9a-f]{32}$/;

export function generateDraftToken(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function isDraftToken(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_RE.test(v);
}
