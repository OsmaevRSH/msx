import type { AppContext } from "../app/context.ts";
import type { TimerId } from "../core/clock.ts";
import { numberFrom, positionFrom, propsFrom } from "../progress/samples.ts";
import { KP_PROPS } from "../progress/session.ts";

/**
 * ◀◀/▶▶ и ⏪/⏩ пульта (спец. §9.4). Относительный `player:seek:±N` MSX молча отбрасывает, пока плеер буферизует
 * (`tvx-app` 0.1.167: проверка «занят» в обработчике seek), а AVPlay буферизует после каждого перехода и после
 * «Продолжить» — нажатия в это время терялись. У абсолютного `player:seek:<с>` такой проверки нет, поэтому позицию
 * берёт плагин (`requestData("video")`) и переходит на неё ± шаг.
 */

const TAG = "seek";
/** Нажатия чаще этого складываются в один переход: AVPlay не принимает seekTo, пока не закончил прежний. */
export const SEEK_BURST_MS = 400;
/** Столько после перехода плеер может ещё показывать прежнюю позицию: AVPlay заново буферизует поток. */
export const SEEK_SETTLE_MS = 10_000;
/** Позиция MSX (`requestData("video")`) округлена и обновляется раз в секунду. */
const SLACK_SEC = 2;

const RESUME_PROP = "resume:position";

interface Last { target: number; at: number; run?: string }

const runOf = (data: unknown): string | undefined => {
  const r = propsFrom(data)?.[KP_PROPS.run];
  return typeof r === "string" ? r : undefined;
};

export class Seeker {
  private ctx: AppContext;
  /** Окно склейки нажатий: пока оно открыто, шаги копятся в `acc` и уходят одним переходом в его конце. */
  private quiet: TimerId | undefined;
  private acc = 0;
  private last: Last | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /**
   * Переходы без нажатия: «Продолжить» (`resume:position` в `video:load`) и `video:seek` MSX (маркер ← →, свои
   * переходы). Позиция MSX обновляется раз в секунду, а AVPlay ещё буферизует — ◀◀ сразу после них считалось бы от
   * прежнего места. Цель `video:seek` — в `position` события; в `data` — снимок до перехода.
   */
  onEvent(ev: Record<string, unknown>): void {
    if (ev.event === "video:seek") {
      const target = numberFrom(ev.position);
      // Запуск без сессии трекера (её ещё нет) — тот же, что у прошлого перехода.
      if (target !== undefined && target >= 0) this.moved(target, this.ctx.tracker.session()?.run ?? this.last?.run);
      return;
    }
    const props = propsFrom(ev);
    const resume = numberFrom(props?.[RESUME_PROP]);
    if (resume !== undefined && resume > 0) this.moved(resume, runOf(ev));
  }

  private moved(target: number, run: string | undefined): void {
    const at = this.ctx.clock.now();
    this.last = run === undefined ? { target, at } : { target, at, run };
  }

  /** Нажатие: шаг со знаком, с. Первое уходит сразу, следующие в пределах `SEEK_BURST_MS` — вместе после паузы. */
  press(delta: number): void {
    const open = this.quiet !== undefined;
    this.arm();
    if (open) this.acc += delta;
    else this.enqueue(delta);
  }

  private arm(): void {
    if (this.quiet !== undefined) this.ctx.clock.clearTimeout(this.quiet);
    this.quiet = this.ctx.clock.setTimeout(() => this.settle(), SEEK_BURST_MS);
  }

  private settle(): void {
    this.quiet = undefined;
    const delta = this.acc;
    this.acc = 0;
    if (delta === 0) return;
    this.arm();
    this.enqueue(delta);
  }

  private enqueue(delta: number): void {
    this.queue = this.queue
      .then(() => this.jump(delta))
      .catch((e: unknown) => this.ctx.log.error(TAG, "seek_failed", { msg: e instanceof Error ? e.message : String(e) }));
  }

  private async jump(delta: number): Promise<void> {
    const data = await this.ctx.host.requestData("video").catch(() => undefined);
    const pos = positionFrom(data).position;
    if (pos === undefined) {
      // Позиции нет — переход MSX от её позиции: хуже, чем свой, но не ничего.
      this.last = undefined;
      this.ctx.log.warn(TAG, "no_position", { delta });
      this.ctx.host.executeAction(`player:seek:${delta < 0 ? "-" : "+"}${Math.abs(delta)}`);
      return;
    }
    const run = runOf(data);
    const base = this.base(pos, run);
    // Отрицательное число MSX прочла бы как шаг назад, а не как позицию; за длительность MSX не уйдёт сама.
    const target = Math.max(0, Math.round(base + delta));
    this.ctx.host.executeAction(`player:seek:${target}`);
    this.moved(target, run);
    this.ctx.log.info(TAG, "seek", { pos, base, delta, target });
  }

  /**
   * От чего отсчитывать шаг: от позиции плеера, а пока прошлый переход того же запуска не виден в ней (AVPlay ещё
   * буферизует) — от его цели, иначе второе нажатие повторило бы первое.
   */
  private base(pos: number, run: string | undefined): number {
    const l = this.last;
    if (l === undefined || l.run !== run) return pos;
    const sec = (this.ctx.clock.now() - l.at) / 1000;
    if (sec > SEEK_SETTLE_MS / 1000) return pos;
    return pos >= l.target - SLACK_SEC && pos <= l.target + sec + SLACK_SEC ? pos : l.target;
  }
}
