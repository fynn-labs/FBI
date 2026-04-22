type DataFn<T> = (msg: T) => void;
type EndFn = () => void;

interface Sub<T> { onData: DataFn<T>; onEnd: EndFn | undefined }

export class TypedBroadcaster<T> {
  private subs = new Set<Sub<T>>();
  private ended = false;

  subscribe(onData: DataFn<T>, onEnd?: EndFn): () => void {
    const sub: Sub<T> = { onData, onEnd };
    this.subs.add(sub);
    return () => this.subs.delete(sub);
  }

  publish(msg: T): void {
    if (this.ended) return;
    for (const s of this.subs) s.onData(msg);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const s of this.subs) s.onEnd?.();
  }

  isEnded(): boolean { return this.ended; }
}
