import type { AppContext } from "../app/context.ts";
import type { HistoryEntry, ItemSummary } from "../api/models.ts";
import type { ReqClass } from "../api/transport.ts";
import { cacheKeys } from "../cache/repo.ts";
import type { Got } from "../cache/swr.ts";
import { sleep } from "../core/clock.ts";
import type { Clock } from "../core/clock.ts";
import { fmtDate, ruTitle } from "../core/format.ts";
import { commitMsg, contentAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentPage, MsxContentRoot } from "../msx/types.ts";
import { NO_SUBSCRIPTION_TEXT } from "../playback/resolve.ts";
import { encodeListKey, ids, msgs } from "../router/ids.ts";
import { buildContinue } from "./continue.ts";
import { RETRY_CONTENT, errorItems } from "./error.ts";
import { MAX_BYTES, bytes } from "./list.ts";
import { personalHash, scheduleRefresh, trackScreen } from "./refresh.ts";
import { posterTiles } from "./tiles.ts";

// Главная S4 (спец. §8.4, §11; Plan B S4, D-34, D-40). Всё, что есть в кэше, отдаётся сразу, персональное — с оверлеем
// прогресса ТВ; KinoPub ждём, только если из кэша показать нечего, и не дольше 1,5 с (CNFR-05). Недостающие полки и
// устаревшие персональные данные догружаются фоном, экран заменяется `replace:content:home`, только если изменилась его
// персональная часть или набор полок (спец. §6.3). Показ, которого ждёт пользователь, — передний план; прогрев, фоновые
// сверки и обновление подборок из кэша — `bg`, чтобы не отнимать слоты у действий пользователя (спец. §8.3–8.5).

const FLAG = "home";
const DEADLINE_MS = 1500;
/** D-40: устаревшие персональные данные обновляются фоном, экран сверяется через 3 с. */
const RECHECK_MS = 3000;
const TILES = 7;
/** Р-22: у «Продолжить» нет «Ещё» — до 8 плиток. */
const CONTINUE_TILES = 8;
const WIDTH = 16;
const TEMPLATE: MsxContentItem = { type: "default", color: "msx-glass", imageFiller: "cover", round: true };

const T = {
  title: "Главная",
  more: "Ещё →",
  pcs: "шт.",
  retry: "Повторить",
  loading: "Загружаю полки KinoPub…",
  empty: "Пока здесь пусто",
  warning: "{ico:msx-yellow:warning}",
};

type Kind = "continue" | "bookmarks" | "fresh" | "popular" | "hot";
type ReqOpts = { cls: ReqClass };
const FG: ReqOpts = { cls: "fg" };
const BG: ReqOpts = { cls: "bg" };
interface Def { id: string; title: string; kind: Kind; type?: string }

/** Plan B S4: порядок — и на экране, и в очереди запросов холодной сборки (спец. §8.4 п. 2). */
const DEFS: readonly Def[] = [
  { id: "c", title: "Продолжить просмотр", kind: "continue" },
  { id: "fm", title: "Новые фильмы", kind: "fresh", type: "movie" },
  { id: "fs", title: "Новые сериалы", kind: "fresh", type: "serial" },
  { id: "b", title: "Закладки", kind: "bookmarks" },
  { id: "pm", title: "Популярные фильмы", kind: "popular", type: "movie" },
  { id: "ps", title: "Популярные сериалы", kind: "popular", type: "serial" },
  { id: "hm", title: "Горячее: фильмы", kind: "hot", type: "movie" },
  { id: "hs", title: "Горячее: сериалы", kind: "hot", type: "serial" },
];

/** Плитки без `layout`; `personal` — вклад полки в хеш (Plan B §7.7), `stale` — персональные данные устарели. */
interface Shelf { def: Def; tiles: MsxContentItem[]; personal?: unknown; stale: boolean }
interface Snap { shelves: Shelf[]; pending: boolean; stale: boolean; err?: unknown }

