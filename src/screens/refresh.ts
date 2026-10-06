import type { AppContext } from "../app/context.ts";
import { toKpError } from "../core/errors.ts";
import { fnv1a } from "../core/hash.ts";
import { replaceContent } from "../msx/actions.ts";
import { parseDataId } from "../router/ids.ts";
import { forgetHistory } from "./list.ts";

// Перерисовка персональных данных (спец. §6.3, §8.2; Plan B §7.7): экран, отданный из устаревших данных или оставшийся
// под плеером, заменяется `replace:content:<flag>`, только если его персональная часть изменилась и он всё ещё текущий.
// Флаги уникальны (Plan B M-01): MSX не выполнит замену с чужим флагом, даже если она запоздала.
// Метрики `refresh:*`: `replaced`, `unchanged`, `not_current`, `failed` — итог пересчёта; `busy` — повтор отброшен.

const TAG = "refresh";
/** Показанные экраны для `refreshAfterPlayback`; текущий — всегда последний показанный, запас — на возврат «Назад». */
const SHOWN_MAX = 8;

export interface RefreshSpec {
  dataId: string; flag: string; hash: string; recompute: () => Promise<string>;
  /** Элемент, который получает фокус после плеера, пока экран текущий (V-16: «▶» карточки, а не «С начала»). */
  focus?: string;
}

interface RefreshState {
  /** `dataId`, для которых пересчёт ещё идёт. */
  running: Set<string>;
  /** Спецификации показанных экранов: хеш — того, что сейчас на экране ТВ. */
  shown: Map<string, RefreshSpec>;
}

const states = new WeakMap<AppContext, RefreshState>();

function stateOf(ctx: AppContext): RefreshState {
  let st = states.get(ctx);
  if (st === undefined) {
    st = { running: new Set(), shown: new Map() };
    states.set(ctx, st);
  }
  return st;
}

/**
 * Экран отдан: запомнить хеш его персональной части и способ пересчёта. После воспроизведения экран под плеером
 * сравнивается именно с этим хешем — оверлей к тому времени уже содержит новую позицию.
 */
export function trackScreen(ctx: AppContext, spec: RefreshSpec): void {
  const { shown } = stateOf(ctx);
  shown.delete(spec.dataId);
  shown.set(spec.dataId, spec);
  for (const k of shown.keys()) {
    if (shown.size <= SHOWN_MAX) break;
    shown.delete(k);
  }
}

/** Пересчитать в фоне; новый хеш и экран всё ещё текущий → `replace:content`. Повтор для того же `dataId` в полёте — игнорируется. */
export function scheduleRefresh(ctx: AppContext, spec: RefreshSpec): void {
  const st = stateOf(ctx);
  if (st.running.has(spec.dataId)) {
    ctx.metrics.inc("refresh:busy");
    ctx.log.debug(TAG, "busy", { dataId: spec.dataId });
    return;
  }
  st.running.add(spec.dataId);
  run(ctx, st, spec).catch((e: unknown) => ctx.log.error(TAG, "failed", { dataId: spec.dataId, err: toKpError(e).code }));
}

async function run(ctx: AppContext, st: RefreshState, spec: RefreshSpec): Promise<void> {
  let hash: string;
  try {
    hash = await spec.recompute();
  } catch (e) {
    outcome(ctx, "failed", spec, { err: toKpError(e).code });
    return;
  } finally {
    st.running.delete(spec.dataId);
  }
  if (hash === spec.hash) return outcome(ctx, "unchanged", spec);
  // Спец. §6.3 (round-C1 Q5): асинхронная перерисовка — только текущего экрана.
  if (!ctx.current.isCurrent(spec.dataId)) return outcome(ctx, "not_current", spec);
  ctx.host.executeAction(replaceContent(spec.flag, ctx.P, spec.dataId));
  outcome(ctx, "replaced", spec);
}

function outcome(ctx: AppContext, kind: string, spec: RefreshSpec, data?: Record<string, unknown>): void {
  ctx.metrics.inc(`refresh:${kind}`);
  ctx.log.info(TAG, `${kind} ${spec.flag}`, { dataId: spec.dataId, ...data });
}

/**
 * После `stop` (кроме автоперехода, решает трекер): карточка и персональные списки помечаются устаревшими; экран
 * этого тайтла или главная, если он текущий, пересчитывается и при изменении заменяется (Plan B §9.2). Фокус —
 * сразу, до пересчёта: `replace:content` сохраняет фокус на элементе с тем же `id`.
 */
export function refreshAfterPlayback(ctx: AppContext, itemId: number): void {
  ctx.repo.invalidateAfterProgress(itemId);
  forgetHistory(ctx);
  const cur = ctx.current.get();
  if (cur === undefined || !showsTitle(cur, itemId)) return;
  const spec = stateOf(ctx).shown.get(cur);
  if (spec === undefined) {
    ctx.log.debug(TAG, "not_tracked", { dataId: cur });
    return;
  }
  if (spec.focus !== undefined) ctx.host.executeAction(`focus:${spec.focus}`);
  scheduleRefresh(ctx, spec);
}

function showsTitle(dataId: string, itemId: number): boolean {
  const r = parseDataId(dataId);
  return r.k === "home" || r.k === "watching" || ((r.k === "item" || r.k === "season") && r.id === itemId);
}

/** Хеш персональной части экрана (Plan B §7.7). */
export function personalHash(v: unknown): string {
  return fnv1a(JSON.stringify(v) ?? "");
}
