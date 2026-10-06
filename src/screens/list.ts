import type { AppContext, ListState } from "../app/context.ts";
import type { BookmarkFolder, Page, Titled } from "../api/models.ts";
import { cacheKeys } from "../cache/repo.ts";
import type { ListSource } from "../cache/repo.ts";
import { KpError, toKpError } from "../core/errors.ts";
import type { KpErrorCode } from "../core/errors.ts";
import { commitMsg } from "../msx/actions.ts";
import { gridEdges } from "../msx/edges.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { decodeListKey, encodeListKey, ids, listFlag, msgs } from "../router/ids.ts";
import type { ListKey } from "../router/ids.ts";
import { errorScreen } from "./error.ts";
import { COLLECTION_SORT, DEFAULT_SORT, filterOptions, listExtension, listTitle, sectionGenre } from "./list-head.ts";
import { GRID, ROW, collectionTiles, gridPreload, gridTemplate, posterTiles } from "./tiles.ts";

export { SORTS, listTitle } from "./list-head.ts";

// Список раздела S5 (спец. §3.4, §6.3, §11 S5; Plan B §8.3 S5): порции по 48 внутри плагина. Догруженное
// дописывается в память и перерисовывается только у текущего экрана (CD-16). Возврат к списку отвечает из памяти
// без сети (CE-06).
//
// Окно (CNFR-16): MSX не умеет дописывать элементы — `update:content:{ID}` меняет только поля существующего, а
// paging.js автора на каждую догрузку заново отдаёт весь список через `reload:content`. Поэтому ответ несёт не
// весь список, а окно [from, to) до 96 плиток. Крайние плитки окна несут live `setup`: последняя —
// `extend:<ключ>:down:<to>`, первая (если окно сдвинуто) — `extend:<ключ>:up:<from>`. Сдвиг идёт на 48 плиток
// от края, к которому идёт пользователь, а `reload:content` держит фокус по `id` элемента (MSX KB, Focus Separator):
// сфокусированная плитка остаётся в окне. Над первым и под последним рядом окна — стражи (`msx/edges.ts`): «вверх» и
// «вниз» на краю не переносят фокус по кругу; догрузку у края по-прежнему делает live последней плитки.

const TAG = "list";
const PER_PAGE = 48;
/** Списков в памяти не больше этого: каждая сортировка и жанр — свой ключ, а сессия на ТВ длится часами (CNFR-17). */
export const MAX_LISTS = 16;
/**
 * Страница MSX — ряд из 6 плиток 2×4 (`tiles.ts`). Начало окна кратно ей — при сдвиге плитки не меняют колонку; окно
 * ужимается по байтам тоже рядами.
 */
const PAGE = ROW;
/** Плиток в ответе не больше этого (16 рядов): каждая перерисовка стоит одинаково. */
export const WINDOW = 96;
/** Сдвиг окна — порция API (8 рядов): у края пользователя остаётся 48 плиток, фокус не выпадает из окна. */
const STEP = PER_PAGE;
/** Уже виденных плиток у границы сдвига, которые не отрезает даже ужатие по байтам (3 ряда — два экрана). */
const KEEP = 3 * PAGE;
/** CNFR-16: ответ списка в байтах UTF-8. */
export const MAX_BYTES = 32 * 1024;

const T = {
  empty: "Ничего не найдено",
  emptyFolder: "В папке пока пусто. Добавьте фильм кнопкой ☆ на карточке",
  emptyHistory: "Здесь появятся фильмы и сериалы, которые вы смотрели",
  back: "Назад",
};

/**
 * Состояние списка в памяти и то, что не входит в общий `ListState`: заголовок, название жанра, всего найдено
 * (`pagination`), пометка офлайна и окно ответа [from, to). `anchor` — край, к которому шёл пользователь, `pivot` —
 * граница последнего сдвига: по одну сторону уже виденные плитки, по другую новые. Экран не из списков («Я смотрю»)
 * кладёт сюда готовые плитки (`tiles`) и свой `dataId` — окно, сдвиг и `extend` у него те же.
 */
export type ListEntry = ListState & {
  headline?: string; genre?: string; total?: number; offline?: KpErrorCode;
  from?: number; to?: number; anchor?: "start" | "end"; pivot?: number;
  dataId?: string; tiles?: MsxContentItem[];
};

type Edge = "up" | "down";

const bad = (): KpError => new KpError("KP-BAD", "bad list key");

