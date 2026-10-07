import type { AppContext } from "../app/context.ts";
import type { BookmarkFolder, HistoryEntry, ItemSummary, SerialWatching, User } from "../api/models.ts";
import type { ReqClass } from "../api/transport.ts";
import { cacheKeys } from "../cache/repo.ts";
import type { Got } from "../cache/swr.ts";
import { OrderStore } from "../config/menu.ts";
import { sleep } from "../core/clock.ts";
import type { Clock } from "../core/clock.ts";
import { KpError } from "../core/errors.ts";
import { fmtDate } from "../core/format.ts";
import { chain, contentAction, panelAction, replaceContent } from "../msx/actions.ts";
import { guard } from "../msx/edges.ts";
import type { MsxContentItem, MsxContentPage, MsxContentRoot } from "../msx/types.ts";
import { NO_SUBSCRIPTION_TEXT } from "../playback/resolve.ts";
import { encodeListKey, ids } from "../router/ids.ts";
import { buildContinue } from "./continue.ts";
import { RETRY_CONTENT, errorItems } from "./error.ts";
import { MAX_BYTES, bytes } from "./list.ts";
import { shelfTitle } from "./list-head.ts";
import { personalHash, scheduleRefresh, trackScreen } from "./refresh.ts";
import { GRID, ROW, gridPreload, iconTile, shelfTile } from "./tiles.ts";

// Главная S4 (спец. §8.4, §11; Plan B S4, D-34, D-40). Всё, что есть в кэше, отдаётся сразу, персональное — с оверлеем
// прогресса ТВ; KinoPub ждём, только если из кэша показать нечего, и не дольше 1,5 с (CNFR-05). Запись старше stale-max
// тоже ждёт сеть не дольше срока ответа, дальше показывается из кэша (X-1). Недостающие полки и устаревшие персональные
// данные догружаются фоном, экран заменяется `replace:content:home`, только если изменилась его персональная часть,
// набор полок или пометка «нет связи» (спец. §6.3). Показ, которого ждёт пользователь, — передний план; прогрев, фоновые
// сверки и обновление подборок из кэша — `bg`, чтобы не отнимать слоты у действий пользователя (спец. §8.3–8.5).
// Порядок и видимость полок — настройка «Секции главной» (S12, `kp.cfg.home`): скрытые полки не загружаются.

const FLAG = "home";
const DEADLINE_MS = 1500;
/** D-40: устаревшие персональные данные обновляются фоном, экран сверяется через 3 с. */
const RECHECK_MS = 3000;
/** Плиток полки: ряд сетки; у подборок и закладок последняя — «Показать все», если не всё поместилось. */
const TILES = ROW;
/** Р-22: у «Продолжить» нет «Показать все» — ряд целиком. */
const CONTINUE_TILES = ROW;
const WIDTH = GRID.width;
/**
 * Полка — страница ленты: заголовок `0,0,12,1` и ряд плиток `x,1,2,4`, сдвинутые на полряда вверх: заголовок ближе
 * к постерам, страница ниже на полряда (`offset` страницы). На экране — полка и верх следующей.
 */
const LIFT = 0.5;
const T = {
  title: "Главная",
  more: "Показать все",
  pcs: "шт.",
  refresh: "Обновить",
  loading: "{ico:hourglass-empty} Загружаю главную…",
  empty: "Пока здесь пусто",
  warning: "{ico:msx-yellow:warning}",
  offline: "{ico:msx-yellow:history} нет связи",
  shelves: "Секции главной",
  hidden: "Все секции главной скрыты",
};

type Kind = "continue" | "bookmarks" | "fresh" | "popular" | "hot";
type ReqOpts = { cls: ReqClass };
const FG: ReqOpts = { cls: "fg" };
const BG: ReqOpts = { cls: "bg" };
interface Def { id: string; title: string; kind: Kind; type?: string }

/**
 * Plan B S4: порядок по умолчанию — и на экране, и в очереди запросов холодной сборки (спец. §8.4 п. 2). Названия
 * подборок — общие с их списками «Показать все» (V-08). `id` — и префикс плиток, и запись в `kp.cfg.home`.
 */
