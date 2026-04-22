type DataFn = (chunk: Uint8Array) => void;
type EndFn = () => void;

interface Sub {
  onData: DataFn;
  onEnd: EndFn | undefined;
}

export class Broadcaster {
  private subs = new Set<Sub>();
  private ended = false;

  subscribe(onData: DataFn, onEnd?: EndFn): () => void {
    const sub: Sub = { onData, onEnd };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  publish(chunk: Uint8Array): void {
    if (this.ended) return;
    for (const s of this.subs) s.onData(chunk);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const s of this.subs) s.onEnd?.();
  }

  isEnded(): boolean {
    return this.ended;
  }
}
