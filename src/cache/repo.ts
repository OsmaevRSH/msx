import type { KpApi } from "../api/client.ts";
import type {
  BookmarkFolder, FileInfo, Genre, HistoryEntry, ItemDetail, ItemSummary, MediaLinks, MediaUnit, Page, Season,
  SerialWatching, ServerLocation, User,
} from "../api/models.ts";
import type { ReqClass } from "../api/transport.ts";
import { b64urlEncode } from "../core/b64url.ts";
import type { Clock } from "../core/clock.ts";
import { KpError, toKpError } from "../core/errors.ts";
import type { Logger } from "../core/log.ts";
import type { Got, Policy, SwrCache } from "./swr.ts";

export type ListSource = { kind: "catalog"; type?: string; sort: string; genre?: string }
  | { kind: "shelf"; shelf: "fresh" | "popular" | "hot"; type?: string; genre?: string }
  | { kind: "folder"; folder: number } | { kind: "similar"; id: number };

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const WEEK = 7 * 24 * HOUR;

const PER_PAGE = 48;
const SHELF_SIZE = 7;
const HISTORY_PER_PAGE = 50;
const PLOT_MAX = 600;
/** Plan B D-41: resolve ждёт обновления карточки старше 600 с не дольше 500 мс. */
const D41_FRESH_MS = 600_000;
const D41_WAIT_MS = 500;
const TAG = "repo";

const pol = (ttlMs: number, staleMaxMs: number, persist: boolean): Policy => ({ ttlMs, staleMaxMs, persist });

// TTL и stale-max — Plan B §7.2 (спец. §8.2). L2 — только то, что нужно холодному старту (спец. §8.1).
const REFS = pol(24 * HOUR, WEEK, true);
const USER = pol(HOUR, WEEK, true);
const LIST = pol(10 * MIN, WEEK, true);
// Содержимое папки закладок — 120 с (Plan B §7.2), не 10 мин каталога.
const FOLDER = pol(2 * MIN, WEEK, true);
const SHELF = pol(10 * MIN, WEEK, true);
const SEARCH = pol(5 * MIN, HOUR, false);
const ITEM_FULL = pol(10 * MIN, WEEK, false);
const ITEM_COMPACT = pol(10 * MIN, WEEK, true);
const SIMILAR = pol(HOUR, WEEK, false);
const PERSONAL = pol(MIN, WEEK, true);
const BOOKMARKS = pol(5 * MIN, WEEK, true);
// Ссылки на поток подписаны и привязаны к IP ТВ: только L1, 600 с с момента получения, просроченные не отдаются (спец. §8.2).
const LINKS = pol(600 * SEC, 0, false);

const memOnly = (p: Policy): Policy => ({ ...p, persist: false });
const noop = (): void => undefined;
const opt = (s: string | undefined): string | undefined => (s === "" ? undefined : s);

/** Канонический JSON источника: фиксированный порядок полей, без пустых. */
function sourceJson(src: ListSource): string {
  switch (src.kind) {
    case "catalog": return JSON.stringify({ kind: src.kind, type: opt(src.type), sort: src.sort, genre: opt(src.genre) });
    case "shelf": return JSON.stringify({ kind: src.kind, shelf: src.shelf, type: opt(src.type), genre: opt(src.genre) });
    case "folder": return JSON.stringify({ kind: src.kind, folder: src.folder });
    case "similar": return JSON.stringify({ kind: src.kind, id: src.id });
  }
}

/**
 * Каждый ключ заканчивается на ":". `SwrCache.markStale` сравнивает по префиксу, поэтому так ключ одной сущности
 * никогда не префикс ключа другой (`item:1:` не задевает `item:12:`), а префикс источника списка — все его страницы.
 */
const key = (...parts: (string | number)[]): string => `${parts.join(":")}:`;

