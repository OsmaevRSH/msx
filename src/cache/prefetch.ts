import type { AppContext } from "../app/context.ts";
import type { TimerId } from "../core/clock.ts";
import { toKpError } from "../core/errors.ts";

// Префетч карточки по фокусу (спец. §8.3, CD-10; Plan B D-33): MSX шлёт `pf:<id>` из `selection.action` плитки на каждое
// движение фокуса. Карточка грузится фоном, только если фокус задержался на плитке, и не больше одной за раз.
// Метрики: `queued` — карточка поставлена в очередь, `dropped` — ждавшую полёта вытеснил новый фокус, `hit` — уже свежая.

const TAG = "prefetch";
/** Спец. §8.3: фокус на плитке ≥ 350 мс. */
const DEBOUNCE_MS = 350;
/**
 * Устаревшая карточка обновляется с ожиданием до таймаута `items/{id}` (15 с): иначе SWR сразу отдал бы кэш, и слот
 * префетча освободился бы, пока запрос ещё идёт.
 */
const FLIGHT_WAIT_MS = 15_000;

interface PrefetchState {
  /** Последний фокус, который ждёт 350 мс. */
  focused?: number;
  timer?: TimerId;
  /** Карточка в полёте — не больше одной. */
  flying?: number;
  /** Ждёт окончания полёта; новый фокус её вытесняет («побеждает последний»). */
  next?: number;
}

const states = new WeakMap<AppContext, PrefetchState>();

function stateOf(ctx: AppContext): PrefetchState {
  let st = states.get(ctx);
  if (st === undefined) {
    st = {};
    states.set(ctx, st);
  }
  return st;
}

/** Сообщение `pf:<id>` из `selection.action` плитки. */
export function onFocus(ctx: AppContext, id: number): void {
  if (ctx.flags.get().focusPrefetch === "off") return;
  const st = stateOf(ctx);
  if (st.timer !== undefined) ctx.clock.clearTimeout(st.timer);
  st.focused = id;
  st.timer = ctx.clock.setTimeout(() => settled(ctx, st), DEBOUNCE_MS);
}

function settled(ctx: AppContext, st: PrefetchState): void {
  const id = st.focused;
  st.timer = undefined;
  st.focused = undefined;
  if (id === undefined || id === st.flying || id === st.next) return;
  if (isFresh(ctx, id)) return;
  ctx.metrics.inc("focus_prefetch:queued");
  if (st.flying === undefined) {
    fly(ctx, st, id);
    return;
  }
  if (st.next !== undefined) ctx.metrics.inc("focus_prefetch:dropped");
  st.next = id;
}

function isFresh(ctx: AppContext, id: number): boolean {
  if (ctx.repo.peekItem(id)?.stale !== false) return false;
  ctx.metrics.inc("focus_prefetch:hit");
  return true;
}

function fly(ctx: AppContext, st: PrefetchState, id: number): void {
  st.flying = id;
  ctx.repo.item(id, { freshWithinMs: 0, waitMs: FLIGHT_WAIT_MS, cls: "bg" })
    .then(
      () => undefined,
      (e: unknown) => ctx.log.debug(TAG, "failed", { id, err: toKpError(e).code }),
    )
    .then(() => {
      st.flying = undefined;
      const next = st.next;
      st.next = undefined;
      if (next !== undefined && !isFresh(ctx, next)) fly(ctx, st, next);
    });
}
