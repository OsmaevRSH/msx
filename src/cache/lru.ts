export interface Entry<V> {
  value: V;
  bytes: number;
  fetchedAt: number;
  staleMarked: boolean;
}

/** CNFR-17: кэш в памяти ≤ 15 МБ. */
const DEFAULT_MAX_BYTES = 15 * 1024 * 1024;

/** L1 (спец. §8.1): LRU по байтам. Порядок Map — от давно не использованных к недавним. */
export class Lru<V = unknown> {
  private map = new Map<string, Entry<V>>();
  private maxBytes: number;
  private total = 0;

  constructor(maxBytes: number = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  /** Отдаёт запись и делает её самой недавней. */
  get(k: string): Entry<V> | undefined {
    const e = this.map.get(k);
    if (e === undefined) return undefined;
    this.map.delete(k);
    this.map.set(k, e);
    return e;
  }

  /** Отдаёт запись, не меняя порядок вытеснения. */
  peek(k: string): Entry<V> | undefined {
    return this.map.get(k);
  }

  /** Запись больше всего бюджета не хранится (старое значение ключа при этом удаляется). */
  set(k: string, e: Entry<V>): void {
    this.delete(k);
    if (e.bytes > this.maxBytes) return;
    this.map.set(k, e);
    this.total += e.bytes;
    for (const old of this.map.keys()) {
      if (this.total <= this.maxBytes) break;
      this.delete(old);
    }
  }

  delete(k: string): void {
    const e = this.map.get(k);
    if (e === undefined) return;
    this.map.delete(k);
    this.total -= e.bytes;
  }

  /** Ключи от давно не использованных к недавним. */
  keys(): string[] {
    return [...this.map.keys()];
  }

  bytes(): number {
    return this.total;
  }
}
