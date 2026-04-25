import { describe, it, expect } from 'vitest';
import { fbi } from './fbiOutput.js';

describe('fbi', () => {
  describe('status', () => {
    it('returns a string ending with newline', () => {
      const result = fbi.status('test message');
      expect(result).toMatch(/\n$/);
    });

    it('contains GRAY color code', () => {
      const result = fbi.status('test message');
      expect(result).toContain('\x1b[90m');
    });

    it('contains WHITE color code', () => {
      const result = fbi.status('test message');
      expect(result).toContain('\x1b[97m');
    });

    it('includes the ○ symbol', () => {
      const result = fbi.status('test message');
      expect(result).toContain('○');
    });

    it('includes the message text', () => {
      const result = fbi.status('test message');
      expect(result).toContain('test message');
    });
  });

  describe('statusKV', () => {
    it('returns a string ending with newline', () => {
      const result = fbi.statusKV('key', 'value');
      expect(result).toMatch(/\n$/);
    });

    it('contains GRAY color code', () => {
      const result = fbi.statusKV('key', 'value');
      expect(result).toContain('\x1b[90m');
    });

    it('contains WHITE color code for key', () => {
      const result = fbi.statusKV('key', 'value');
      expect(result).toContain('\x1b[97m');
    });

    it('contains DIM color code for value', () => {
      const result = fbi.statusKV('key', 'value');
      expect(result).toContain('\x1b[2m');
    });

    it('includes both key and value in output', () => {
      const result = fbi.statusKV('mykey', 'myval');
      expect(result).toContain('mykey');
      expect(result).toContain('myval');
    });

    it('includes the ○ symbol', () => {
      const result = fbi.statusKV('key', 'value');
      expect(result).toContain('○');
    });
  });

  describe('warn', () => {
    it('returns a string ending with newline', () => {
      const result = fbi.warn('test warning');
      expect(result).toMatch(/\n$/);
    });

    it('contains AMBER color code', () => {
      const result = fbi.warn('test warning');
      expect(result).toContain('\x1b[33m');
    });

    it('includes the ⚠ symbol', () => {
      const result = fbi.warn('test warning');
      expect(result).toContain('⚠');
    });

    it('includes the message text', () => {
      const result = fbi.warn('test warning');
      expect(result).toContain('test warning');
    });
  });

  describe('fatal', () => {
    it('returns a string ending with newline', () => {
      const result = fbi.fatal('test fatal');
      expect(result).toMatch(/\n$/);
    });

    it('contains RED color code', () => {
      const result = fbi.fatal('test fatal');
      expect(result).toContain('\x1b[31m');
    });

    it('includes the ✕ symbol', () => {
      const result = fbi.fatal('test fatal');
      expect(result).toContain('✕');
    });

    it('includes the message text', () => {
      const result = fbi.fatal('test fatal');
      expect(result).toContain('test fatal');
    });
  });

  describe('info', () => {
    it('returns a string ending with newline', () => {
      const result = fbi.info('test info');
      expect(result).toMatch(/\n$/);
    });

    it('contains BLUE color code', () => {
      const result = fbi.info('test info');
      expect(result).toContain('\x1b[34m');
    });

    it('includes the ◎ symbol', () => {
      const result = fbi.info('test info');
      expect(result).toContain('◎');
    });

    it('includes the message text', () => {
      const result = fbi.info('test info');
      expect(result).toContain('test info');
    });
  });

  describe('runState', () => {
    it('returns a string ending with newline', () => {
      const result = fbi.runState('succeeded');
      expect(result).toMatch(/\n$/);
    });

    it('returns GREEN color code for succeeded state', () => {
      const result = fbi.runState('succeeded');
      expect(result).toContain('\x1b[32m');
    });

    it('returns RED color code for failed state', () => {
      const result = fbi.runState('failed');
      expect(result).toContain('\x1b[31m');
    });

    it('returns AMBER color code for cancelled state', () => {
      const result = fbi.runState('cancelled');
      expect(result).toContain('\x1b[33m');
    });

    it('includes the state name in output', () => {
      const result = fbi.runState('succeeded');
      expect(result).toContain('succeeded');
    });

    it('includes the state name for failed', () => {
      const result = fbi.runState('failed');
      expect(result).toContain('failed');
    });

    it('includes the state name for cancelled', () => {
      const result = fbi.runState('cancelled');
      expect(result).toContain('cancelled');
    });
  });
});
