// Повторяет StorageLike из src/bridge/storage.ts (§0.6.4, этап 5), чтобы помощник не зависел от этапа 5.
export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
}

const entryBytes = (k: string, v: string): number => (k.length + v.length) * 2;

/** localStorage в памяти с квотой; метода clear нет намеренно (спец. §7.3). */
export class MemoryStorage implements StorageLike {
  /** Ключи успешных setItem по порядку. */
  writes: string[] = [];

  private map = new Map<string, string>();
  private quotaBytes: number | undefined;

  constructor(opts?: { quotaBytes?: number }) {
    this.quotaBytes = opts?.quotaBytes;
  }

  get length(): number {
    return this.map.size;
  }

  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }

  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }

  setItem(k: string, v: string): void {
    const value = String(v);
    if (this.quotaBytes !== undefined) {
      const old = this.map.get(k);
      const next = this.usedBytes() - (old === undefined ? 0 : entryBytes(k, old)) + entryBytes(k, value);
      if (next > this.quotaBytes) {
        throw Object.assign(new Error(`quota of ${this.quotaBytes} bytes exceeded by ${k}`), { name: "QuotaExceededError", code: 22 });
      }
    }
    this.map.set(k, value);
    this.writes.push(k);
  }

  removeItem(k: string): void {
    this.map.delete(k);
  }

  /** ≈ (длина ключа + значения) × 2 по всем ключам, как считает KvStore.bytes. */
  usedBytes(): number {
    let n = 0;
    for (const [k, v] of this.map) n += entryBytes(k, v);
    return n;
  }
}
