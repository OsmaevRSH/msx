import type { AppContext } from "../app/context.ts";

// Заглушка этапа 16; проверки пробника (спец. §16.2) — этап 20. Типы CheckId и CheckResult уже окончательные.

export type CheckId = "CDG-01" | "CDG-02" | "CDG-03" | "CDG-04" | "CDG-05" | "CDG-06" | "CDG-07" | "CDG-08" | "CDG-09" | "CDG-10" | "CDG-11" | "CDG-12";

export interface CheckResult { id: CheckId; ok: boolean | null; summary: string; values: Record<string, string | number | boolean>; at: number }

export class ProbeRunner {
  private ctx: AppContext;
  private byId = new Map<CheckId, CheckResult>();

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /** Вызывается из `App.ready()` при каждой загрузке плагина. */
  onReady(): void {}

  async run(id: CheckId): Promise<CheckResult> {
    return this.byId.get(id) ?? { id, ok: null, summary: "не запускалась", values: {}, at: this.ctx.clock.now() };
  }

  async runApi(): Promise<CheckResult[]> {
    return [];
  }

  results(): CheckResult[] {
    return [...this.byId.values()];
  }

  record(r: CheckResult): void {
    this.byId.set(r.id, r);
  }
}