/**
 * Последняя сборка: упали все полки. Пока ни одна полка не пришла, вместо «Загружаю» показывается эта ошибка: иначе
 * «Загружаю» → (ошибка) → замена → «Загружаю» шли бы по кругу, ведь повторы запросов дольше срока ответа.
 */
const failures = new WeakMap<AppContext, unknown>();
const noop = (): void => undefined;
const pct = (p: number): number => Math.round(p * 100) / 100;

/** Префетч карточки по фокусу (спец. §8.3): в `pages` нет `{context:…}`, поэтому id — явно в каждой плитке. */
function focus(ctx: AppContext, t: MsxContentItem, id: number): MsxContentItem {
  if (ctx.flags.get().focusPrefetch === "on") t.selection = { action: commitMsg(msgs.pf(id)) };
  return t;
}

const withMore = (ctx: AppContext, d: Def, tiles: MsxContentItem[], dataId: string): MsxContentItem[] =>
  tiles.length === 0 ? [] : [...tiles, { id: `${d.id}_more`, title: T.more, action: contentAction(ctx.P, dataId) }];

function titles(ctx: AppContext, d: Def, items: ItemSummary[]): MsxContentItem[] {
  return posterTiles(ctx, items).map((t, i) => {
    const id = items[i]?.id ?? 0;
    delete t.kid;
    t.id = `${d.id}${id}`;
    return focus(ctx, t, id);
  });
}

const ok = <V>(r: PromiseSettledResult<Got<V>>): Got<V> | undefined => (r.status === "fulfilled" ? r.value : undefined);

async function continueShelf(ctx: AppContext, d: Def, o: ReqOpts): Promise<Shelf> {
  const [h, s] = await Promise.allSettled([ctx.repo.history(o), ctx.repo.serials(o)]);
  if (h.status === "rejected" && s.status === "rejected") throw h.reason;
  const hist = ok(h)?.value ?? [];
  // Фильмы в просмотре нужны, только если история пуста (Plan B §8.3.1 п. 4).
  const m = hist.length === 0 ? await ctx.repo.watchingMovies(o).catch(noop) : undefined;
  const items = buildContinue(hist, ok(s)?.value ?? [], m?.value ?? [], ctx.overlay.get, (id) => ctx.overlay.forItem(id))
    .slice(0, CONTINUE_TILES);
  const size = ctx.prefs.get().posterSize;
  const tiles = items.map((c) => {
    const t: MsxContentItem = {
      id: `${d.id}${c.id}`, title: ruTitle(c.title), image: c.posters[size] || c.posters.medium,
      action: contentAction(ctx.P, ids.item(c.id)), tag: c.tag, badge: c.badge, stamp: c.stamp,
    };
    if (c.progress !== undefined) Object.assign(t, { progress: pct(c.progress), progressColor: "msx-blue" });
    return focus(ctx, t, c.id);
  });
  return {
    def: d, tiles, personal: tiles.map((t) => [t.id, t.progress, t.tag, t.badge]),
    // Источник не ответил — тоже повод сверить экран позже.
    stale: h.status === "rejected" || s.status === "rejected" || [ok(h), ok(s), m].some((g) => g?.stale === true),
  };
}

