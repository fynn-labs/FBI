import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseProcNetTcp } from './procListeners.js';

const FIX = path.join(__dirname, '__fixtures__');
const read = (n: string) => fs.readFileSync(path.join(FIX, n), 'utf8');

describe('parseProcNetTcp', () => {
  it('returns [] for the header-only fixture', () => {
    expect(parseProcNetTcp(read('proc-net-tcp-empty.txt'))).toEqual([]);
  });

  it('parses a single LISTEN socket', () => {
    expect(parseProcNetTcp(read('proc-net-tcp-one-listener.txt'))).toEqual([
      { port: 5173, proto: 'tcp' },
    ]);
  });

  it('filters non-LISTEN, dedupes ports, returns sorted ascending', () => {
    expect(parseProcNetTcp(read('proc-net-tcp-many.txt'))).toEqual([
      { port: 5173, proto: 'tcp' },
      { port: 9229, proto: 'tcp' },
    ]);
  });
});
