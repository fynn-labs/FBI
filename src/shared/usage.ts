import type { UsageSnapshot, RateLimitSnapshot } from './types.js';

export type UsageLineResult =
  | { kind: 'ok'; value: UsageSnapshot }
  | { kind: 'skip' }
  | { kind: 'error'; reason: string };

export function parseUsageLine(raw: string): UsageLineResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'skip' };

  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { kind: 'error', reason: 'not JSON' };
  }

  if (!isRecord(obj)) return { kind: 'error', reason: 'not an object' };
  const message = obj.message;
  if (!isRecord(message)) return { kind: 'skip' };
  if (message.role !== 'assistant') return { kind: 'skip' };

  const model = typeof message.model === 'string' ? message.model : null;
  const usage = message.usage;
  if (!isRecord(usage)) return { kind: 'error', reason: 'assistant turn missing usage' };

  const n = (k: string): number => {
    const v = usage[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };

  if (!model) return { kind: 'error', reason: 'assistant turn missing model' };

  return {
    kind: 'ok',
    value: {
      model,
      input_tokens: n('input_tokens'),
      output_tokens: n('output_tokens'),
      cache_read_tokens: n('cache_read_input_tokens'),
      cache_create_tokens: n('cache_creation_input_tokens'),
    },
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// parseRateLimitHeaders is defined in Task 4.
export type RateLimitLineResult =
  | { kind: 'ok'; value: RateLimitSnapshot }
  | { kind: 'skip' };
