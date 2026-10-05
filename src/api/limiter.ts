import type { Clock, TimerId } from "../core/clock.ts";
import { KpError } from "../core/errors.ts";
import type { ReqClass } from "./transport.ts";

// Спец. §8.5, CNFR-18: 3 запроса переднего плана + 1 фоновый, не больше 5 стартов за любую секунду;
// после 429 или «ответа без CORS» — передний план по одному 30 с.
const FG_MAX = 3;
const BG_MAX = 1;
const RATE_MAX = 5;
const RATE_WINDOW_MS = 1000;
const SLOW_MS = 30_000;
const BG_DROP_AFTER_MS = 200;

interface Waiter {
  at: number;
  start(): void;
  drop(e: KpError): void;
}

export class Limiter {
  private clock: Clock;
  private queues: Record<ReqClass, Waiter[]> = { fg: [], bg: [] };
  private active: Record<ReqClass, number> = { fg: 0, bg: 0 };
  private starts: number[] = [];
  private slowUntil = Number.NEGATIVE_INFINITY;
  private wake: { id: TimerId; at: number } | undefined;
  private pumping = false;
  private pumpAgain = false;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  run<T>(cls: ReqClass, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const finish = (): void => {
        this.active[cls] -= 1;
        this.pump();
      };
      this.queues[cls].push({
        at: this.clock.perf(),
        drop: reject,
        start: () => {
          this.active[cls] += 1;
          this.starts.push(this.clock.perf());
          let p: Promise<T>;
          try {
            p = fn();
          } catch (e) {
            p = Promise.reject(e);
          }
          p.then(
            (v) => {
              finish();
              resolve(v);
            },
            (e: unknown) => {
              finish();
              reject(e);
            },
          );
        },
      });
      this.pump();
    });
  }

  /** 429 или ответ без CORS (спец. §5.3 п. 2): передний план — по одному 30 с; повторный вызов продлевает окно. */
  on429(): void {
    this.slowUntil = this.clock.perf() + SLOW_MS;
  }

  fgLimit(): number {
    return this.clock.perf() < this.slowUntil ? 1 : FG_MAX;
  }

  inFlight(): { fg: number; bg: number } {
    return { fg: this.active.fg, bg: this.active.bg };
  }

  private pump(): void {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        this.step();
      } while (this.pumpAgain);
    } finally {
      this.pumping = false;
    }
    this.scheduleWake();
  }

  private step(): void {
    const now = this.clock.perf();
    while (this.starts.length > 0 && (this.starts[0] as number) <= now - RATE_WINDOW_MS) this.starts.shift();
    const fg = this.queues.fg;
    const bg = this.queues.bg;
    // Передний план ждёт дольше 200 мс — фоновые из очереди отбрасываются (уже запущенные не трогаем).
    if (fg.length > 0 && bg.length > 0 && now - (fg[0] as Waiter).at >= BG_DROP_AFTER_MS) {
      for (const w of bg.splice(0)) w.drop(new KpError("KP-NET", "bg-dropped"));
    }
    while (fg.length > 0 && this.active.fg < this.fgLimit() && this.starts.length < RATE_MAX) {
      (fg.shift() as Waiter).start();
    }
    while (bg.length > 0 && this.active.bg < BG_MAX && this.starts.length < RATE_MAX) {
      (bg.shift() as Waiter).start();
    }
  }

  /** Один таймер на ближайший момент, когда очередь может сдвинуться без завершения запроса. */
  private scheduleWake(): void {
    const now = this.clock.perf();
    const fg = this.queues.fg;
    const bg = this.queues.bg;
    let at = Number.POSITIVE_INFINITY;
    if ((fg.length > 0 || bg.length > 0) && this.starts.length >= RATE_MAX) at = Math.min(at, (this.starts[0] as number) + RATE_WINDOW_MS);
    if (fg.length > 0 && this.slowUntil > now) at = Math.min(at, this.slowUntil);
    if (fg.length > 0 && bg.length > 0) at = Math.min(at, (fg[0] as Waiter).at + BG_DROP_AFTER_MS);
    if (this.wake !== undefined) {
      if (this.wake.at <= at) return;
      this.clock.clearTimeout(this.wake.id);
      this.wake = undefined;
    }
    if (at === Number.POSITIVE_INFINITY) return;
    const id = this.clock.setTimeout(() => {
      if (this.wake?.id === id) this.wake = undefined;
      this.pump();
    }, Math.max(0, at - now));
    this.wake = { id, at };
  }
}