export const SHELVES: readonly Def[] = [
  { id: "c", title: "Продолжить просмотр", kind: "continue" },
  { id: "fm", title: shelfTitle("fresh", "movie"), kind: "fresh", type: "movie" },
  { id: "fs", title: shelfTitle("fresh", "serial"), kind: "fresh", type: "serial" },
  { id: "b", title: "Закладки", kind: "bookmarks" },
  { id: "pm", title: shelfTitle("popular", "movie"), kind: "popular", type: "movie" },
  { id: "ps", title: shelfTitle("popular", "serial"), kind: "popular", type: "serial" },
  { id: "hm", title: shelfTitle("hot", "movie"), kind: "hot", type: "movie" },
  { id: "hs", title: shelfTitle("hot", "serial"), kind: "hot", type: "serial" },
];

/** Настройка «Секции главной» поверх `kp.cfg.home`. */
export function homeStore(ctx: AppContext): OrderStore {
  return new OrderStore(ctx.store, SHELVES.map((d) => d.id), [], "home");
}

/** Видимые полки в порядке пользователя. */
const shown = (ctx: AppContext): Def[] => homeStore(ctx).shown().map((id) => SHELVES.find((d) => d.id === id)!);

/**
 * «Секции главной» изменены. Главная — текущий экран (панель открыта с неё): заменить её сразу; иначе MSX запросит её
 * при показе (`cache: false`), а перерисовывается экран под панелью — настройки со сводкой строки.
 */
export function redrawHome(ctx: AppContext): string {
  return ctx.current.isCurrent(ids.home()) ? replaceContent(FLAG, ctx.P, ids.home()) : "reload:content";
}

/**
 * Плитки без `layout`; `personal` — вклад полки в хеш (Plan B §7.7), `stale` — персональные данные устарели,
 * `offline` — данные из кэша, потому что KinoPub не ответил.
 */
interface Shelf { def: Def; tiles: MsxContentItem[]; personal?: unknown; stale: boolean; offline: boolean }
/**
 * `stale` — устарели персональные данные полок или строка о подписке (или `user` ещё не пришёл); `none` — все полки
 * скрыты настройкой.
 */
interface Snap { shelves: Shelf[]; pending: boolean; stale: boolean; offline: boolean; none: boolean; err?: unknown }

type ShelfKind = "fresh" | "popular" | "hot";

/** Откуда полки берут данные: SWR с сетью или только то, что уже лежит в L1/L2. */
interface Src {
  history(): Promise<Got<HistoryEntry[]>>;
  serials(): Promise<Got<SerialWatching[]>>;
  movies(): Promise<Got<ItemSummary[]>>;
  folders(): Promise<Got<BookmarkFolder[]>>;
  shelf(kind: ShelfKind, type: string): Promise<Got<ItemSummary[]>>;
}

function net(ctx: AppContext, o: ReqOpts): Src {
  return {
    history: () => ctx.repo.history(o),
    serials: () => ctx.repo.serials(o),
    movies: () => ctx.repo.watchingMovies(o),
    folders: () => ctx.repo.bookmarkFolders(o),
    // Спец. §8.4 п. 1: подборку из кэша пользователь не ждёт — её обновление фоновое; персональные полки — с классом показа.
    shelf: (kind, type) => ctx.repo.shelf(kind, type, ctx.repo.peekShelf(kind, type) === undefined ? o : BG),
  };
}

/** Без сети: то, что лежит в кэше, — устаревшим; нет записи — отказ. */
function mem(ctx: AppContext): Src {
  const peek = <V>(key: string): Promise<Got<V>> => {
    const g = ctx.cache.peek<V>(key);
    return g === undefined ? Promise.reject(new KpError("KP-NET", "not-cached")) : Promise.resolve({ ...g, stale: true });
  };
  return {
    history: () => peek(cacheKeys.history()),
    serials: () => peek(cacheKeys.serials()),
    movies: () => peek(cacheKeys.movies()),
    folders: () => peek(cacheKeys.bookmarks()),
    shelf: (kind, type) => peek(cacheKeys.shelf(kind, type)),
  };
}

/**
 * Последняя сборка: упали все полки. Пока ни одна полка не пришла, вместо «Загружаю» показывается эта ошибка: иначе
 * «Загружаю» → (ошибка) → замена → «Загружаю» шли бы по кругу, ведь повторы запросов дольше срока ответа.
 */
const failures = new WeakMap<AppContext, unknown>();
const noop = (): void => undefined;
const pct = (p: number): number => Math.round(p * 100) / 100;

/** Последняя плитка полки — «Показать все» с названием полки: полный список (V-08). */
const withMore = (ctx: AppContext, d: Def, tiles: MsxContentItem[], dataId: string): MsxContentItem[] =>
  tiles.length === 0 ? [] : [...tiles, { ...iconTile("arrow-forward", T.more, d.title, contentAction(ctx.P, dataId)), id: `${d.id}_more` }];

