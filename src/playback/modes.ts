import type { AppContext } from "../app/context.ts";
import type { StreamMode } from "./prefs.ts";

export interface ChainStep { step: 1 | 2 | 3 | 4; mode: "hls1" | "hls2" | "none"; freshLinks: boolean }

/**
 * Plan B §5.11, D-27: повторный resolve того же `mid` без признака старта через ≥ 8 с — сбой прошлого запуска
 * (ошибка AVPlay при `tizen:buffer:timeout` 10 с появляется раньше). Быстрее — нетерпеливое нажатие, шаг тот же.
 */
export const RETRY_AFTER_MS = 8_000;

/** Записи по `mid` нужны минуты; сверх этого числа старые вытесняются. */
const MAX_ENTRIES = 64;

/** `auto` — цепочка `hls1` → `hls1` (свежие) → `hls2`; ручной режим или `streamMode: hls2` — без смены режима (Р-28). */
type Kind = "auto" | StreamMode;
type Step = ChainStep["step"];

interface Entry { step: Step; resolvedAt: number; started: boolean; kind: Kind }

function stepOf(kind: Kind, step: Step): ChainStep {
  if (step === 4) return { step: 4, mode: "none", freshLinks: false };
  if (kind === "auto" && step === 3) return { step: 3, mode: "hls2", freshLinks: true };
  return { step, mode: kind === "auto" ? "hls1" : kind, freshLinks: step === 2 };
}

/** После шага 4 (ошибка уже показана) следующая попытка начинает цепочку заново. */
function following(kind: Kind, step: Step): Step {
  if (step === 4) return 1;
  if (step === 2 && kind !== "auto") return 4;
  return (step + 1) as Step;
}

/** Цепочка fallback по `mid` (спец. §9.1, Plan B §5.11): шаг выбирается в момент resolve. */
export class FallbackChain {
  private ctx: AppContext;
  private entries = new Map<number, Entry>();

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /**
   * Нет записи, был старт или сменился режим — шаг 1; без старта ≥ 8 с — следующий шаг; быстрее — тот же.
   * `manual` — режим, выбранный для тайтла или ТВ: он отключает автоцепочку.
   */
  next(mid: number, manual?: StreamMode): ChainStep {
    const kind = this.kind(manual);
    const now = this.ctx.clock.perf();
    const e = this.live(mid, kind);
    const step = e === undefined ? 1 : now - e.resolvedAt >= RETRY_AFTER_MS ? following(kind, e.step) : e.step;
    return this.save(mid, { step, resolvedAt: now, started: false, kind });
  }

  /** Ошибка API при resolve (Plan B §5.11): сразу следующий шаг, без участия пользователя. */
  advance(mid: number, manual?: StreamMode): ChainStep {
    const kind = this.kind(manual);
    const from = this.live(mid, kind)?.step ?? 1;
    const step = from === 4 ? 4 : following(kind, from);
    return this.save(mid, { step, resolvedAt: this.ctx.clock.perf(), started: false, kind });
  }

  /** Признак старта (`video:play` или первый снимок позиции > 0, спец. §9.2) сбрасывает цепочку этого `mid`. */
  markStarted(mid: number): void {
    const e = this.entries.get(mid);
    if (e !== undefined) e.started = true;
  }

  private kind(manual?: StreamMode): Kind {
    if (manual !== undefined) return manual;
    return this.ctx.flags.get().streamMode === "hls2" ? "hls2" : "auto";
  }

  /** Запись незавершённой попытки в том же режиме. */
  private live(mid: number, kind: Kind): Entry | undefined {
    const e = this.entries.get(mid);
    return e !== undefined && !e.started && e.kind === kind ? e : undefined;
  }

  private save(mid: number, e: Entry): ChainStep {
    this.entries.delete(mid);
    this.entries.set(mid, e);
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return stepOf(e.kind, e.step);
  }
}
