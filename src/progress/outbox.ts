import type { AppContext } from "../app/context.ts";

// Заглушка этапа 16; outbox marktime и «просмотрено» со сверкой (спец. §10.3, CM-01) — этап 19.
// Записи — kp.out.m_* и kp.out.w_*; ключ kp.out.overlay занят оверлеем прогресса (app/context.ts).

export class Outbox {
  private ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  start(): void {}

  async flush(): Promise<void> {}

  size(): number {
    return 0;
  }

  putMarktime(itemId: number, season: number, video: number, time: number): void {}

  async setWatched(itemId: number, season: number, video: number, desired: 0 | 1): Promise<"done" | "queued"> {
    return "queued";
  }
}
