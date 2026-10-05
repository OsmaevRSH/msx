import type { AppContext, ListState } from "../app/context.ts";
import type { ItemSummary, Page } from "../api/models.ts";
import type { ListSource } from "../cache/repo.ts";
import { KpError, toKpError } from "../core/errors.ts";
import type { KpErrorCode } from "../core/errors.ts";
import { commitMsg, panelAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { decodeListKey, ids, listFlag, msgs } from "../router/ids.ts";
import type { ListKey } from "../router/ids.ts";
import { errorScreen } from "./error.ts";
import { gridTemplate, posterTiles } from "./tiles.ts";

// Список раздела S5 (спец. §3.4, §6.3, §11 S5; Plan B §8.3 S5): порции по 48 внутри плагина. Последняя плитка
// незаконченного списка несёт live `setup` → сообщение `extend`; догруженное дописывается в память и
// перерисовывается только у текущего экрана (CD-16). Возврат к списку отвечает из памяти без сети (CE-06).

const TAG = "list";
const PER_PAGE = 48;
/** Списков в памяти не больше этого: каждая сортировка и жанр — свой ключ, а сессия на ТВ длится часами (CNFR-17). */
export const MAX_LISTS = 16;
const DEFAULT_SORT = "-updated";
/** «Мультфильмы» в меню — жанр 23 (research kinopub-api §6.4). */
const CARTOONS_GENRE = "23";
/** 16×8 (`compress`): 8 плиток в ряд; картинка 2×3 и полоса названия (`separate`). */
const GRID = "0,0,2,4";

const T = {
  catalog: "Каталог",
  cartoons: "Мультфильмы",
  bookmarks: "Закладки",
  similar: "Похожие",
  sortGenre: "Сортировка и жанр",
  sort: "Сортировка",
  genre: "Жанр",
  offline: "нет связи",
  empty: "Ничего не найдено",
  back: "Назад",
};

export const SORTS: { id: string; title: string }[] = [
  { id: "-updated", title: "Обновлённые" },
  { id: "-created", title: "Новые на сайте" },
  { id: "-kinopoisk_rating", title: "Рейтинг КП" },
  { id: "-imdb_rating", title: "IMDb" },
  { id: "-views", title: "Популярные" },
  { id: "-year", title: "Год" },
];

const TYPE_TITLES: Readonly<Record<string, string>> = {
  movie: "Фильмы",
  serial: "Сериалы",
  "movie,serial": "Фильмы и сериалы",
  "documovie,docuserial": "Документальное",
  documovie: "Документальные фильмы",
  docuserial: "Документальные сериалы",
  tvshow: "ТВ-шоу",
  concert: "Концерты",
  "3D": "3D",
};

const SHELF_TITLES = { fresh: "Новинки", popular: "Популярное", hot: "Горячее" } as const;

/** Состояние списка в памяти и то, что не входит в общий `ListState`: заголовок с жанром и пометка офлайна. */
type ListEntry = ListState & { headline?: string; offline?: KpErrorCode };

const section = (k: ListKey): string =>
  k.genre === CARTOONS_GENRE ? T.cartoons : TYPE_TITLES[k.type ?? ""] ?? T.catalog;

/** «Фильмы · Обновлённые», «Новинки · Сериалы», «Закладки», «Похожие». Название жанра добавляет экран. */
export function listTitle(k: ListKey): string {
  switch (k.src) {
    case "catalog": {
      const sort = SORTS.find((s) => s.id === (k.sort || DEFAULT_SORT));
      return sort === undefined ? section(k) : `${section(k)} · ${sort.title}`;
    }
    case "fresh":
    case "popular":
    case "hot":
      return `${SHELF_TITLES[k.src]} · ${section(k)}`;
    case "folder":
      return T.bookmarks;
    case "similar":
      return T.similar;
  }
}

const bad = (): KpError => new KpError("KP-BAD", "bad list key");

/** Ключ списка → источник репозитория; пустые поля не передаются. */
export function listSource(k: ListKey): ListSource {
  const type = k.type ? { type: k.type } : {};
  const genre = k.genre ? { genre: k.genre } : {};
  switch (k.src) {
    case "catalog":
      return { kind: "catalog", ...type, sort: k.sort || DEFAULT_SORT, ...genre };
    case "fresh":
    case "popular":
    case "hot":
      return { kind: "shelf", shelf: k.src, ...type, ...genre };
    case "folder":
      if (k.folder === undefined || k.folder <= 0) throw bad();
      return { kind: "folder", folder: k.folder };
    case "similar":
      if (k.id === undefined || k.id <= 0) throw bad();
      return { kind: "similar", id: k.id };
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

/** Сообщение `extend:<ключ>` от live-элемента списка (спец. §3.4). */
export async function onExtend(ctx: AppContext, key: string): Promise<void> {
  const st: ListEntry | undefined = ctx.state.lists.get(key);
  if (st === undefined || st.done || st.loading !== undefined) return;
  const loading = extend(ctx, key, st);
  st.loading = loading;
  try {
    await loading;
  } finally {
    if (st.loading === loading) delete st.loading;
  }
}

// --- Внутреннее ---

async function extend(ctx: AppContext, key: string, st: ListEntry): Promise<void> {
  const src = listSource(decodeListKey(key));
  const want = st.page + 1;
  const t0 = ctx.clock.perf();
  let page: Page<ItemSummary>;
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
  ctx.metrics.record("list:extend", ctx.clock.perf() - t0);
  ctx.log.info(TAG, "extend", { flag: listFlag(key), page: want, added, done: st.done });
  // Спец. §6.3: перерисовать, только если список всё ещё текущий; иначе он отдастся из памяти при возврате.
  if (ctx.current.isCurrent(ids.list(key))) ctx.host.executeAction("reload:content");
  prefetchNext(ctx, src, st);
}

/**
 * Дописать страницу без повторов по id. Конец списка: последняя страница, короткая порция или зажатая
 * страница — KinoPub за концом отдаёт последнюю страницу вместо пустой (Plan B A-13).
 */
function apply(st: ListState, page: Page<ItemSummary>, want: number): number {
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
  const raced = recall(ctx, key);
  if (raced !== undefined) return raced;
  const st: ListEntry = { key, items: [], page: 0, totalPages: 0, done: false, headline: listTitle(k) };
  if (genre !== undefined) st.headline = `${st.headline} · ${genre}`;
  if (got.offline !== undefined) st.offline = got.offline;
  apply(st, got.value, 1);
  remember(ctx, key, st);
  return st;
}

/** Название жанра для заголовка; справочник обычно уже в кэше (его грузит панель жанров), сбой не мешает списку. */
async function genreTitle(ctx: AppContext, k: ListKey): Promise<string | undefined> {
  if (!k.genre || k.genre === CARTOONS_GENRE) return undefined;
  try {
    const all = (await ctx.repo.genres((k.type ?? "").split(",")[0])).value;
    const titles = k.genre.split(",").map((id) => all.find((g) => String(g.id) === id)?.title);
    return titles.every((s) => s !== undefined) ? titles.join(", ") : undefined;
  } catch (e) {
    ctx.log.debug(TAG, "genres_failed", { err: toKpError(e).code });
    return undefined;
  }
}

/** Из памяти; использованный список становится самым свежим. */
function recall(ctx: AppContext, key: string): ListEntry | undefined {
  const st = ctx.state.lists.get(key);
  if (st !== undefined) remember(ctx, key, st);
  return st;
}

function remember(ctx: AppContext, key: string, st: ListEntry): void {
  const lists = ctx.state.lists;
  lists.delete(key);
  lists.set(key, st);
  for (const old of lists.keys()) {
    if (lists.size <= MAX_LISTS) break;
    lists.delete(old);
  }
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
  const filters = k.src !== "folder" && k.src !== "similar";
  const extension: string[] = [];
  if (filters) extension.push(`{ico:msx-red:stop} ${k.src === "catalog" ? T.sortGenre : T.genre}`);
  if (st.offline !== undefined) extension.push(`{ico:msx-yellow:history} ${T.offline}`);
  const root: MsxContentRoot = {
    type: "list", compress: true, flag: listFlag(key), cache: false, reuse: false, headline: st.headline ?? listTitle(k),
  };
  if (extension.length > 0) root.extension = extension.join("  ");
  if (filters) root.options = filterOptions(ctx, key, k);
  if (st.items.length === 0) {
    root.pages = [{ items: emptyItems() }];
    return root;
  }
  const items = posterTiles(ctx, st.items);
  if (!st.done) items[items.length - 1].live = { type: "setup", action: commitMsg(msgs.extend(key)) };
  root.template = gridTemplate(ctx, GRID);
  root.items = items;
  return root;
}

/** Красная кнопка (Plan B S6): у полок KinoPub нет параметра сортировки — только жанр. */
function filterOptions(ctx: AppContext, key: string, k: ListKey): MsxContentRoot {
  const items: MsxContentItem[] = [];
  if (k.src === "catalog") items.push({ id: "o_sort", icon: "sort", label: T.sort, action: panelAction(ctx.P, ids.panel("sort", key)) });
  items.push({ id: "o_genre", icon: "category", label: T.genre, action: panelAction(ctx.P, ids.panel("genre", key)) });
  return { headline: k.src === "catalog" ? T.sortGenre : T.genre, template: { type: "control", layout: "0,0,8,1" }, items };
}

/** Страница должна содержать фокусируемый элемент (msx-platform §2.4), поэтому кроме текста — «Назад». */
function emptyItems(): MsxContentItem[] {
  return [
    { type: "space", layout: "0,0,16,2", text: T.empty },
    { id: "b_back", type: "button", layout: "0,2,4,1", label: T.back, action: "back" },
  ];
}
