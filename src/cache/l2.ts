import type { KvStore } from "../bridge/storage.ts";
import type { Clock, TimerId } from "../core/clock.ts";
import type { Logger } from "../core/log.ts";

/** CNFR-17: персистентный кэш в localStorage ≤ 1,5 МБ. */
const DEFAULT_MAX_BYTES = 1_500_000;
/** Спец. §7.3: L2 не пишется синхронно в критическом пути, записи копятся и уходят пачкой. */
const FLUSH_DELAY_MS = 1000;
const TAG = "l2";

/** Запись в `kp.l2.<key>`: значение, время сохранения и размер значения. */
interface Rec {
  v: unknown;
  t: number;
  b: number;
}

interface Meta {
  t: number;
  b: number;
}

function isRec(x: unknown): x is Rec {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Partial<Rec>;
  return "v" in r && typeof r.t === "number" && typeof r.b === "number";
}

/** Размер записи кэша: длина JSON × 2 (UTF-16). */
export function sizeOf(value: unknown): number {
  return (JSON.stringify(value) ?? "").length * 2;
}

/**
 * L2 (спец. §8.1): `kp.l2.*` через KvStore. Бюджет считается по размеру значений; при превышении
 * вытесняются самые старые `savedAt`. Индекс размеров читается из хранилища лениво, при первой записи.
 */
export class L2 {
  private store: KvStore;
  private clock: Clock;
  private maxBytes: number;
  private log: Logger | undefined;
  private pending = new Map<string, { v: unknown; t: number }>();
  private timer: TimerId | undefined;
  private index: Map<string, Meta> | undefined;
  private total = 0;

  constructor(store: KvStore, clock: Clock, maxBytes: number = DEFAULT_MAX_BYTES, log?: Logger) {
    this.store = store;
    this.clock = clock;
    this.maxBytes = maxBytes;
    this.log = log;
  }

  get<T>(key: string): { value: T; savedAt: number; bytes: number } | undefined {
    const p = this.pending.get(key);
    if (p !== undefined) return { value: p.v as T, savedAt: p.t, bytes: sizeOf(p.v) };
    const r = this.store.get<unknown>("l2", key);
    if (!isRec(r)) return undefined;
    return { value: r.v as T, savedAt: r.t, bytes: r.b };
  }

  /** Отложенная запись: `savedAt` — момент вызова, в хранилище — через 1 с одной пачкой. */
  put(key: string, value: unknown): void {
    this.pending.set(key, { v: value, t: this.clock.now() });
    if (this.timer === undefined) this.timer = this.clock.setTimeout(() => this.flush(), FLUSH_DELAY_MS);
  }

  flush(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.size === 0) return;
    const batch = this.pending;
    this.pending = new Map();
    const index = this.loadIndex();
    for (const [key, p] of batch) {
      this.drop(index, key);
      if (p.v === undefined) continue;
      this.write(index, key, p.v, p.t);
    }
  }

  remove(key: string): void {
    this.pending.delete(key);
    if (this.index !== undefined) this.drop(this.index, key);
    else this.store.remove("l2", key);
  }

  private write(index: Map<string, Meta>, key: string, v: unknown, t: number): void {
    let b: number;
    try {
      b = sizeOf(v);
    } catch {
      this.log?.warn(TAG, "skip_unserializable", { key });
      return;
    }
    if (b > this.maxBytes) {
      this.log?.warn(TAG, "skip_too_big", { key, bytes: b });
      return;
    }
    while (this.total + b > this.maxBytes) {
      if (!this.evictOldest(index)) break;
    }
    const rec: Rec = { v, t, b };
    if (!this.store.set("l2", key, rec)) {
      this.log?.warn(TAG, "skip_quota", { key, bytes: b });
      return;
    }
    index.set(key, { t, b });
    this.total += b;
  }

  private drop(index: Map<string, Meta>, key: string): void {
    const m = index.get(key);
    if (m !== undefined) {
      index.delete(key);
      this.total -= m.b;
    }
    this.store.remove("l2", key);
  }

  private evictOldest(index: Map<string, Meta>): boolean {
    let oldest: string | undefined;
    let at = Infinity;
    for (const [k, m] of index) {
      if (m.t < at) {
        at = m.t;
        oldest = k;
      }
    }
    if (oldest === undefined) return false;
    this.drop(index, oldest);
    return true;
  }

  private loadIndex(): Map<string, Meta> {
    if (this.index !== undefined) return this.index;
    const index = new Map<string, Meta>();
    this.total = 0;
    for (const key of this.store.keys("l2")) {
      const r = this.store.get<unknown>("l2", key);
      if (!isRec(r)) {
        this.store.remove("l2", key);
        continue;
      }
      index.set(key, { t: r.t, b: r.b });
      this.total += r.b;
    }
    this.index = index;
    return index;
  }
}
