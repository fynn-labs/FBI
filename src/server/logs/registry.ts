import fs from 'node:fs/promises';
import { Broadcaster } from './broadcaster.js';
import { StateBroadcaster } from './stateBroadcaster.js';
import { TypedBroadcaster } from './typedBroadcaster.js';
import { ScreenState } from './screen.js';
import type {
  RunWsUsageMessage, RunWsTitleMessage, RunWsFilesMessage, GlobalStateMessage,
} from '../../shared/types.js';

export type RunEvent = RunWsUsageMessage | RunWsTitleMessage | RunWsFilesMessage;

// Cap the replay volume when rebuilding a ScreenState from a run's log after
// a server restart. Alt-screen TUIs clear on every full repaint, so only the
// recent tail matters for reconstructing "current screen."
const REBUILD_TAIL_CAP = 50 * 1024 * 1024; // 50 MB

export class RunStreamRegistry {
  private bytes = new Map<number, Broadcaster>();
  private state = new Map<number, StateBroadcaster>();
  private events = new Map<number, TypedBroadcaster<RunEvent>>();
  private globalStates = new TypedBroadcaster<GlobalStateMessage>();
  private screens = new Map<number, ScreenState>();
  private rebuilds = new Map<number, Promise<ScreenState>>();

  getOrCreate(runId: number): Broadcaster {
    let b = this.bytes.get(runId);
    if (!b) { b = new Broadcaster(); this.bytes.set(runId, b); }
    return b;
  }

  get(runId: number): Broadcaster | undefined {
    return this.bytes.get(runId);
  }

  getOrCreateState(runId: number): StateBroadcaster {
    let b = this.state.get(runId);
    if (!b) { b = new StateBroadcaster(); this.state.set(runId, b); }
    return b;
  }

  getState(runId: number): StateBroadcaster | undefined {
    return this.state.get(runId);
  }

  getOrCreateEvents(runId: number): TypedBroadcaster<RunEvent> {
    let b = this.events.get(runId);
    if (!b) { b = new TypedBroadcaster<RunEvent>(); this.events.set(runId, b); }
    return b;
  }

  getGlobalStates(): TypedBroadcaster<GlobalStateMessage> {
    return this.globalStates;
  }

  getOrCreateScreen(runId: number, cols = 120, rows = 40): ScreenState {
    let s = this.screens.get(runId);
    if (!s) { s = new ScreenState(cols, rows); this.screens.set(runId, s); }
    return s;
  }

  getScreen(runId: number): ScreenState | undefined {
    return this.screens.get(runId);
  }

  async rebuildScreenFromLog(
    runId: number,
    logPath: string,
    cols = 120,
    rows = 40,
  ): Promise<ScreenState> {
    const inflight = this.rebuilds.get(runId);
    if (inflight) return inflight;
    const p = this.doRebuild(runId, logPath, cols, rows).finally(() => {
      this.rebuilds.delete(runId);
    });
    this.rebuilds.set(runId, p);
    return p;
  }

  private async doRebuild(
    runId: number,
    logPath: string,
    cols: number,
    rows: number,
  ): Promise<ScreenState> {
    const existing = this.screens.get(runId);
    if (existing) existing.dispose();
    const fresh = new ScreenState(cols, rows);
    this.screens.set(runId, fresh);
    try {
      const stat = await fs.stat(logPath);
      const size = stat.size;
      const start = size > REBUILD_TAIL_CAP ? size - REBUILD_TAIL_CAP : 0;
      const fd = await fs.open(logPath, 'r');
      try {
        const bufSize = 1024 * 1024;
        const buf = Buffer.alloc(bufSize);
        let pos = start;
        while (pos < size) {
          const toRead = Math.min(bufSize, size - pos);
          const { bytesRead } = await fd.read(buf, 0, toRead, pos);
          if (bytesRead === 0) break;
          await fresh.write(
            new Uint8Array(buf.buffer, buf.byteOffset, bytesRead).slice()
          );
          pos += bytesRead;
        }
      } finally {
        await fd.close();
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.screens.delete(runId);
        fresh.dispose();
        throw err;
      }
    }
    return fresh;
  }

  release(runId: number): void {
    this.bytes.delete(runId);
    this.state.delete(runId);
    this.events.delete(runId);
    const s = this.screens.get(runId);
    if (s) { s.dispose(); this.screens.delete(runId); }
  }
}
