import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUsageLine } from './usage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
function fixture(name: string): string {
  return fs.readFileSync(path.join(HERE, '__fixtures__', 'claude-jsonl', name), 'utf8').replace(/\n$/, '');
}

describe('parseUsageLine', () => {
  it('parses a canonical assistant turn with all four token kinds', () => {
    const r = parseUsageLine(fixture('assistant-turn-with-usage.jsonl'));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value).toEqual({
      model: 'claude-sonnet-4-6',
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_tokens: 5000,
      cache_create_tokens: 200,
    });
  });

  it('parses a cache-only assistant turn (zero output)', () => {
    const r = parseUsageLine(fixture('assistant-turn-with-cache-only.jsonl'));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.output_tokens).toBe(0);
    expect(r.value.cache_read_tokens).toBe(8000);
  });

  it('parses a haiku subagent turn with the correct model string', () => {
    const r = parseUsageLine(fixture('assistant-turn-haiku.jsonl'));
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.value.model).toBe('claude-haiku-4-5');
  });

  it('returns skip for a non-assistant turn (tool_result)', () => {
    const r = parseUsageLine(fixture('tool-use-turn.jsonl'));
    expect(r.kind).toBe('skip');
  });

  it('returns error for an assistant turn missing usage', () => {
    const r = parseUsageLine(fixture('malformed-missing-usage.jsonl'));
    expect(r.kind).toBe('error');
  });

  it('returns error for a non-JSON line', () => {
    const r = parseUsageLine(fixture('garbage-line.jsonl'));
    expect(r.kind).toBe('error');
  });

  it('returns skip for an empty line', () => {
    expect(parseUsageLine('').kind).toBe('skip');
    expect(parseUsageLine('   ').kind).toBe('skip');
  });
});
