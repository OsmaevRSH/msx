import type { AppContext } from "../app/context.ts";

// Заглушка этапа 16; heartbeat по таймеру через requestData("video") (спец. §10.1, CDG-07) — этап 19.

export class HeartbeatTimer {
  private ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  start(): void {}

  stop(): void {}
}
