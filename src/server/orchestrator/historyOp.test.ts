import { describe, it, expect } from 'vitest';
import { parseHistoryOpResult } from './historyOp.js';

describe('parseHistoryOpResult', () => {
  it('parses successful completion', () => {
    const r = parseHistoryOpResult('{"ok":true,"sha":"deadbeef","message":""}\n', 0);
    expect(r).toEqual({ kind: 'complete', sha: 'deadbeef' });
  });
  it('parses conflict', () => {
    const r = parseHistoryOpResult('{"ok":false,"reason":"conflict","message":"merge conflict"}\n', 0);
    expect(r).toEqual({ kind: 'conflict-detected', message: 'merge conflict' });
  });
  it('parses gh-error', () => {
    const r = parseHistoryOpResult('{"ok":false,"reason":"gh-error","message":"push failed"}\n', 0);
    expect(r).toEqual({ kind: 'gh-error', message: 'push failed' });
  });
  it('treats non-zero exit as gh-error when no JSON', () => {
    const r = parseHistoryOpResult('', 2);
    expect(r).toEqual({ kind: 'gh-error', message: 'exit code 2' });
  });
  it('handles multi-line output by taking the last JSON line', () => {
    const r = parseHistoryOpResult('progress…\n{"ok":true,"sha":"abc"}\n', 0);
    expect(r).toEqual({ kind: 'complete', sha: 'abc' });
  });
});
