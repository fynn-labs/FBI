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
}