export const cacheKeys = {
  genres: (type: string): string => key("refs", "genres", type),
  locations: (): string => key("refs", "loc"),
  voiceovers: (): string => key("refs", "vo"),
  user: (): string => key("user"),
  /** Префикс всех страниц одного источника. */
  listSource: (src: ListSource): string => key("list", b64urlEncode(sourceJson(src))),
  list: (src: ListSource, page: number): string => key("list", b64urlEncode(sourceJson(src)), page),
  shelf: (kind: string, type: string): string => key("shelf", kind, type),
  search: (q: string, page: number): string => key("search", q, page),
  /** Полная карточка в L1; это же префикс компактной копии. */
  item: (id: number): string => key("item", id),
  itemCompact: (id: number): string => key("item", id, "l2"),
  similar: (id: number): string => key("similar", id),
  history: (): string => key("history"),
  serials: (): string => key("serials"),
  movies: (): string => key("movies"),
  bookmarks: (): string => key("bm"),
  links: (mid: number): string => key("links", mid),
};

// --- Компактная карточка для L2 (спец. §8.1): без ссылок на поток и субтитров (подписанные ссылки), сюжет ≤ 600 ---

type CompactFile = Omit<FileInfo, "urls">;
type CompactUnit = Omit<MediaUnit, "files" | "subtitles"> & { files: CompactFile[] };
type CompactItem = Omit<ItemDetail, "videos" | "seasons"> & {
  videos: CompactUnit[]; seasons: (Omit<Season, "episodes"> & { episodes: CompactUnit[] })[];
};

function compactUnit(u: MediaUnit): CompactUnit {
  const { files, subtitles: _subtitles, ...rest } = u;
  return { ...rest, files: files.map(({ urls: _urls, ...f }) => f) };
}

function compactItem(d: ItemDetail): CompactItem {
  const out: CompactItem = {
    ...d, videos: d.videos.map(compactUnit), seasons: d.seasons.map((s) => ({ ...s, episodes: s.episodes.map(compactUnit) })),
  };
  if (d.plot !== undefined && d.plot.length > PLOT_MAX) out.plot = `${d.plot.slice(0, PLOT_MAX - 1)}…`;
  return out;
}

/** Обратно к `ItemDetail`: новый объект, сохранённая в L2 запись не меняется. */
function hydrateUnit(u: CompactUnit): MediaUnit {
  return { ...u, files: (u.files ?? []).map((f) => ({ ...f, urls: {} })), subtitles: [] };
}

function hydrateItem(c: CompactItem): ItemDetail {
  return {
    ...c, videos: (c.videos ?? []).map(hydrateUnit),
    seasons: (c.seasons ?? []).map((s) => ({ ...s, episodes: (s.episodes ?? []).map(hydrateUnit) })),
  };
}

interface Cached { value: ItemDetail; fetchedAt: number; marked: boolean; source: Got<ItemDetail>["source"]; compact: boolean }

/**
 * Репозиторий данных (план §0.6.6, спец. §8.1–8.3, Plan B §7.2–7.3): ключи и политики кэша поверх `SwrCache`.
 * Персональные данные отдаются как есть — оверлей прогресса накладывают экраны.
 */
export class Repo {
  private api: KpApi;
  private cache: SwrCache;
  private clock: Clock;
  private log: Logger;

  constructor(deps: { api: KpApi; cache: SwrCache; clock: Clock; log: Logger }) {
    this.api = deps.api;
    this.cache = deps.cache;
    this.clock = deps.clock;
    this.log = deps.log;
  }

  user(): Promise<Got<User>> {
    return this.cache.get(cacheKeys.user(), USER, () => this.api.user());
  }

  /** Только L1/L2, без сети (resolve проверяет подписку, не дожидаясь API). */
  peekUser(): Got<User> | undefined {
    return this.cache.peek<User>(cacheKeys.user());
  }

  genres(type: string): Promise<Got<Genre[]>> {
    return this.cache.get(cacheKeys.genres(type), REFS, () => this.api.genres(type));
  }

  serverLocations(): Promise<Got<ServerLocation[]>> {
    return this.cache.get(cacheKeys.locations(), REFS, () => this.api.serverLocations());
  }

  voiceoverTypes(): Promise<Got<{ id: number; title: string }[]>> {
    return this.cache.get(cacheKeys.voiceovers(), REFS, () => this.api.voiceoverTypes());
  }

