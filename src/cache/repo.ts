import type { KpApi } from "../api/client.ts";
import type {
  BookmarkFolder, DeviceInfo, FileInfo, Genre, HistoryEntry, ItemDetail, ItemSummary, MediaLinks, MediaUnit, Page,
  Season, SerialWatching, ServerLocation, Titled, TvChannel, User,
} from "../api/models.ts";
import { Priority } from "../api/transport.ts";
import type { ReqClass } from "../api/transport.ts";
import { b64urlEncode } from "../core/b64url.ts";
import type { Clock } from "../core/clock.ts";
import { KpError, toKpError } from "../core/errors.ts";
import type { Logger } from "../core/log.ts";
import type { Got, Policy, SwrCache } from "./swr.ts";

export type ListSource = { kind: "catalog"; type?: string; sort: string; genre?: string; quality?: string }
  | { kind: "shelf"; shelf: "fresh" | "popular" | "hot"; type: string }
  | { kind: "folder"; folder: number } | { kind: "similar"; id: number }
  | { kind: "history" } | { kind: "collections"; sort: string } | { kind: "collection"; id: number };

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const WEEK = 7 * 24 * HOUR;

const PER_PAGE = 48;
const SHELF_SIZE = 7;
const HISTORY_PER_PAGE = 50;
const PLOT_MAX = 600;
/** Спец. §8.1: в L2 — последние 30 карточек в компактной модели. */
const L2_CARDS_MAX = 30;
/** Plan B D-41: resolve ждёт обновления карточки старше 600 с не дольше 500 мс. */
const D41_FRESH_MS = 600_000;
const D41_WAIT_MS = 500;
const TAG = "repo";

const pol = (ttlMs: number, staleMaxMs: number, persist: boolean): Policy => ({ ttlMs, staleMaxMs, persist });

// TTL и stale-max — Plan B §7.2 (спец. §8.2). L2 — только то, что нужно холодному старту (спец. §8.1).
const REFS = pol(24 * HOUR, WEEK, true);
const USER = pol(HOUR, WEEK, true);
// Настройки устройства KinoPub: в L2 их нет — на холодном старте их ждёт только экран настроек.
const DEVICE = pol(HOUR, WEEK, false);
const LIST = pol(10 * MIN, WEEK, true);
// Содержимое папки закладок — 120 с (Plan B §7.2), не 10 мин каталога.
const FOLDER = pol(2 * MIN, WEEK, true);
const SHELF = pol(10 * MIN, WEEK, true);
const SEARCH = pol(5 * MIN, HOUR, false);
const ITEM_FULL = pol(10 * MIN, WEEK, false);
const ITEM_COMPACT = pol(10 * MIN, WEEK, true);
const SIMILAR = pol(HOUR, WEEK, false);
const PERSONAL = pol(MIN, WEEK, true);
// Каналы эфира: адреса потока могут быть подписаны — только L1 (как ссылки на поток), час без сети — из кэша.
const TV = pol(2 * MIN, HOUR, false);
const BOOKMARKS = pol(5 * MIN, WEEK, true);
// Ссылки на поток подписаны и привязаны к IP ТВ: только L1, 600 с с момента получения, просроченные не отдаются (спец. §8.2).
const LINKS = pol(600 * SEC, 0, false);

const memOnly = (p: Policy): Policy => ({ ...p, persist: false });
const noop = (): void => undefined;
const opt = (s: string | undefined): string | undefined => (s === "" ? undefined : s);

