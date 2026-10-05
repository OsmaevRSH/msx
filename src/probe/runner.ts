import type { AppContext } from "../app/context.ts";
import { toKpError } from "../core/errors.ts";
import { checkApi, checkCors, checkOauthPost, checkPostBody, checkProgress } from "./checks-api.ts";
import {
  checkColdStart, checkStorage, coldOnReady, fillInit, loadResults, persistOnReady, persistWrite, result, saveResults,
} from "./store.ts";

// Пробник Phase 0 (спец. §16.2). Проверки уровня API, хранилища и холодного старта — здесь (этап 20);
// CDG-05…07, 11, 12 записывает по событиям плеера этап 23 через `record`.

export type CheckId = "CDG-01" | "CDG-02" | "CDG-03" | "CDG-04" | "CDG-05" | "CDG-06" | "CDG-07" | "CDG-08" | "CDG-09" | "CDG-10" | "CDG-11" | "CDG-12";

export interface CheckResult { id: CheckId; ok: boolean | null; summary: string; values: Record<string, string | number | boolean>; at: number }

export const CHECK_IDS: readonly CheckId[] = [
  "CDG-01", "CDG-02", "CDG-03", "CDG-04", "CDG-05", "CDG-06", "CDG-07", "CDG-08", "CDG-09", "CDG-10", "CDG-11", "CDG-12",
];
/** Порядок `runApi()`. */
export const API_CHECKS: readonly CheckId[] = ["CDG-01", "CDG-02", "CDG-03", "CDG-04", "CDG-08", "CDG-09", "CDG-10"];

const TAG = "probe";

export class ProbeRunner {
  private ctx: AppContext;
  private byId: Map<CheckId, CheckResult> | undefined;
  private running = new Map<CheckId, Promise<CheckResult>>();

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /** Вызывается из `App.ready()` при каждой загрузке плагина: замер холодного старта (CDG-10) и маркер хранилища (CDG-09). */
  onReady(): void {
    coldOnReady(this.ctx);
    persistOnReady(this.ctx);
  }

  /** Повторный запуск той же проверки, пока идёт прежний, получает её результат. */
  run(id: CheckId): Promise<CheckResult> {
    let p = this.running.get(id);
    if (p === undefined) {
      p = this.exec(id).finally(() => this.running.delete(id));
      this.running.set(id, p);
    }
    return p;
  }

  async runApi(): Promise<CheckResult[]> {
    const out: CheckResult[] = [];
    for (const id of API_CHECKS) out.push(await this.run(id));
    return out;
  }

  /** Последний результат каждой проверки (переживает перезапуск: `kp.cfg.probe.results`), по номеру проверки. */
  results(): CheckResult[] {
    fillInit(this.ctx);
    const byId = this.load();
    return CHECK_IDS.flatMap((id) => {
      const r = byId.get(id);
      return r === undefined ? [] : [r];
    });
  }

  record(r: CheckResult): void {
    const byId = this.load();
    byId.set(r.id, r);
    saveResults(this.ctx.store, Object.fromEntries(byId));
  }

  /** Кнопка «Записать маркер хранилища» (CDG-09): `kp.auth.probeMarker` и ~1 МБ в `kp.l2.probe.*`. */
  persistWrite(): void {
    persistWrite(this.ctx);
  }

  // --- Внутреннее ---

  private load(): Map<CheckId, CheckResult> {
    if (this.byId === undefined) {
      const saved = loadResults(this.ctx.store);
      this.byId = new Map(CHECK_IDS.flatMap((id) => {
        const r = saved[id];
        return r === undefined ? [] : [[id, r] as const];
      }));
    }
    return this.byId;
  }

  private async exec(id: CheckId): Promise<CheckResult> {
    const { ctx } = this;
    fillInit(ctx);
    let r: CheckResult;
    try {
      const fresh = await this.check(id);
      if (fresh === undefined) return this.load().get(id) ?? result(ctx, id, null, "не запускалась");
      r = fresh;
    } catch (e) {
      const err = toKpError(e);
      r = result(ctx, id, false, `ошибка ${err.code}`, { code: err.code });
    }
    ctx.log.info(TAG, `${id} ${r.ok === true ? "ok" : r.ok === false ? "fail" : "skip"}`, { summary: r.summary });
    // «Нужен вход» не затирает прежний результат: отчёт после «Выйти» остаётся полным.
    if (r.ok !== null || !this.load().has(id)) this.record(r);
    return r;
  }

  /** `undefined` — проверка уровня ТВ (этап 23): отвечает только сохранённый результат. */
  private check(id: CheckId): Promise<CheckResult> | CheckResult | undefined {
    const { ctx } = this;
    switch (id) {
      case "CDG-01": return checkCors(ctx);
      case "CDG-02": return checkOauthPost(ctx);
      case "CDG-03": return checkPostBody(ctx);
      case "CDG-04": return checkApi(ctx);
      case "CDG-08": return checkProgress(ctx);
      case "CDG-09": return checkStorage(ctx);
      case "CDG-10": return checkColdStart(ctx);
      default: return undefined;
    }
  }
}
