import type { TokenPairRaw } from "../api/models.ts";
import type { KvStore } from "../bridge/storage.ts";
import type { Clock } from "../core/clock.ts";

/** Одна запись `kp.auth.pair`: один `setItem` атомарен, пара не сохранится наполовину (решение Р-16, CR-12). */
export interface StoredPair { access: string; refresh: string; expiresAt: number; gen: number }
/** `kp.auth.device`; `title` — название из `device/notify`, чтобы при смене версии повторить его же. */
export interface StoredDevice { id?: number; notifiedVersion?: string; title?: string }

const PAIR = "pair";
const DEVICE = "device";
// Спец. §7.3: expiresAt = now + expires_in − 30 с.
const EXPIRY_MARGIN_MS = 30_000;

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string" && x !== "";

function validPair(x: unknown): StoredPair | undefined {
  if (typeof x !== "object" || x === null) return undefined;
  const p = x as Record<string, unknown>;
  if (!isStr(p.access) || !isStr(p.refresh) || !isNum(p.expiresAt) || !isNum(p.gen)) return undefined;
  return { access: p.access, refresh: p.refresh, expiresAt: p.expiresAt, gen: p.gen };
}

function validDevice(x: unknown): StoredDevice {
  if (typeof x !== "object" || x === null) return {};
  const d = x as Record<string, unknown>;
  const out: StoredDevice = {};
  if (isNum(d.id)) out.id = d.id;
  if (isStr(d.notifiedVersion)) out.notifiedVersion = d.notifiedVersion;
  if (isStr(d.title)) out.title = d.title;
  return out;
}

/**
 * Токены и устройство KinoPub в `kp.auth.*` (спец. §7.3). Пара держится и в памяти: если запись не удалась даже
 * после очистки L2, новая пара всё равно нужна до конца сеанса — refresh уже убил старую.
 */
export class TokenStore {
  private store: KvStore;
  private clock: Clock;
  private cached: StoredPair | null | undefined;      // undefined — ещё не читали; null — пары нет
  private lastGen = 0;

  constructor(store: KvStore, clock: Clock) {
    this.store = store;
    this.clock = clock;
  }

  pair(): StoredPair | undefined {
    if (this.cached === undefined) this.cached = validPair(this.store.get("auth", PAIR)) ?? null;
    return this.cached === null ? undefined : { ...this.cached };
  }

  /** Пишет пару в хранилище до возврата; `gen` не убывает и после `clear()`. */
  save(raw: TokenPairRaw): StoredPair {
    const gen = Math.max(this.pair()?.gen ?? 0, this.lastGen) + 1;
    const p: StoredPair = { access: raw.access, refresh: raw.refresh, expiresAt: this.clock.now() + raw.expiresIn * 1000 - EXPIRY_MARGIN_MS, gen };
    this.store.set("auth", PAIR, p);
    this.cached = p;
    this.lastGen = gen;
    return { ...p };
  }

  device(): StoredDevice {
    return validDevice(this.store.get("auth", DEVICE));
  }

  saveDevice(d: StoredDevice): void {
    this.store.set("auth", DEVICE, validDevice(d));
  }

  /** Удаляет `kp.auth.*` только по префиксу (спец. §7.3). Код в src/ зовёт этот метод: `npm run privacy` запрещает там вызовы clear. */
  removeAll(): void {
    this.lastGen = Math.max(this.lastGen, this.pair()?.gen ?? 0);
    this.store.removeNs("auth");
    this.cached = null;
  }

  /** Контракт этапа 14 (`clear = removeNs("auth")`); то же, что `removeAll()`. */
  clear(): void {
    this.removeAll();
  }
}