/** Плитки тайтлов полки: тот же вид и тот же адрес постера, что в каталоге (`shelfTile`, `posterUrl`). */
function titles(ctx: AppContext, d: Def, items: ItemSummary[]): MsxContentItem[] {
  const size = ctx.prefs.get().posterSize;
  return items.map((it) => ({ ...shelfTile(ctx, it, size), id: `${d.id}${it.id}` }));
}

const ok = <V>(r: PromiseSettledResult<Got<V>>): Got<V> | undefined => (r.status === "fulfilled" ? r.value : undefined);

async function continueShelf(ctx: AppContext, d: Def, src: Src): Promise<Shelf> {
  const [h, s] = await Promise.allSettled([src.history(), src.serials()]);
  if (h.status === "rejected" && s.status === "rejected") throw h.reason;
  const hist = ok(h)?.value ?? [];
  // Фильмы в просмотре нужны, только если история пуста (Plan B §8.3.1 п. 4).
  const m = hist.length === 0 ? await src.movies().catch(noop) : undefined;
  const items = buildContinue(hist, ok(s)?.value ?? [], m?.value ?? [], ctx.overlay.get, (id) => ctx.overlay.forItem(id))
    .slice(0, CONTINUE_TILES);
  const size = ctx.prefs.get().posterSize;
  const tiles = items.map((c) => {
    const t: MsxContentItem = { ...shelfTile(ctx, c, size), id: `${d.id}${c.id}`, tag: c.tag, badge: c.badge, stamp: c.stamp };
    if (c.progress !== undefined) Object.assign(t, { progress: pct(c.progress), progressColor: "msx-blue" });
    return t;
  });
  const gots = [ok(h), ok(s), m];
  return {
    def: d, tiles, personal: tiles.map((t) => [t.id, t.progress, t.tag, t.badge]),
    // Источник не ответил — тоже повод сверить экран позже.
    stale: h.status === "rejected" || s.status === "rejected" || gots.some((g) => g?.stale === true),
    offline: gots.some((g) => g?.offline !== undefined),
  };
}

async function loadShelf(ctx: AppContext, d: Def, src: Src): Promise<Shelf> {
  if (d.kind === "continue") return continueShelf(ctx, d, src);
  if (d.kind === "bookmarks") {
    const g = await src.folders();
    // V-06: «Показать все» — только если папки не поместились; его появление тоже меняет экран.
    const more = g.value.length > TILES;
    const folders = g.value.slice(0, more ? TILES - 1 : TILES);
    // V-30: значок закладки — на месте постера, над названием, а не поверх него.
    const tiles = folders.map((f): MsxContentItem => ({
      ...iconTile("bookmark", f.title, `${f.count} ${T.pcs}`, contentAction(ctx.P, ids.list(encodeListKey({ src: "folder", folder: f.id })))),
      id: `${d.id}${f.id}`,
    }));
    return {
      def: d, tiles: more ? withMore(ctx, d, tiles, ids.bookmarks()) : tiles,
      personal: [folders.map((f) => [f.id, f.count, f.title]), more], stale: g.stale, offline: g.offline !== undefined,
    };
  }
  const g = await src.shelf(d.kind, d.type ?? "");
  const more = ids.list(encodeListKey({ src: d.kind, type: d.type }));
  return { def: d, tiles: withMore(ctx, d, titles(ctx, d, g.value.slice(0, TILES - 1)), more), stale: false, offline: g.offline !== undefined };
}

/**
 * Данные полки уже в L1/L2: её загрузка ответит без сети. Запись старше stale-max всё же пойдёт в сеть — такую держит
 * срок ответа, а после него она показывается из кэша (X-1).
 */
function cached(ctx: AppContext, d: Def): boolean {
  const has = (key: string): boolean => ctx.cache.peek(key) !== undefined;
  if (d.kind === "bookmarks") return has(cacheKeys.bookmarks());
  if (d.kind !== "continue") return ctx.repo.peekShelf(d.kind, d.type ?? "") !== undefined;
  const h = ctx.cache.peek<HistoryEntry[]>(cacheKeys.history());
  return h !== undefined && has(cacheKeys.serials()) && (h.value.length > 0 || has(cacheKeys.movies()));
}

/**
 * Загрузки всех полок по порядку; `user` — последним, для строки о подписке. Показ ждёт её из кэша, а если из кэша
 * показать нечего — до срока вместе с полками.
 */