/** Ключ списка → источник репозитория; пустые поля не передаются. */
export function listSource(k: ListKey): ListSource {
  const type = k.type ? { type: k.type } : {};
  const genre = k.genre ? { genre: k.genre } : {};
  switch (k.src) {
    case "catalog":
      return { kind: "catalog", ...type, sort: k.sort || DEFAULT_SORT, ...genre, ...(k.quality ? { quality: k.quality } : {}) };
    case "fresh":
    case "popular":
    case "hot":
      return { kind: "shelf", shelf: k.src, ...type, ...genre };
    case "folder":
      if (k.folder === undefined || k.folder <= 0) throw bad();
      return { kind: "folder", folder: k.folder };
    case "similar":
    case "collection":
      if (k.id === undefined || k.id <= 0) throw bad();
      return { kind: k.src, id: k.id };
    case "history":
      return { kind: "history" };
    case "collections":
      return { kind: "collections", sort: k.sort || COLLECTION_SORT };
  }
}

export async function listScreen(ctx: AppContext, key: string): Promise<MsxContentRoot> {
  let st: ListEntry;
  let k: ListKey;
  let src: ListSource;
  try {
    k = decodeListKey(key);
    src = listSource(k);
    st = recall(ctx, key) ?? (await firstPage(ctx, key, k, src));
  } catch (e) {
    ctx.log.warn(TAG, "list_failed", { flag: listFlag(key), err: toKpError(e).code });
    return errorScreen(ctx, e, ids.list(key));
  }
  const root = buildRoot(ctx, key, k, st);
  prefetchNext(ctx, src, st);
  return root;
}

/**
 * Сообщение `extend:<ключ>:<down|up>:<край>` от live-плитки края окна (спец. §3.4). Край — `to` или `from`, с которыми
 * окно было отрисовано: повторное срабатывание уже сдвинутого окна игнорируется. `extend:<ключ>` — вниз от текущего.
 */
export async function onExtend(ctx: AppContext, msg: string): Promise<void> {
  const [key = "", dir = "down", mark, ...rest] = msg.split(":");
  const at = mark === undefined ? undefined : /^\d{1,9}$/.test(mark) ? Number(mark) : NaN;
  const st: ListEntry | undefined = ctx.state.lists.get(key);
  if (st === undefined || rest.length > 0 || (dir !== "down" && dir !== "up")) return;
  const w = span(st);
  if (dir === "up") {
    if (at !== w.from || w.from === 0) return;
    shift(st, "up");
    redraw(ctx, st);
    return;
  }
  if (at !== undefined && at !== w.to) return;
  if (w.to < st.items.length) {
    shift(st, "down");
    redraw(ctx, st);
    return;
  }
  if (st.done || st.loading !== undefined) return;
  const loading = extend(ctx, key, st, w);
  st.loading = loading;
  try {
    await loading;
  } finally {
    if (st.loading === loading) delete st.loading;
  }
}

// --- Внутреннее ---

async function extend(ctx: AppContext, key: string, st: ListEntry, w: { from: number; to: number }): Promise<void> {
  const src = listSource(decodeListKey(key));
  const want = st.page + 1;
  const t0 = ctx.clock.perf();
  let page: Page<Titled>;
  try {
    const got = await ctx.repo.listPage(src, want);
    page = got.value;
    if (got.offline === undefined) delete st.offline;
  } catch (e) {
    // live остаётся у последней плитки: следующий показ плитки повторит догрузку.
    ctx.log.warn(TAG, "extend_failed", { flag: listFlag(key), page: want, err: toKpError(e).code });
    return;
  }
  const added = apply(st, page, want);
  st.total = page.pagination.totalItems;
  // Пока шла загрузка, пользователь мог уйти к началу окна (`up`): тогда новое только дописывается в память.
  if (st.from === w.from && st.to === w.to) shift(st, "down");
  ctx.metrics.record("list:extend", ctx.clock.perf() - t0);
  ctx.log.info(TAG, "extend", { flag: listFlag(key), page: want, added, done: st.done });
  redraw(ctx, st);
  prefetchNext(ctx, src, st);
}

/** Спец. §6.3: перерисовать, только если список всё ещё текущий; иначе он отдастся из памяти при возврате. */
function redraw(ctx: AppContext, st: ListEntry): void {
  if (ctx.current.isCurrent(st.dataId ?? ids.list(st.key))) ctx.host.executeAction("reload:content");
}

/** Окно в памяти; у списка, ещё не отданного с окном, — начало списка. */
function span(st: ListEntry): { from: number; to: number } {
  if (st.from === undefined || st.to === undefined) {
    st.from = 0;
    st.to = Math.min(st.items.length, WINDOW);
  }
  return { from: st.from, to: st.to };
}

