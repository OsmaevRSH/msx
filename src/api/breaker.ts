import type { Clock } from "../core/clock.ts";

// Спец. §8.5 (Plan B NFR-13/14): после 5 сетевых сбоев подряд — пауза 15 с, затем одна проба.
const FAILURES_TO_OPEN = 5;
const OPEN_MS = 15_000;

export class Breaker {
  private clock: Clock;
  private failures = 0;
  private openedAt: number | undefined;
  private probeAt: number | undefined;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** В состоянии `half` пропускает одну пробу; если проба не отчиталась за 15 с — следующую. */
  allow(): boolean {
    const s = this.state();
    if (s === "closed") return true;
    if (s === "open") return false;
    const now = this.clock.perf();
    if (this.probeAt !== undefined && now - this.probeAt < OPEN_MS) return false;
    this.probeAt = now;
    return true;
  }

  success(): void {
    this.failures = 0;
    this.openedAt = undefined;
    this.probeAt = undefined;
  }

  failure(): void {
    const s = this.state();
    this.failures += 1;
    if (s === "half" || (s === "closed" && this.failures >= FAILURES_TO_OPEN)) {
      this.openedAt = this.clock.perf();
      this.probeAt = undefined;
    }
  }

  state(): "closed" | "open" | "half" {
    if (this.openedAt === undefined) return "closed";
    return this.clock.perf() - this.openedAt >= OPEN_MS ? "half" : "open";
  }
}
