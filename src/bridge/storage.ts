import type { Logger } from "../core/log.ts";

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
}

export type Ns = "auth" | "cfg" | "out" | "l2";

const TAG = "storage";

const prefix = (ns: Ns): string => `kp.${ns}.`;

// Chromium/Tizen: name "QuotaExceededError"; старый WebKit: code 22 с другим именем.
function isQuotaError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const x = e as { name?: unknown; code?: unknown };
  return x.name === "QuotaExceededError" || x.code === 22;
}

function errorName(e: unknown): string {
  const name = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
  return typeof name === "string" ? name : typeof e;
}

/**
 * Обёртка над localStorage с пространствами имён `kp.auth.*`, `kp.cfg.*`, `kp.out.*`, `kp.l2.*` (спец. §7.3, CM-05).
 * Метода clear нет намеренно: удаление только по префиксу.
 */
export class KvStore {
  private storage: StorageLike;
  private log: Logger | undefined;

  constructor(storage: StorageLike, log?: Logger) {
    this.storage = storage;
    this.log = log;
  }

  get<T>(ns: Ns, key: string): T | undefined {
    const full = prefix(ns) + key;
    const raw = this.storage.getItem(full);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.log?.warn(TAG, "bad_json", { key: full });
      return undefined;
    }
  }

  /** `undefined` удаляет ключ. Токены и настройки важнее кэша: при переполнении L2 удаляется (спец. §7.3, CR-12). */
  set(ns: Ns, key: string, value: unknown): boolean {
    const full = prefix(ns) + key;
    if (value === undefined) {
      this.storage.removeItem(full);
      return true;
    }
    const json = JSON.stringify(value);
    try {
      this.storage.setItem(full, json);
      return true;
    } catch (e) {
      if (!isQuotaError(e)) return this.failed(full, e);
      if (ns === "l2") {
        this.log?.debug(TAG, "l2_quota", { key: full });
        return false;
      }
    }
    this.removeNs("l2");
    this.log?.warn(TAG, "quota_purge_l2", { key: full });
    try {
      this.storage.setItem(full, json);
      return true;
    } catch (e) {
      return this.failed(full, e);
    }
  }

  remove(ns: Ns, key: string): void {
    this.storage.removeItem(prefix(ns) + key);
  }

  keys(ns: Ns): string[] {
    const p = prefix(ns);
    const out: string[] = [];
    for (let i = 0; i < this.storage.length; i++) {
      const k = this.storage.key(i);
      if (k !== null && k.startsWith(p)) out.push(k.slice(p.length));
    }
    return out;
  }

  removeNs(ns: Ns): void {
    const p = prefix(ns);
    for (const k of this.keys(ns)) this.storage.removeItem(p + k);
  }

  bytes(ns: Ns): number {
    const p = prefix(ns);
    let n = 0;
    for (const k of this.keys(ns)) {
      const v = this.storage.getItem(p + k) ?? "";
      n += (p.length + k.length + v.length) * 2;
    }
    return n;
  }

  private failed(full: string, e: unknown): false {
    this.log?.error(TAG, "set_failed", { key: full, error: errorName(e) });
    return false;
  }
}