interface Loads { shelves: Promise<Shelf>[]; user: Promise<Got<User> | undefined> }

/** Загрузки видимых полок `defs` — скрытые «Секциями главной» у KinoPub не запрашиваются. */
function start(ctx: AppContext, o: ReqOpts, defs = shown(ctx)): Loads {
  const src = net(ctx, o);
  const shelves = defs.map((d) => loadShelf(ctx, d, src));
  return { shelves, user: ctx.repo.user(o).catch(() => undefined) };
}

/** Полки, отмеченные в `which`, только из кэша; без записи — `undefined`. Сеть не нужна: ответ в микрозадачах. */
function fromCache(ctx: AppContext, defs: Def[], which: boolean[]): Promise<(Shelf | undefined)[]> {
  const src = mem(ctx);
  return Promise.all(defs.map((d, i) => (which[i] === true ? loadShelf(ctx, d, src).catch(() => undefined) : undefined)));
}

/**
 * Снимок того, что уже пришло: порядок полок сохраняется, пустые не выводятся. `old` — замена ещё не пришедшим полкам
 * из кэша; `settled` — какие загрузки завершились.
 */
interface Watch { snap: (old?: (Shelf | undefined)[]) => Snap; settled: boolean[] }

function watch(loads: Loads): Watch {
  const done: (Shelf | undefined)[] = [];
  const settled = loads.shelves.map(() => false);
  let err: unknown;
  let userStale = true;
  loads.shelves.forEach((p, i) => p.then((s) => {
    done[i] = s;
    settled[i] = true;
  }, (e: unknown) => {
    err ??= e;
    settled[i] = true;
  }));
  void loads.user.then((g) => {
    userStale = g?.stale === true;
  });
  const snap = (old: (Shelf | undefined)[] = []): Snap => {
    const all = settled.flatMap((ok, i) => [ok ? done[i] : old[i]]).filter((s) => s !== undefined);
    const out: Snap = {
      shelves: all.filter((s) => s.tiles.length > 0), pending: settled.includes(false), none: settled.length === 0,
      stale: userStale || all.some((s) => s.stale), offline: all.some((s) => s.offline),
    };
    if (err !== undefined) out.err = err;
    return out;
  };
  return { snap, settled };
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
  const w = watch(loads);
  await Promise.allSettled([...loads.shelves, loads.user]);
  return w.snap();
}

function headline(ctx: AppContext): string {
  const s = ctx.repo.peekUser()?.value.subscription;
  if (s === undefined || s.active) return T.title;
  return `${T.warning} ${NO_SUBSCRIPTION_TEXT}${s.endTime > 0 ? ` (до ${fmtDate(s.endTime)})` : ""}`;
}

/**
 * Сетка 12×6 без `compress` — крупные плитки (спец. §11 S4). Без `template`: шаблон корня MSX к элементам `pages` не
 * применяет, поэтому вид плиток — в каждой плитке.
 */
function rootOf(ctx: AppContext, head: string, pages: MsxContentPage[], offline = false): MsxContentRoot {
  const root: MsxContentRoot = {
    type: "list", flag: FLAG, cache: false, reuse: false, ...gridPreload(ctx), headline: head, pages,
    // Красная кнопка — «Секции главной» поверх главной: опции закрываются, изменения видны сразу (`redrawHome`).
    options: { headline: T.title, template: { type: "control", layout: "0,0,8,1" }, items: [{ icon: "tune", label: T.shelves, action: chain(["back", openShelves(ctx)]) }] },
  };
  if (offline) root.extension = T.offline;
  return root;
}

/**
 * Полка на страницу: заголовок и ряд плиток (Plan B S4). Над рядом первой полки и под рядом последней — стражи
 * (`msx/edges.ts`): «вверх» на первой полке и «вниз» на последней не переносят фокус по кругу.
 */
function pagesOf(shelves: Shelf[]): MsxContentPage[] {
  const tileY = 1;
  return shelves.map((s, i): MsxContentPage => {
    const tiles = s.tiles.map((t, k) => ({ ...t, layout: `${GRID.w * k},${tileY},${GRID.w},${GRID.h}`, offset: `0,-${LIFT},0,0` }));
    const box = (k: number) => ({ id: String(tiles[k]?.id ?? ""), x: GRID.w * k, y: tileY - LIFT, w: GRID.w, h: GRID.h });
    const items: MsxContentItem[] = [{ type: "space", layout: `0,0,${WIDTH},1`, offset: `0,0,0,-${LIFT}`, headline: s.def.title }, ...tiles];
    let rows = LIFT;
    // Стражи — последними: в ячейке 0,0 MSX регистрирует последний элемент (заголовок не фокусируется), а первая
    // плитка остаётся первым фокусируемым элементом — на ней фокус при входе из меню.
    if (i === 0) items.push(...tiles.map((_, k) => guard(box(k), 0)));
    if (i === shelves.length - 1) {
      items.push(...tiles.map((_, k) => guard(box(k), tileY + GRID.h)));
      rows += 1;
    }
    return { offset: `0,0,0,-${rows}`, items };
  });
}