async function loadShelf(ctx: AppContext, d: Def, o: ReqOpts): Promise<Shelf> {
  if (d.kind === "continue") return continueShelf(ctx, d, o);
  if (d.kind === "bookmarks") {
    const g = await ctx.repo.bookmarkFolders(o);
    const folders = g.value.slice(0, TILES);
    const tiles = folders.map((f): MsxContentItem => ({
      id: `${d.id}${f.id}`, icon: "bookmark", title: f.title, titleFooter: `${f.count} ${T.pcs}`,
      action: contentAction(ctx.P, ids.list(encodeListKey({ src: "folder", folder: f.id }))),
    }));
    return { def: d, tiles: withMore(ctx, d, tiles, ids.bookmarks()), personal: folders.map((f) => [f.id, f.count]), stale: g.stale };
  }
  const type = d.type ?? "";
  // Спец. §8.4 п. 1: подборку из кэша пользователь не ждёт — её обновление фоновое; персональные полки — с классом показа.
  const g = await ctx.repo.shelf(d.kind, type, ctx.repo.peekShelf(d.kind, type) === undefined ? o : BG);
  const more = ids.list(encodeListKey({ src: d.kind, type: d.type }));
  return { def: d, tiles: withMore(ctx, d, titles(ctx, d, g.value.slice(0, TILES)), more), stale: false };
}

/**
 * Данные полки уже в L1/L2: её загрузка ответит без сети. Запись старше stale-max всё же пойдёт в сеть — такую держит
 * срок ответа.
 */
function cached(ctx: AppContext, d: Def): boolean {
  const has = (key: string): boolean => ctx.cache.peek(key) !== undefined;
  if (d.kind === "bookmarks") return has(cacheKeys.bookmarks());
  if (d.kind !== "continue") return ctx.repo.peekShelf(d.kind, d.type ?? "") !== undefined;
  const h = ctx.cache.peek<HistoryEntry[]>(cacheKeys.history());
  return h !== undefined && has(cacheKeys.serials()) && (h.value.length > 0 || has(cacheKeys.movies()));
}

/** Загрузки всех полок по порядку; `user` — последним, для строки о подписке (только из кэша). */
function start(ctx: AppContext, o: ReqOpts): Promise<Shelf>[] {
  const loads = DEFS.map((d) => loadShelf(ctx, d, o));
  ctx.repo.user(o).catch(noop);
  return loads;
}

/** Снимок того, что уже пришло: порядок полок сохраняется, пустые не выводятся. */
function watch(loads: Promise<Shelf>[]): () => Snap {
  const done: Shelf[] = [];
  let left = loads.length;
  let err: unknown;
  loads.forEach((p, i) => p.then((s) => {
    done[i] = s;
    left -= 1;
  }, (e: unknown) => {
    err ??= e;
    left -= 1;
  }));
  return () => {
    const all = done.filter((s) => s !== undefined);
    const snap: Snap = { shelves: all.filter((s) => s.tiles.length > 0), pending: left > 0, stale: all.some((s) => s.stale) };
    if (err !== undefined) snap.err = err;
    return snap;
  };
}

/** Все загрузки завершились или вышел срок — что раньше; таймер срока снимается. */
function within(clock: Clock, ps: Promise<unknown>[], ms: number): Promise<void> {
  return new Promise((resolve) => {
    const id = clock.setTimeout(resolve, ms);
    void Promise.allSettled(ps).then(() => {
      clock.clearTimeout(id);
      resolve();
    });
  });
}

/** Фоновая сверка: загрузки показа, ещё не завершённые, она не понижает — single-flight кэша отдаёт их же. */
async function settle(ctx: AppContext): Promise<Snap> {
  const loads = start(ctx, BG);
  const snap = watch(loads);
  await Promise.allSettled(loads);
  return snap();
}

function headline(ctx: AppContext): string {
  const s = ctx.repo.peekUser()?.value.subscription;
  if (s === undefined || s.active) return T.title;
  return `${T.warning} ${NO_SUBSCRIPTION_TEXT}${s.endTime > 0 ? ` (до ${fmtDate(s.endTime)})` : ""}`;
}

function rootOf(ctx: AppContext, pages: MsxContentPage[]): MsxContentRoot {
  return { type: "list", compress: true, flag: FLAG, cache: false, reuse: false, headline: headline(ctx), template: TEMPLATE, pages };
}

