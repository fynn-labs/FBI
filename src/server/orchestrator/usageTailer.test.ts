import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UsageTailer } from './usageTailer.js';
import type { UsageSnapshot, RateLimitSnapshot } from '../../shared/types.js';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fbi-tailer-'));
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('UsageTailer', () => {
  it('picks up lines written after start, handles late file creation', async () => {
    const dir = makeTmp();
    const usages: UsageSnapshot[] = [];
    const rls: RateLimitSnapshot[] = [];
    const errs: string[] = [];
    const tailer = new UsageTailer({
      dir,
      pollMs: 50,
      onUsage: (s) => usages.push(s),
      onRateLimit: (s) => rls.push(s),
      onError: (e) => errs.push(e),
    });
    tailer.start();

    // File doesn't exist yet — simulate Claude creating the slug dir then the file.
    await wait(120);
    const slug = path.join(dir, '-workspace');
    fs.mkdirSync(slug, { recursive: true });
    const file = path.join(slug, 'sess.jsonl');
    fs.writeFileSync(file, '');

    const line = (obj: object) => JSON.stringify(obj) + '\n';
    fs.appendFileSync(file, line({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }));

    // Poll interval is 50ms; wait generously.
    await wait(200);
    expect(usages.length).toBe(1);
    expect(usages[0].input_tokens).toBe(10);
    expect(errs).toEqual([]);

    // Append a second line while running.
    fs.appendFileSync(file, line({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-6',
        usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      rateLimits: {
        'anthropic-ratelimit-unified-5h-requests-remaining': '77',
        'anthropic-ratelimit-unified-5h-requests-limit': '200',
      },
    }));
    await wait(200);
    expect(usages.length).toBe(2);
    expect(rls.length).toBe(1);
    expect(rls[0].requests_remaining).toBe(77);

    await tailer.stop();
  });

  it('ignores a trailing partial line until completed', async () => {
    const dir = makeTmp();
    const usages: UsageSnapshot[] = [];
    const tailer = new UsageTailer({
      dir, pollMs: 50,
      onUsage: (s) => usages.push(s),
      onRateLimit: () => {},
      onError: () => {},
    });
    tailer.start();
    const slug = path.join(dir, '-workspace');
    fs.mkdirSync(slug, { recursive: true });
    const file = path.join(slug, 'sess.jsonl');
    // Write a partial line (no newline).
    fs.writeFileSync(file, '{"type":"assistant"');
    await wait(200);
    expect(usages.length).toBe(0);
    // Finish the line.
    fs.appendFileSync(file, ',"message":{"role":"assistant","model":"claude-sonnet-4-6","usage":{"input_tokens":1,"output_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}\n');
    await wait(200);
    expect(usages.length).toBe(1);
    await tailer.stop();
  });

  it('stop() performs a final full-file pass to catch last lines', async () => {
    const dir = makeTmp();
    const usages: UsageSnapshot[] = [];
    const tailer = new UsageTailer({
      dir, pollMs: 10_000, // deliberately far longer than the test
      onUsage: (s) => usages.push(s),
      onRateLimit: () => {}, onError: () => {},
    });
    tailer.start();
    const slug = path.join(dir, '-workspace');
    fs.mkdirSync(slug, { recursive: true });
    const file = path.join(slug, 'sess.jsonl');
    fs.writeFileSync(file, JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant', model: 'claude-sonnet-4-6',
        usage: { input_tokens: 42, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }) + '\n');
    // No wait — rely on final pass.
    await tailer.stop();
    expect(usages.length).toBe(1);
    expect(usages[0].input_tokens).toBe(42);
  });
});
