import type { AppContext } from "../app/context.ts";
import type { TimerId } from "../core/clock.ts";

const TAG = "progress";

/**
 * Запасной heartbeat, если тики плеера не работают (спец. §10.1, CDG-07): между `video:play` и `pause`/`stop`
 * раз в период спрашивает у MSX `requestData("video")` и отдаёт ответ трекеру как снимок.
 * Период — те же `heartbeatTicks` сборки в секундах (Р-26: 60, в e2e — 10).
 */
export class HeartbeatTimer {
  private ctx: AppContext;
  private timer: TimerId | undefined;
  /** Меняется на каждом `stop()`: ответ, запрошенный до остановки, уже не нужен. */
  private gen = 0;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  start(): void {
    if (this.timer === undefined) this.arm();
  }

  stop(): void {
    if (this.timer !== undefined) this.ctx.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.gen += 1;
  }

  private arm(): void {
    const periodMs = Math.max(1, this.ctx.build.heartbeatTicks) * 1000;
    this.timer = this.ctx.clock.setTimeout(() => this.tick(), periodMs);
  }

  private tick(): void {
    const gen = this.gen;
    this.arm();
    // Ответа может не быть вовсе (MSX не вызвала колбэк) — следующий тик уже запланирован.
    this.ctx.host.requestData("video")
      .then((data: unknown) => {
        if (gen === this.gen) this.ctx.tracker.onSnapshot(data, "timer");
      })
      .catch((e: unknown) => this.ctx.log.warn(TAG, "heartbeat_failed", { msg: e instanceof Error ? e.message : String(e) }));
  }
}
