import type { Clock } from "../core/clock.ts";
import { type KpErrorCode, toKpError } from "../core/errors.ts";
import type { Logger } from "../core/log.ts";
import { type L2, sizeOf } from "./l2.ts";
import type { Entry, Lru } from "./lru.ts";

/** `staleMaxMs` отсчитывается от `fetchedAt`, как и `ttlMs` (Plan B §7.2). */
export interface Policy {
  ttlMs: number;
  staleMaxMs: number;
  persist: boolean;
}

export interface Got<T> {
  value: T;
  fetchedAt: number;
  stale: boolean;
  source: "l1" | "l2" | "net";
  offline?: KpErrorCode;
}

type Hit = { e: Entry<unknown>; source: "l1" | "l2" };

const TAG = "swr";
/** Сбоев по ключам не больше этого: сессия на ТВ без сети длится часами (CNFR-17). */
const DOWN_MAX = 256;

function got<T>(hit: Hit, stale: boolean): Got<T> {
  return { value: hit.e.value as T, fetchedAt: hit.e.fetchedAt, stale, source: hit.source };
}

/**
 * Stale-while-revalidate поверх L1 и L2 (спец. §8.1–8.2, Plan B §7.2–7.3): закэшированное отдаётся сразу,
 * устаревшее обновляется в фоне, ждать загрузку — только при пустом кэше. Загрузка одна на ключ (single-flight).
 * Инвалидация — пометка «устаревшее», а не удаление.
 */
export class SwrCache {
  private l1: Lru;
  private l2: L2;
  private clock: Clock;
  private log: Logger;
  private flights = new Map<string, Promise<Entry<unknown>>>();
  /** Ключи, помеченные устаревшими, пока по ним шла загрузка: её результат сохраняется уже помеченным. */
  private dirty = new Set<string>();
  /** Пометки этой сессии: значение L2, сохранённое до пометки, поднимается в L1 уже устаревшим. */
  private marks = new Map<string, number>();
  /** Ключи, последняя загрузка которых не удалась, и код сбоя; успешная загрузка ключ снимает. */
  private down = new Map<string, KpErrorCode>();

  constructor(deps: { l1: Lru; l2: L2; clock: Clock; log: Logger }) {
    this.l1 = deps.l1;
    this.l2 = deps.l2;
    this.clock = deps.clock;
    this.log = deps.log;
  }

  async get<T>(
    key: string,
    policy: Policy,
    load: () => Promise<T>,
    opts?: { onRefreshed?: (v: T) => void; force?: boolean },
  ): Promise<Got<T>> {
    if (opts?.force !== true) {
      const hit = this.lookup(key, policy.persist);
      if (hit !== undefined) {
        if (this.fresh(hit.e, policy)) return got(hit, false);
        if (this.clock.now() - hit.e.fetchedAt < policy.staleMaxMs) {
          this.refresh(key, policy, load, opts?.onRefreshed);
          return got(hit, true);
        }
        // X-1: сеть по этому ключу уже отказала — запись старше stale-max отдаётся сразу, сеть ждёт только фон.
        // Иначе каждый показ и каждая сверка экрана снова ждали бы сбоя (до 9,5 с). stale-max 0 — не отдаётся никогда.
        const off = this.down.get(key);
        if (off !== undefined && policy.staleMaxMs > 0) {
          this.refresh(key, policy, load, opts?.onRefreshed);
          return { ...got<T>(hit, true), offline: off };
        }
      }
    }
    try {
      const e = await this.flight(key, policy, load);
      return { value: e.value as T, fetchedAt: e.fetchedAt, stale: e.staleMarked, source: "net" };
    } catch (err) {
      const k = toKpError(err);
      const hit = this.lookup(key, policy.persist);
      if (hit === undefined) throw k;
      return { ...got<T>(hit, !this.fresh(hit.e, policy)), offline: k.code };
    }
  }

