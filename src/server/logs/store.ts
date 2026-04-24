import fs from 'node:fs';
import path from 'node:path';

export class LogStore {
  private fd: number;

  constructor(private filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.fd = fs.openSync(filePath, 'a');
  }

  append(chunk: Uint8Array): void {
    fs.writeSync(this.fd, chunk);
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  static readAll(filePath: string): Uint8Array {
    try {
      return fs.readFileSync(filePath);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Uint8Array();
      throw err;
    }
  }

  static byteSize(filePath: string): number {
    try {
      return fs.statSync(filePath).size;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw err;
    }
  }

  /**
   * Read a byte range `[start, end]` (both inclusive, mirroring HTTP
   * Range semantics). Clamps end to file size; returns empty Uint8Array
   * for missing file or start ≥ size.
   *
   * Callers must pass non-negative integers with `start <= end`. Floats,
   * negative values, or `start > end` produce a low-level RangeError from
   * the underlying fs call — validation is the caller's responsibility.
   * If the file is truncated during the read, returns only the bytes
   * successfully read (slice shorter than `end - start + 1`).
   */
  static readRange(filePath: string, start: number, end: number): Uint8Array {
    let fd: number;
    try {
      fd = fs.openSync(filePath, 'r');
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return new Uint8Array();
      throw err;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (start >= size) return new Uint8Array();
      const clampedEnd = Math.min(end, size - 1);
      const length = clampedEnd - start + 1;
      const buf = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = fs.readSync(fd, buf, read, length - read, start + read);
        if (n === 0) break;
        read += n;
      }
      return new Uint8Array(buf.buffer, buf.byteOffset, read);
    } finally {
      fs.closeSync(fd);
    }
  }
}