/** Две полки на страницу: заголовок `0,y,16,1`, плитки `x,y+1,2,3` (Plan B S4). */
function pagesOf(shelves: Shelf[]): MsxContentPage[] {
  const pages: MsxContentPage[] = [];
  shelves.forEach((s, i) => {
    const y = (i % 2) * 4;
    if (y === 0) pages.push({ items: [] });
    pages[pages.length - 1]?.items.push(
      { type: "space", layout: `0,${y},${WIDTH},1`, headline: s.def.title },
      ...s.tiles.map((t, k) => ({ ...t, layout: `${2 * k},${y + 1},2,3` })),
    );
  });
  return pages;
}

function message(text: string): MsxContentItem[] {
  return [
    { type: "space", layout: `0,0,${WIDTH},4`, text },
    { type: "button", layout: "0,5,8,1", label: T.retry, action: RETRY_CONTENT },
  ];
}

/** Экран и хеш его персональной части. CNFR-16: полки с конца снимаются, пока JSON больше 32 КБ. */
function render(ctx: AppContext, s: Snap): { root: MsxContentRoot; hash: string } {
  let shelves = s.shelves;
  if (shelves.length === 0) {
    const state = s.pending ? "loading" : s.err !== undefined ? "error" : "empty";
    const items = state === "error"
      ? errorItems(ctx, s.err, { retry: RETRY_CONTENT, offerLogin: true, width: WIDTH })
      : message(state === "loading" ? T.loading : T.empty);
    return { root: rootOf(ctx, [{ items }]), hash: personalHash(state) };
  }
  let root = rootOf(ctx, pagesOf(shelves));
  while (shelves.length > 1 && bytes(root) > MAX_BYTES) {
    shelves = shelves.slice(0, -1);
    root = rootOf(ctx, pagesOf(shelves));
  }
  return { root, hash: personalHash(shelves.map((x) => [x.def.id, x.personal])) };
}

function remember(ctx: AppContext, s: Snap): void {
  if (s.shelves.length === 0 && s.pending) return;
  if (s.shelves.length === 0 && s.err !== undefined) failures.set(ctx, s.err);
  else failures.delete(ctx);
}

/** Пересчёт для `scheduleRefresh`: дождаться полок, устаревшее — обновить и сверить через 3 с. */
async function recompute(ctx: AppContext): Promise<string> {
  let s = await settle(ctx);
  if (s.stale) {
    await sleep(ctx.clock, RECHECK_MS);
    s = await settle(ctx);
  }
  remember(ctx, s);
  return render(ctx, s).hash;
}

export async function homeScreen(ctx: AppContext): Promise<MsxContentRoot> {
  const hits = DEFS.map((d) => cached(ctx, d));
  const t0 = ctx.clock.perf();
  const loads = start(ctx, FG);
  const snap = watch(loads);
  // Полки из кэша — сразу, недостающие придут заменой; сеть ждём, только если из кэша показать нечего.
  await within(ctx.clock, loads.filter((_, i) => hits[i]), DEADLINE_MS);
  if (snap().shelves.length === 0) await within(ctx.clock, loads, Math.max(0, DEADLINE_MS - (ctx.clock.perf() - t0)));
  const s = snap();
  const late = s.pending;
  remember(ctx, s);
  const failed = failures.get(ctx);
  if (late && s.shelves.length === 0 && failed !== undefined) {
    s.pending = false;
    s.err = failed;
  }
  const { root, hash } = render(ctx, s);
  // Каждый показ: после плеера `refreshAfterPlayback` сверяет главную именно с этим хешем.
  const spec = { dataId: ids.home(), flag: FLAG, hash, recompute: () => recompute(ctx) };
  trackScreen(ctx, spec);
  if (late || s.stale) scheduleRefresh(ctx, spec);
  return root;
}

/** После `ready` (спец. §6.1, §8.3): полки обновляются через SWR, чтобы L2 был тёплым к открытию главной. */
export function warmHome(ctx: AppContext): void {
  void Promise.allSettled(start(ctx, BG));
}