const openShelves = (ctx: AppContext): string => panelAction(ctx.P, ids.panel("home"));

/**
 * V-07: пока идёт загрузка, «Обновить» только перезапустил бы ожидание — фокус на самой строке «Загружаю», у неё
 * пустое действие. «Обновить» — у пустой главной, после срока ответа; все полки скрыты — «Секции главной».
 */
function message(ctx: AppContext, state: "loading" | "empty" | "hidden"): MsxContentItem[] {
  if (state === "loading") return [{ type: "default", layout: `0,0,${WIDTH},2`, color: "msx-glass", headline: T.loading, action: chain([]) }];
  const hidden = state === "hidden";
  return [
    { type: "space", layout: `0,0,${WIDTH},4`, text: hidden ? T.hidden : T.empty },
    { type: "button", layout: `0,5,${WIDTH / 2},1`, label: hidden ? T.shelves : T.refresh, action: hidden ? openShelves(ctx) : RETRY_CONTENT },
  ];
}

/**
 * Экран и хеш его персональной части: строка о подписке и полки. CNFR-16: полки с конца снимаются, пока JSON больше
 * 32 КБ.
 */
function render(ctx: AppContext, s: Snap): { root: MsxContentRoot; hash: string } {
  const head = headline(ctx);
  let shelves = s.shelves;
  if (shelves.length === 0) {
    const state = s.pending ? "loading" : s.err !== undefined ? "error" : s.none ? "hidden" : "empty";
    const items = state === "error" ? errorItems(ctx, s.err, { retry: RETRY_CONTENT, offerLogin: true, width: WIDTH }) : message(ctx, state);
    return { root: rootOf(ctx, head, [{ items }]), hash: personalHash([head, state]) };
  }
  let root = rootOf(ctx, head, pagesOf(shelves), s.offline);
  while (shelves.length > 1 && bytes(root) > MAX_BYTES) {
    shelves = shelves.slice(0, -1);
    root = rootOf(ctx, head, pagesOf(shelves), s.offline);
  }
  return { root, hash: personalHash([head, shelves.map((x) => [x.def.id, x.personal]), s.offline]) };
}

function remember(ctx: AppContext, s: Snap): void {
  if (s.shelves.length === 0 && s.pending) return;
  if (s.shelves.length === 0 && s.err !== undefined) failures.set(ctx, s.err);
  else failures.delete(ctx);
}

/** Пересчёт для `scheduleRefresh`: дождаться полок и `user`, устаревшее — обновить и сверить через 3 с. */
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
  const defs = shown(ctx);
  const hits = defs.map((d) => cached(ctx, d));
  const userHit = ctx.repo.peekUser() !== undefined;
  const t0 = ctx.clock.perf();
  const loads = start(ctx, FG, defs);
  const w = watch(loads);
  // Полки из кэша — сразу, недостающие придут заменой; сеть ждём, только если из кэша показать нечего.
  const cachedLoads: Promise<unknown>[] = loads.shelves.filter((_, i) => hits[i]);
  if (userHit) cachedLoads.push(loads.user);
  await within(ctx.clock, cachedLoads, DEADLINE_MS);
  // X-1: запись старше stale-max, которую сеть не обновила к сроку, — из кэша; сверка заменит экран, если что-то изменится.
  const old = await fromCache(ctx, defs, w.settled.map((done, i) => !done && hits[i] === true));
  if (w.snap(old).shelves.length === 0) {
    await within(ctx.clock, [...loads.shelves, loads.user], Math.max(0, DEADLINE_MS - (ctx.clock.perf() - t0)));
  }
  const s = w.snap(old);
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

/** После `ready` (спец. §6.1, §8.3): видимые полки обновляются через SWR, чтобы L2 был тёплым к открытию главной. */
export function warmHome(ctx: AppContext): void {
  void Promise.allSettled(start(ctx, BG).shelves);
}
