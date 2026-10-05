import type { Clock, TimerId } from "../core/clock.ts";
import { KpError } from "../core/errors.ts";
import type { Priority, ReqClass } from "./transport.ts";

// Спец. §8.5, CNFR-18: 3 запроса переднего плана + 1 фоновый, не больше 5 стартов за любую секунду;
// после 429 или «ответа без CORS» — передний план по одному 30 с.
const FG_MAX = 3;
const BG_MAX = 1;
const RATE_MAX = 5;
const RATE_WINDOW_MS = 1000;
const SLOW_MS = 30_000;
const BG_DROP_AFTER_MS = 200;

interface Waiter {
  cls: ReqClass;
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

  /** С `Priority` фоновая задача, пока ждёт в очереди, по `promote()` переходит в очередь переднего плана. */
  run<T>(cls: ReqClass | Priority, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let unwatch = (): void => {};
      const w: Waiter = {
        cls: typeof cls === "string" ? cls : cls.cls(),
        at: this.clock.perf(),
        drop: (e) => {
          unwatch();
          reject(e);
        },
        start: () => {
          unwatch();
          const c = w.cls;
          this.active[c] += 1;
          this.starts.push(this.clock.perf());
          const finish = (): void => {
            this.active[c] -= 1;
            this.pump();
          };
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
      };
      if (typeof cls !== "string" && w.cls === "bg") unwatch = cls.onPromote(() => this.promote(w));
      this.queues[w.cls].push(w);
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

  /**
   * Ждущая фоновая задача — в конец очереди переднего плана: его ожидание (порог сброса фоновых 200 мс) считается
   * с момента повышения, и как фоновая она больше не сбрасывается. Уже запущенную задачу не трогаем.
   */
  private promote(w: Waiter): void {
    const i = this.queues.bg.indexOf(w);
    if (i < 0) return;
    this.queues.bg.splice(i, 1);
    w.cls = "fg";
    w.at = this.clock.perf();
    this.queues.fg.push(w);
    this.pump();
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
