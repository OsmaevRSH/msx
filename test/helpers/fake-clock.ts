import { subscribe } from "node:diagnostics_channel";
import { setImmediate as nextTurn, setTimeout as realSleep } from "node:timers/promises";
import type { Clock, TimerId } from "../../src/core/clock.ts";

/** 2026-01-01T00:00:00Z — стартовое `now()` по умолчанию. */
export const FAKE_EPOCH = Date.UTC(2026, 0, 1);

interface FakeTimer {
  id: TimerId;
  at: number;
  fn: () => void;
}

const MAX_FIRES_AT_SAME_TIME = 10_000;
const IDLE_REAL_LIMIT_MS = 10_000;

// Сколько запросов глобального fetch (undici) сейчас в полёте: runUntilSettled даёт им
// дойти до конца, прежде чем перевести поддельное время к следующему таймеру.
let fetchInFlight = 0;
const fetchDone = (): void => {
  fetchInFlight = Math.max(0, fetchInFlight - 1);
};
subscribe("undici:request:create", () => {
  fetchInFlight++;
});
subscribe("undici:request:trailers", fetchDone);
subscribe("undici:request:error", fetchDone);

/**
 * Поддельные часы для тестов. `now()` и `perf()` идут вместе и двигаются только через
 * `advance()` или `runUntilSettled()`.
 */
export class FakeClock implements Clock {
  /** Реальная пауза для ввода-вывода перед переходом к следующему таймеру. */
  ioPauseMs = 2;
  /**
   * Сколько реального времени ждать запросы fetch в полёте перед переходом к таймеру.
   * Ответ mock медленнее этого (например, `delayMs: 600`) считается «долгим»: поддельные таймеры его обгоняют.
   */
  ioGraceMs = 250;

  private nowStart: number;
  private perfStart: number;
  private elapsed = 0;
  private nextId = 1;
  private timers = new Map<TimerId, FakeTimer>();

  constructor(start: number = FAKE_EPOCH, perfStart = 1000) {
    this.nowStart = start;
    this.perfStart = perfStart;
  }

  now(): number {
    return this.nowStart + this.elapsed;
  }

  perf(): number {
    return this.perfStart + this.elapsed;
  }

  setTimeout(fn: () => void, ms: number): TimerId {
    const id = this.nextId++;
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
    this.timers.set(id, { id, at: this.elapsed + delay, fn });
    return id;
  }

  clearTimeout(id: TimerId): void {
    this.timers.delete(id);
  }

  /** Число запланированных таймеров. */
  pending(): number {
    return this.timers.size;
  }

  /** Сдвигает время на `ms`; просроченные таймеры срабатывают по очереди, между ними — `setImmediate`. */
  async advance(ms: number): Promise<void> {
    const target = this.elapsed + Math.max(0, ms);
    await nextTurn();
    const loop = this.loopGuard();
    for (let t = this.nextTimer(); t !== undefined && t.at <= target; t = this.nextTimer()) {
      loop(t);
      this.fire(t);
      await nextTurn();
    }
    this.elapsed = target;
  }

  /**
   * Пока `p` не завершён: сбросить микрозадачи и ввод-вывод (`setImmediate` + реальная пауза,
   * плюс ожидание fetch в полёте до `ioGraceMs`), затем перейти к ближайшему таймеру.
   * Бросает, если ближайший таймер дальше `maxMs` поддельного времени от старта.
   */
  async runUntilSettled<T>(p: Promise<T>, maxMs = 120_000): Promise<T> {
    let settled = false;
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    const deadline = this.elapsed + maxMs;
    const loop = this.loopGuard();
    let idleSince = Date.now();
    for (;;) {
      await this.flushIo(() => settled);
      if (settled) return p;
      const t = this.nextTimer();
      if (t === undefined) {
        if (Date.now() - idleSince > IDLE_REAL_LIMIT_MS) {
          throw new Error(`runUntilSettled: no fake timers and the promise is still pending after ${IDLE_REAL_LIMIT_MS} ms of real time`);
        }
        continue;
      }
      idleSince = Date.now();
      if (t.at > deadline) {
        throw new Error(`runUntilSettled: the promise did not settle within ${maxMs} ms of fake time`);
      }
      loop(t);
      this.fire(t);
    }
  }

  private async flushIo(settled: () => boolean): Promise<void> {
    await nextTurn();
    await realSleep(this.ioPauseMs);
    const started = Date.now();
    while (fetchInFlight > 0 && !settled() && Date.now() - started < this.ioGraceMs) {
      await realSleep(this.ioPauseMs);
    }
    await nextTurn();
  }

  private nextTimer(): FakeTimer | undefined {
    let best: FakeTimer | undefined;
    for (const t of this.timers.values()) {
      if (best === undefined || t.at < best.at || (t.at === best.at && t.id < best.id)) best = t;
    }
    return best;
  }

  private fire(t: FakeTimer): void {
    this.timers.delete(t.id);
    if (t.at > this.elapsed) this.elapsed = t.at;
    t.fn();
  }

  /** Защита от таймера, который бесконечно перезапускает себя с нулевой задержкой. */
  private loopGuard(): (t: FakeTimer) => void {
    let lastAt = -1;
    let count = 0;
    return (t) => {
      count = t.at === lastAt ? count + 1 : 0;
      lastAt = t.at;
      if (count > MAX_FIRES_AT_SAME_TIME) {
        throw new Error(`FakeClock: more than ${MAX_FIRES_AT_SAME_TIME} timers fired at the same moment — timer loop?`);
      }
    };
  }
}