/** Канонический JSON источника: фиксированный порядок полей, без пустых. */
function sourceJson(src: ListSource): string {
  switch (src.kind) {
    case "catalog": return JSON.stringify({ kind: src.kind, type: opt(src.type), sort: src.sort, genre: opt(src.genre), quality: opt(src.quality) });
    case "shelf": return JSON.stringify({ kind: src.kind, shelf: src.shelf, type: src.type });
    case "folder": return JSON.stringify({ kind: src.kind, folder: src.folder });
    case "similar":
    case "collection": return JSON.stringify({ kind: src.kind, id: src.id });
    case "history": return JSON.stringify({ kind: src.kind });
    case "collections": return JSON.stringify({ kind: src.kind, sort: src.sort });
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
  device: (): string => key("device"),
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
  /** Префикс и сериалов «Продолжить», и «Я смотрю» (`subscribed`, ключ `serials:1:`): одна пометка после просмотра. */
  serials: (subscribed?: boolean): string => (subscribed === true ? key("serials", 1) : key("serials")),
  movies: (): string => key("movies"),
  bookmarks: (): string => key("bm"),
  tv: (): string => key("tv"),
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
  private trimQueued = false;
  /** Фоновые загрузки в полёте по ключу кэша. */
  private lanes = new Map<string, Priority>();

  constructor(deps: { api: KpApi; cache: SwrCache; clock: Clock; log: Logger }) {
    this.api = deps.api;
    this.cache = deps.cache;
    this.clock = deps.clock;
    this.log = deps.log;
  }

  /** `opts.cls` здесь и у полок главной — класс запроса для лимитера: прогрев и фоновые сверки идут `bg` (спец. §8.5). */
  user(opts?: { cls?: ReqClass }): Promise<Got<User>> {
    const k = cacheKeys.user();
    return this.cache.get(k, USER, this.loader(k, opts?.cls, (c) => this.api.user(c)));
  }

  /** Только L1/L2, без сети (resolve проверяет подписку, не дожидаясь API). */
  peekUser(): Got<User> | undefined {
    return this.cache.peek<User>(cacheKeys.user());
  }

  genres(type: string): Promise<Got<Genre[]>> {
    return this.cache.get(cacheKeys.genres(type), REFS, () => this.api.genres(type));
  }

  /**
   * `device/info` (Plan B §7.2): 1 ч, затем SWR. `fresh` — в обход кэша, ответ заменяет закэшированный (сверка после
   * POST настроек, Plan B §6.2.1); при сбое сети — прежнее значение с `offline`, как у `SwrCache.get`.
   */
  deviceInfo(opts?: { fresh?: boolean }): Promise<Got<DeviceInfo>> {
    return this.cache.get(cacheKeys.device(), DEVICE, () => this.api.deviceInfo(), opts?.fresh === true ? { force: true } : undefined);
  }

  serverLocations(): Promise<Got<ServerLocation[]>> {
    return this.cache.get(cacheKeys.locations(), REFS, () => this.api.serverLocations());
  }

  voiceoverTypes(): Promise<Got<{ id: number; title: string }[]>> {
    return this.cache.get(cacheKeys.voiceovers(), REFS, () => this.api.voiceoverTypes());
  }

  /**
   * По 48 на страницу; в L2 — только первая порция раздела. `opts.cls` — класс запроса для лимитера (спец. §8.3).
   * «История» — персональная, как полки «Продолжить» (1 мин).
   */
  listPage(src: ListSource, page: number, opts?: { cls?: ReqClass }): Promise<Got<Page<Titled>>> {
    const cls = opts?.cls;
    if (src.kind === "similar") return this.similarPage(src.id, page, cls);
    const base = src.kind === "folder" ? FOLDER : src.kind === "history" ? PERSONAL : LIST;
    const k = cacheKeys.list(src, page);
    return this.cache.get(k, page === 1 ? base : memOnly(base), this.loader(k, cls, (c) => this.loadList(src, page, c)));
  }

  shelf(kind: "fresh" | "popular" | "hot", type: string, opts?: { cls?: ReqClass }): Promise<Got<ItemSummary[]>> {
    const k = cacheKeys.shelf(kind, type);
    return this.cache.get(k, SHELF, this.loader(k, opts?.cls, async (c) =>
      (await this.api.shelf(kind, { type, page: 1, perpage: SHELF_SIZE }, c)).items));
  }

  /** Только L1/L2, без сети: подборку из кэша главная показывает сразу и обновляет фоном (спец. §8.4 п. 1). */
  peekShelf(kind: "fresh" | "popular" | "hot", type: string): Got<ItemSummary[]> | undefined {
    return this.cache.peek<ItemSummary[]>(cacheKeys.shelf(kind, type));
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

  history(opts?: { cls?: ReqClass }): Promise<Got<HistoryEntry[]>> {
    const k = cacheKeys.history();
    return this.cache.get(k, PERSONAL, this.loader(k, opts?.cls, (c) => this.api.history(1, HISTORY_PER_PAGE, c)));
  }

  serials(opts?: { cls?: ReqClass; subscribed?: boolean }): Promise<Got<SerialWatching[]>> {
    const k = cacheKeys.serials(opts?.subscribed);
    return this.cache.get(k, PERSONAL, this.loader(k, opts?.cls, (c) => this.api.watchingSerials(c, opts?.subscribed)));
  }

  watchingMovies(opts?: { cls?: ReqClass }): Promise<Got<ItemSummary[]>> {
    const k = cacheKeys.movies();
    return this.cache.get(k, PERSONAL, this.loader(k, opts?.cls, (c) => this.api.watchingMovies(c)));
  }

  tv(): Promise<Got<TvChannel[]>> {
    return this.cache.get(cacheKeys.tv(), TV, () => this.api.tv());
  }

  bookmarkFolders(opts?: { cls?: ReqClass }): Promise<Got<BookmarkFolder[]>> {
    const k = cacheKeys.bookmarks();
    return this.cache.get(k, BOOKMARKS, this.loader(k, opts?.cls, (c) => this.api.bookmarkFolders(c)));
  }

  /** Только L1, 600 с; префетч и resolve одного `mid` делят один запрос. `fresh` — в обход кэша (шаг 2 fallback). */
  async links(mid: number, opts: { cls: ReqClass; fresh?: boolean }): Promise<MediaLinks> {
    let failure: unknown;
    const k = cacheKeys.links(mid);
    const load = this.loader(k, opts.cls, async (c): Promise<MediaLinks> => {
      try {
        return await this.api.mediaLinks(mid, c);
      } catch (e) {
        failure = e;
        throw e;
      }
    });
    const got = await this.cache.get(k, LINKS, load, opts.fresh === true ? { force: true } : undefined);
    // SwrCache при сбое сети отдаёт прежнюю запись с `offline`; для ссылок это недопустимо.
    if (got.offline !== undefined) throw failure ?? new KpError(got.offline, "links-unavailable");
    // Пустой или битый ответ (200 без потоков) не держим 600 с: следующий шаг fallback сразу берёт свежие.
    if (!got.value.files.some((f) => f.urls.hls !== undefined || f.urls.hls2 !== undefined)) this.cache.delete(k);
    return got.value;
  }

  /** Plan B §7.3: пометка, а не удаление — экраны продолжают показывать прежнее с оверлеем, пока идёт обновление. */
  invalidateAfterProgress(itemId: number): void {
    this.cache.markStale(cacheKeys.item(itemId));
    this.cache.markStale(cacheKeys.history());
    this.cache.markStale(cacheKeys.serials());
    this.cache.markStale(cacheKeys.movies());
    this.cache.markStale(cacheKeys.listSource({ kind: "history" }));
  }

  /** Выход из KinoPub: устройство отвязано, следующий вход создаст другое — с другим id и настройками. */
  forgetDevice(): void {
    this.cache.delete(cacheKeys.device());
  }

  /** Plan B §7.3: настройки устройства меняют набор `files[]` — ссылки на поток устарели (stale-max 0: не отдаются). */
  invalidateAfterDevice(): void {
    this.cache.markStale(key("links"));
  }

  invalidateAfterBookmark(itemId: number, folderId: number): void {
    this.cache.markStale(cacheKeys.bookmarks());
    this.cache.markStale(cacheKeys.item(itemId));
    this.cache.markStale(cacheKeys.listSource({ kind: "folder", folder: folderId }));
  }

  // --- Внутреннее ---

  /**
   * Загрузка ключа для `SwrCache.get`. Single-flight отдаёт одну загрузку всем, кто ждёт ключ, поэтому её класс —
   * старший из их классов: фоновая идёт с `Priority`, а передний план, пришедший к тому же ключу, её повышает —
   * иначе экран ждал бы в очереди фоновых и получал бы `bg-dropped` (спец. §8.3, §8.5).
   */
  private loader<T>(key: string, cls: ReqClass | undefined, load: (cls: ReqClass | Priority) => Promise<T>): () => Promise<T> {
    if (cls !== "bg") {
      this.lanes.get(key)?.promote();
      return () => load(cls ?? "fg");
    }
    return async () => {
      const prio = new Priority("bg");
      this.lanes.set(key, prio);
      try {
        return await load(prio);
      } finally {
        if (this.lanes.get(key) === prio) this.lanes.delete(key);
      }
    };
  }

  private loadList(src: Exclude<ListSource, { kind: "similar" }>, page: number, cls: ReqClass | Priority): Promise<Page<Titled>> {
    switch (src.kind) {
      case "catalog":
        return this.api.items({ type: opt(src.type), genre: opt(src.genre), sort: src.sort, quality: opt(src.quality), page, perpage: PER_PAGE }, cls);
      case "shelf":
        return this.api.shelf(src.shelf, { type: src.type, page, perpage: PER_PAGE }, cls);
      case "folder":
        return this.api.bookmarkFolder(src.folder, page, PER_PAGE, cls);
      case "history":
        return this.api.historyPage(page, PER_PAGE, cls);
      case "collections":
        return this.api.collections({ sort: src.sort, page, perpage: PER_PAGE }, cls);
      case "collection":
        return this.api.collectionItems(src.id, page, PER_PAGE, cls);
    }
  }

  /** «Похожие» — одна страница; дальше пусто. */
  private async similarPage(id: number, page: number, cls?: ReqClass): Promise<Got<Page<ItemSummary>>> {
    const k = cacheKeys.similar(id);
    const got = await this.cache.get(k, SIMILAR, this.loader(k, cls, (c) => this.api.similar(id, c)));
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
    return this.cache.get(cacheKeys.item(id), ITEM_FULL, this.itemLoader(id, cls));
  }

  private refreshItem(id: number, cls?: ReqClass): Promise<Got<ItemDetail>> {
    return this.cache.get(cacheKeys.item(id), ITEM_FULL, this.itemLoader(id, cls), { force: true });
  }

  private itemLoader(id: number, cls?: ReqClass): () => Promise<ItemDetail> {
    return this.loader(cacheKeys.item(id), cls, (c) => this.loadItem(id, c));
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
  private async loadItem(id: number, cls: ReqClass | Priority): Promise<ItemDetail> {
    const d = await this.api.item(id, cls);
    const compact = compactItem(d);
    this.cache.get(cacheKeys.itemCompact(id), ITEM_COMPACT, async () => compact, { force: true }).then(() => this.queueTrim(), noop);
    return d;
  }

  /** Вне критического пути запроса (спец. §7.3): обрезка — отдельным таймером, одна на пачку карточек. */
  private queueTrim(): void {
    if (this.trimQueued) return;
    this.trimQueued = true;
    this.clock.setTimeout(() => {
      this.trimQueued = false;
      // Полная карточка в L2 не пишется, поэтому `item:` в L2 — только компактные копии `item:<id>:l2:`.
      const cards = this.cache.persistedKeys("item:");
      for (const k of cards.slice(0, Math.max(0, cards.length - L2_CARDS_MAX))) this.cache.delete(k);
    }, 0);
  }
}
