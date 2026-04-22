import { Broadcaster } from './broadcaster.js';

export class RunStreamRegistry {
  private map = new Map<number, Broadcaster>();

  getOrCreate(runId: number): Broadcaster {
    let b = this.map.get(runId);
    if (!b) {
      b = new Broadcaster();
      this.map.set(runId, b);
    }
    return b;
  }

  get(runId: number): Broadcaster | undefined {
    return this.map.get(runId);
  }

  release(runId: number): void {
    this.map.delete(runId);
  }
}
