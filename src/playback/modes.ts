import type { AppContext } from "../app/context.ts";

// Заглушка этапа 16; цепочка fallback (Plan B §5.11, D-27) — этап 18.

export interface ChainStep { step: 1 | 2 | 3 | 4; mode: "hls1" | "hls2" | "none"; freshLinks: boolean }

export class FallbackChain {
  private ctx: AppContext;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  next(mid: number, manual?: "hls1" | "hls2"): ChainStep {
    return { step: 1, mode: "hls1", freshLinks: false };
  }

  markStarted(mid: number): void {}
}