  /** Без загрузки и без политики: `stale` здесь — только пометка, свежесть по TTL проверяет вызывающий по `fetchedAt`. */
  peek<T>(key: string): Got<T> | undefined {
    const e = this.l1.peek(key);
    const hit: Hit | undefined = e !== undefined ? { e, source: "l1" } : this.promote(key);
    return hit === undefined ? undefined : got(hit, hit.e.staleMarked);
  }

  /** Помечает устаревшими записи, ключ которых начинается с `keyPrefix`; ничего не удаляет. */
  markStale(keyPrefix: string): void {
    for (const k of this.l1.keys()) {
      if (!k.startsWith(keyPrefix)) continue;
      const e = this.l1.peek(k);
      if (e !== undefined) e.staleMarked = true;
    }
    for (const k of this.flights.keys()) {
      if (k.startsWith(keyPrefix)) this.dirty.add(k);
    }
    this.marks.set(keyPrefix, this.clock.now());
  }

  /** Ключи L2 с префиксом, от старых к новым (лимиты числа записей, спец. §8.1). */
  persistedKeys(prefix: string): string[] {
    return this.l2.keys(prefix);
  }

  delete(key: string): void {
    this.l1.delete(key);
    this.l2.remove(key);
    if (this.flights.has(key)) this.dirty.add(key);
  }

  private fresh(e: Entry<unknown>, policy: Policy): boolean {
    return !e.staleMarked && this.clock.now() - e.fetchedAt < policy.ttlMs;
  }

  private lookup(key: string, persist: boolean): Hit | undefined {
    const e = this.l1.get(key);
    if (e !== undefined) return { e, source: "l1" };
    return persist ? this.promote(key) : undefined;
  }

  private promote(key: string): Hit | undefined {
    const r = this.l2.get<unknown>(key);
    if (r === undefined) return undefined;
    const e: Entry<unknown> = { value: r.value, bytes: r.bytes, fetchedAt: r.savedAt, staleMarked: this.markedSince(key, r.savedAt) };
    this.l1.set(key, e);
    return { e, source: "l2" };
  }

  private markedSince(key: string, savedAt: number): boolean {
    for (const [prefix, at] of this.marks) {
      if (at >= savedAt && key.startsWith(prefix)) return true;
    }
    return false;
  }

  private refresh<T>(key: string, policy: Policy, load: () => Promise<T>, onRefreshed?: (v: T) => void): void {
    this.flight(key, policy, load).then(
      (e) => {
        if (onRefreshed === undefined) return;
        try {
          onRefreshed(e.value as T);
        } catch (err) {
          this.log.warn(TAG, "on_refreshed_failed", { key, error: toKpError(err).message });
        }
      },
      () => {
        // сбой уже записан в журнал в settle; устаревшая запись остаётся
      },
    );
  }

  private flight<T>(key: string, policy: Policy, load: () => Promise<T>): Promise<Entry<unknown>> {
    const cur = this.flights.get(key);
    if (cur !== undefined) return cur;
    this.dirty.delete(key);
    let started: Promise<T>;
    try {
      started = load();
    } catch (err) {
      started = Promise.reject(err);
    }
    const p = this.settle(key, policy, started);
    this.flights.set(key, p);
    return p;
  }

  private async settle<T>(key: string, policy: Policy, started: Promise<T>): Promise<Entry<unknown>> {
    try {
      const value = await started;
      const e: Entry<unknown> = { value, bytes: sizeOf(value), fetchedAt: this.clock.now(), staleMarked: this.dirty.has(key) };
      this.l1.set(key, e);
      if (policy.persist) this.l2.put(key, value);
      this.down.delete(key);
      return e;
    } catch (err) {
      const code = toKpError(err).code;
      this.down.delete(key);
      this.down.set(key, code);
      if (this.down.size > DOWN_MAX) this.down.delete(this.down.keys().next().value ?? key);
      // Ключ `err`: `code` журнал маскирует (CNFR-20).
      this.log.warn(TAG, "load_failed", { key, err: code });
      throw err;
    } finally {
      this.flights.delete(key);
      this.dirty.delete(key);
    }
  }
}