/**
 * Сдвинуть окно на `STEP` к краю пользователя; противоположный край отрезается до `WINDOW`. Вниз начало
 * округляется вверх до страницы MSX; вверх шаг кратен странице, начало и так кратно ей.
 */
function shift(st: ListEntry, dir: Edge): void {
  const { from, to } = span(st);
  if (dir === "down") {
    st.to = Math.min(st.items.length, to + STEP);
    st.from = Math.max(from, Math.ceil(Math.max(0, st.to - WINDOW) / PAGE) * PAGE);
    st.anchor = "end";
    st.pivot = to;
  } else {
    st.from = Math.max(0, from - STEP);
    st.to = Math.min(to, st.from + WINDOW);
    st.anchor = "start";
    st.pivot = from;
  }
}

/**
 * Дописать страницу без повторов по id. Конец списка: последняя страница, короткая порция или зажатая
 * страница — KinoPub за концом отдаёт последнюю страницу вместо пустой (Plan B A-13).
 */
function apply(st: ListState, page: Page<Titled>, want: number): number {
  const seen = new Set(st.items.map((it) => it.id));
  let added = 0;
  for (const it of page.items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    st.items.push(it);
    added += 1;
  }
  const { current, total } = page.pagination;
  st.page = want;
  st.totalPages = total;
  st.done = current >= total || current < want || page.items.length < PER_PAGE;
  return added;
}

async function firstPage(ctx: AppContext, key: string, k: ListKey, src: ListSource): Promise<ListEntry> {
  const [got, genre] = await Promise.all([ctx.repo.listPage(src, 1), genreTitle(ctx, k)]);
  const folder = folderTitle(ctx, k) ?? got.value.title;
  const raced = recall(ctx, key);
  if (raced !== undefined) return raced;
  const st: ListEntry = { key, items: [], page: 0, totalPages: 0, done: false, headline: folder ?? listTitle(k) };
  if (genre !== undefined) Object.assign(st, { genre, headline: `${st.headline} · ${genre}` });
  if (got.offline !== undefined) st.offline = got.offline;
  st.total = got.value.pagination.totalItems;
  apply(st, got.value, 1);
  remember(ctx, key, st);
  return st;
}

/** Название жанра для заголовка; справочник обычно уже в кэше (его грузит панель жанров), сбой не мешает списку. */
async function genreTitle(ctx: AppContext, k: ListKey): Promise<string | undefined> {
  if (!k.genre || sectionGenre(k.genre) !== undefined) return undefined;
  try {
    const all = (await ctx.repo.genres((k.type ?? "").split(",")[0])).value;
    const titles = k.genre.split(",").map((id) => all.find((g) => String(g.id) === id)?.title);
    return titles.every((s) => s !== undefined) ? titles.join(", ") : undefined;
  } catch (e) {
    ctx.log.debug(TAG, "genres_failed", { err: toKpError(e).code });
    return undefined;
  }
}

/** V-31: папка называется своим именем — из кэша списка папок, с которого её открыли; без него — «Закладки». */
function folderTitle(ctx: AppContext, k: ListKey): string | undefined {
  if (k.src !== "folder") return undefined;
  return ctx.cache.peek<BookmarkFolder[]>(cacheKeys.bookmarks())?.value.find((f) => f.id === k.folder)?.title;
}

/** Из памяти; использованный список становится самым свежим. */
function recall(ctx: AppContext, key: string): ListEntry | undefined {
  const st = ctx.state.lists.get(key);
  if (st !== undefined) remember(ctx, key, st);
  return st;
}

export function remember(ctx: AppContext, key: string, st: ListEntry): void {
  const lists = ctx.state.lists;
  lists.delete(key);
  lists.set(key, st);
  for (const old of lists.keys()) {
    if (lists.size <= MAX_LISTS) break;
    lists.delete(old);
  }
}

/**
 * После просмотра: «История» из памяти устарела. Если её открывали, она забывается, а первая порция обновляется фоном —
 * к следующему открытию она уже свежая (кэш помечен устаревшим `invalidateAfterProgress`).
 */
export function forgetHistory(ctx: AppContext): void {
  const key = encodeListKey({ src: "history" });
  if (!ctx.state.lists.delete(key)) return;
  ctx.repo.listPage({ kind: "history" }, 1, { cls: "bg" }).catch((e: unknown) => {
    ctx.log.debug(TAG, "history_refresh_failed", { err: toKpError(e).code });
  });
}