  /** По 48 на страницу; в L2 — только первая порция раздела. `opts.cls` — класс запроса для лимитера (спец. §8.3). */
  listPage(src: ListSource, page: number, opts?: { cls?: ReqClass }): Promise<Got<Page<ItemSummary>>> {
    const cls = opts?.cls;
    if (src.kind === "similar") return this.similarPage(src.id, page, cls);
    const base = src.kind === "folder" ? FOLDER : LIST;
    return this.cache.get(cacheKeys.list(src, page), page === 1 ? base : memOnly(base), () => this.loadList(src, page, cls));
  }

  shelf(kind: "fresh" | "popular" | "hot", type: string): Promise<Got<ItemSummary[]>> {
    return this.cache.get(cacheKeys.shelf(kind, type), SHELF, async () =>
      (await this.api.shelf(kind, { type: opt(type), page: 1, perpage: SHELF_SIZE })).items);
  }

  search(q: string, page: number): Promise<Got<Page<ItemSummary>>> {
    return this.cache.get(cacheKeys.search(q, page), SEARCH, () => this.api.search(q, page, PER_PAGE));
  }

  /**
   * Без `freshWithinMs`/`waitMs` — обычный SWR. С ними (resolve, Plan B D-41): запись старше `freshWithinMs` или
   * помеченная устаревшей обновляется, и обновление ждётся не дольше `waitMs`; не успело — кэш, обновление идёт фоном.
   * При пустом кэше сеть ждётся всегда.
   */
  async item(id: number, opts?: { freshWithinMs?: number; waitMs?: number; cls?: ReqClass }): Promise<Got<ItemDetail>> {
    const cls = opts?.cls;
    if (opts?.freshWithinMs === undefined && opts?.waitMs === undefined) return this.itemSwr(id, cls);
    const cur = this.cached(id);
    if (cur === undefined) return this.itemSwr(id, cls);
    if (!cur.marked && this.clock.now() - cur.fetchedAt < (opts.freshWithinMs ?? D41_FRESH_MS)) return this.itemSwr(id, cls);
    return this.refreshWithin(id, cur, opts.waitMs ?? D41_WAIT_MS, cls);
  }

  /** Без сети. `stale` — пометка или возраст ≥ TTL карточки. */
  peekItem(id: number): Got<ItemDetail> | undefined {
    const cur = this.cached(id);
    return cur === undefined ? undefined : this.asGot(cur);
  }

  history(): Promise<Got<HistoryEntry[]>> {
    return this.cache.get(cacheKeys.history(), PERSONAL, () => this.api.history(1, HISTORY_PER_PAGE));
  }

  serials(): Promise<Got<SerialWatching[]>> {
    return this.cache.get(cacheKeys.serials(), PERSONAL, () => this.api.watchingSerials());
  }

  watchingMovies(): Promise<Got<ItemSummary[]>> {
    return this.cache.get(cacheKeys.movies(), PERSONAL, () => this.api.watchingMovies());
  }

  bookmarkFolders(): Promise<Got<BookmarkFolder[]>> {
    return this.cache.get(cacheKeys.bookmarks(), BOOKMARKS, () => this.api.bookmarkFolders());
  }

  /** Только L1, 600 с; префетч и resolve одного `mid` делят один запрос. `fresh` — в обход кэша (шаг 2 fallback). */
  async links(mid: number, opts: { cls: ReqClass; fresh?: boolean }): Promise<MediaLinks> {
    let failure: unknown;
    const load = async (): Promise<MediaLinks> => {
      try {
        return await this.api.mediaLinks(mid, opts.cls);
      } catch (e) {
        failure = e;
        throw e;
      }
    };
    const got = await this.cache.get(cacheKeys.links(mid), LINKS, load, opts.fresh === true ? { force: true } : undefined);
    // SwrCache при сбое сети отдаёт прежнюю запись с `offline`; для ссылок это недопустимо.
    if (got.offline !== undefined) throw failure ?? new KpError(got.offline, "links-unavailable");
    return got.value;
  }

  /** Plan B §7.3: пометка, а не удаление — экраны продолжают показывать прежнее с оверлеем, пока идёт обновление. */
  invalidateAfterProgress(itemId: number): void {
    this.cache.markStale(cacheKeys.item(itemId));
    this.cache.markStale(cacheKeys.history());
    this.cache.markStale(cacheKeys.serials());
    this.cache.markStale(cacheKeys.movies());
  }

