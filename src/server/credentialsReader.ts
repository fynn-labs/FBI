import fs from 'node:fs';
import path from 'node:path';

export interface CredentialsReaderOptions {
  file: string;
  debounceMs?: number;
}

export class CredentialsReader {
  private file: string;
  private debounceMs: number;
  private watcher: fs.FSWatcher | null = null;
  private listeners = new Set<() => void>();
  private debounce: NodeJS.Timeout | null = null;

  constructor(opts: CredentialsReaderOptions) {
    this.file = opts.file;
    this.debounceMs = opts.debounceMs ?? 500;
  }

  read(): string | null {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const obj = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
      const t = obj?.claudeAiOauth?.accessToken;
      return typeof t === 'string' && t.length > 0 ? t : null;
    } catch {
      return null;
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    if (!this.watcher) this.start();
    return () => { this.listeners.delete(cb); };
  }

  close(): void {
    if (this.debounce) { clearTimeout(this.debounce); this.debounce = null; }
    this.watcher?.close();
    this.watcher = null;
    this.listeners.clear();
  }

  private start(): void {
    try {
      this.watcher = fs.watch(this.file, () => this.scheduleEmit());
    } catch {
      const dir = path.dirname(this.file);
      this.watcher = fs.watch(dir, () => {
        if (fs.existsSync(this.file)) this.scheduleEmit();
      });
    }
  }

  private scheduleEmit(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      for (const l of this.listeners) l();
    }, this.debounceMs);
  }
}