/** Спец. §8.3: отдана порция N — фоном порция N+1; догрузка потом возьмёт её из кэша или присоединится к запросу. */
function prefetchNext(ctx: AppContext, src: ListSource, st: ListState): void {
  if (st.done) return;
  const page = st.page + 1;
  ctx.repo.listPage(src, page, { cls: "bg" }).catch((e: unknown) => {
    ctx.log.debug(TAG, "prefetch_failed", { page, err: toKpError(e).code });
  });
}

function buildRoot(ctx: AppContext, key: string, k: ListKey, st: ListEntry): MsxContentRoot {
  const root: MsxContentRoot = {
    type: "list", flag: listFlag(key), cache: false, reuse: false, ...gridPreload(ctx), headline: st.headline ?? listTitle(k),
  };
  const extension = listExtension(k, { genre: st.genre, total: st.total, offline: st.offline !== undefined });
  if (extension !== undefined) root.extension = extension;
  const options = filterOptions(ctx, key, k, st.genre);
  if (options !== undefined) root.options = options;
  if (st.items.length === 0) {
    root.pages = [{ items: emptyItems(k.src === "folder" ? T.emptyFolder : k.src === "history" ? T.emptyHistory : T.empty) }];
    return root;
  }
  // Плитка подборки ведёт в её список, а не на карточку: префетч карточки по фокусу ей не нужен.
  const coll = k.src === "collections";
  root.template = gridTemplate(ctx, false, !coll);
  fill(ctx, root, key, st, coll);
  return root;
}

/**
 * Плитки окна и live-края. CNFR-16 при любых названиях и адресах: если ответ больше `MAX_BYTES`, окно ужимается по
 * странице MSX — сначала дальний от пользователя край, пока у границы сдвига остаётся `KEEP` виденных плиток, затем
 * новые плитки (хотя бы одна остаётся), и в последнюю очередь снова дальний край, пока в окне больше двух страниц.
 */
export function fill(ctx: AppContext, root: MsxContentRoot, key: string, st: ListEntry, coll = false): void {
  const w = span(st);
  const tiles = st.tiles?.slice(w.from, w.to) ?? (coll ? collectionTiles : posterTiles)(ctx, st.items.slice(w.from, w.to));
  const down = st.anchor === "end";
  const pivot = st.pivot ?? w.from;
  let { from, to } = w;
  for (;;) {
    const items = tiles.slice(from - w.from, to - w.from);
    edge(items, 0, from > 0, key, "up", from);
    edge(items, items.length - 1, to < st.items.length || !st.done, key, "down", to);
    framed(root, items);
    if (to - from <= 2 * PAGE || bytes(root) <= MAX_BYTES) break;
    if (down) {
      if (from + PAGE <= pivot - KEEP || to - PAGE <= pivot) from += PAGE;
      else to -= PAGE;
    } else if (to - PAGE >= pivot + KEEP || from + PAGE >= pivot) to -= PAGE;
    else from += PAGE;
  }
  st.from = from;
  st.to = to;
}

/**
 * Плитки окна со стражами над первым и под последним рядом; первая плитка — в фокусе при открытии (иначе MSX ставит
 * фокус на стража). Возврат и перерисовка держат фокус по `id`.
 */
function framed(root: MsxContentRoot, tiles: MsxContentItem[]): void {
  const first = tiles[0];
  const { items, inserts } = gridEdges(first === undefined ? tiles : [{ ...first, focus: true }, ...tiles.slice(1)], GRID, { top: "shift", bottom: true });
  root.items = items;
  if (inserts === undefined) delete root.inserts;
  else root.inserts = inserts;
}

/** Копия плитки с live `setup`: сами плитки окна переиспользуются при ужатии. */
function edge(items: MsxContentItem[], i: number, on: boolean, key: string, dir: Edge, at: number): void {
  if (on) items[i] = { ...items[i], live: { type: "setup", action: commitMsg(msgs.extend(`${key}:${dir}:${at}`)) } };
}

/** Размер ответа так, как его меряет CNFR-16: JSON в UTF-8. */
export function bytes(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).length;
}

/** Страница должна содержать фокусируемый элемент (msx-platform §2.4), поэтому кроме текста — «Назад». */
export function emptyItems(text: string): MsxContentItem[] {
  return [
    { type: "space", layout: `0,0,${GRID.width},2`, text },
    { id: "b_back", type: "button", layout: "0,2,3,1", label: T.back, action: "back" },
  ];
}