  invalidateAfterBookmark(itemId: number, folderId: number): void {
    this.cache.markStale(cacheKeys.bookmarks());
    this.cache.markStale(cacheKeys.item(itemId));
    this.cache.markStale(cacheKeys.listSource({ kind: "folder", folder: folderId }));
  }

  // --- Внутреннее ---

  private loadList(src: Exclude<ListSource, { kind: "similar" }>, page: number, cls?: ReqClass): Promise<Page<ItemSummary>> {
    switch (src.kind) {
      case "catalog":
        return this.api.items({ type: opt(src.type), genre: opt(src.genre), sort: src.sort, page, perpage: PER_PAGE }, cls);
      case "shelf":
        return this.api.shelf(src.shelf, { type: opt(src.type), genre: opt(src.genre), page, perpage: PER_PAGE }, cls);
      case "folder":
        return this.api.bookmarkFolder(src.folder, page, PER_PAGE, cls);
    }
  }

  /** «Похожие» — одна страница; дальше пусто. */
  private async similarPage(id: number, page: number, cls?: ReqClass): Promise<Got<Page<ItemSummary>>> {
    const got = await this.cache.get(cacheKeys.similar(id), SIMILAR, () => this.api.similar(id, cls));
    const items = page === 1 ? got.value : [];
    return { ...got, value: { items, pagination: { total: 1, current: page, perpage: PER_PAGE, totalItems: got.value.length } } };
  }

  /** Полная карточка из L1, иначе компактная из L2 (холодный старт). */
  private cached(id: number): Cached | undefined {
    const full = this.cache.peek<ItemDetail>(cacheKeys.item(id));
    if (full !== undefined) return { value: full.value, fetchedAt: full.fetchedAt, marked: full.stale, source: full.source, compact: false };
    const c = this.cache.peek<CompactItem>(cacheKeys.itemCompact(id));
    if (c === undefined) return undefined;
    return { value: hydrateItem(c.value), fetchedAt: c.fetchedAt, marked: c.stale, source: c.source, compact: true };
  }

  private asGot(c: Cached, offline?: KpError["code"]): Got<ItemDetail> {
    const stale = c.marked || this.clock.now() - c.fetchedAt >= ITEM_FULL.ttlMs;
    const got: Got<ItemDetail> = { value: c.value, fetchedAt: c.fetchedAt, stale, source: c.source };
    if (offline !== undefined) got.offline = offline;
    return got;
  }

  /** Полная карточка — обычный SWR; только компактная (холодный старт) — сразу, полная — фоном, если устарела. */
  private async itemSwr(id: number, cls?: ReqClass): Promise<Got<ItemDetail>> {
    const cur = this.cached(id);
    if (cur?.compact === true && this.clock.now() - cur.fetchedAt < ITEM_FULL.staleMaxMs) {
      const got = this.asGot(cur);
      if (got.stale) this.refreshItem(id, cls).catch(noop);
      return got;
    }
    return this.cache.get(cacheKeys.item(id), ITEM_FULL, () => this.loadItem(id, cls));
  }

  private refreshItem(id: number, cls?: ReqClass): Promise<Got<ItemDetail>> {
    return this.cache.get(cacheKeys.item(id), ITEM_FULL, () => this.loadItem(id, cls), { force: true });
  }

  private refreshWithin(id: number, cur: Cached, waitMs: number, cls?: ReqClass): Promise<Got<ItemDetail>> {
    const refreshed = this.refreshItem(id, cls).catch((e: unknown) => this.asGot(cur, toKpError(e).code));
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(() => {
        this.log.debug(TAG, "item_wait_timeout", { id, waitMs });
        resolve(this.asGot(cur));
      }, waitMs);
      refreshed.then((got) => {
        this.clock.clearTimeout(timer);
        resolve(got);
      }, noop);
    });
  }

  /** Полная карточка — в L1; компактная копия под `item:<id>:l2:` — в L2 (тот же префикс, та же инвалидация). */
  private async loadItem(id: number, cls?: ReqClass): Promise<ItemDetail> {
    const d = await this.api.item(id, cls);
    const compact = compactItem(d);
    this.cache.get(cacheKeys.itemCompact(id), ITEM_COMPACT, async () => compact, { force: true }).catch(noop);
    return d;
  }
}
