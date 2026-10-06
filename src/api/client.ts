import { KP_CLIENT } from "../config/client.ts";
import { KpError, isKpError } from "../core/errors.ts";
import type {
  BookmarkFolder, Collection, DeviceCode, DeviceInfo, DeviceSettings, Genre, HistoryEntry, ItemDetail, ItemSummary, MediaLinks,
  Page, SerialWatching, ServerLocation, TokenPairRaw, TvChannel, User, WatchingUnit,
} from "./models.ts";
import {
  errorText, num, obj, objs, parseBookmarkFolder, parseCollection, parseDeviceCode, parseDeviceInfo, parseGenre, parseHistory,
  parseHistoryPage, parseItemDetail, parseItemList, parseItems, parseListItem, parseMediaLinks, parsePage, parseSerialWatching,
  parseServerLocation, parseToggle, parseTokenPair, parseTvChannel, parseUser, parseWatching, str,
} from "./parse.ts";
import type { ApiRequest, ApiResponse, Priority, ReqClass, RetryPolicy, Transport } from "./transport.ts";

export interface TokenSource { access(): { token: string; gen: number } | undefined; refresh(gen: number): Promise<void> }
export type DeviceTokenResult = { kind: "ok"; pair: TokenPairRaw } | { kind: "pending" | "slow_down" | "expired" | "denied" };

// Таймауты спец. §5.2.
const CATALOG_MS = 8000;
const ITEM_MS = 15_000;
const OAUTH_MS = 15_000;
const LINKS_MS: Record<ReqClass, number> = { fg: 6000, bg: 10_000 };
const PROGRESS_MS = 5000;
// У /v1/history perpage больше 50 — ошибка 400 (research kinopub-api §8.3).
const HISTORY_MAX_PERPAGE = 50;

type Query = Record<string, string | number | undefined>;
type Form = Record<string, string | number>;

/** `Priority` вместо класса — запрос, который single-flight кэша может повысить с фона (`Repo`). */
type Cls = ReqClass | Priority;

interface Call { method?: "GET" | "POST"; path: string; query?: Query; form?: Form; retry?: RetryPolicy; timeoutMs?: number; cls?: Cls }

const SETTING_KEYS: readonly (keyof DeviceSettings)[] = ["supportSsl", "supportHevc", "supportHdr", "support4k", "mixedPlaylist"];

function httpError(res: ApiResponse, code: number): KpError {
  const detail = errorText(res.json);
  return code === 404 ? new KpError("KP-404", "not-found", code, detail) : new KpError("KP-BAD", `http-${code}`, code, detail);
}

/** Тело ответа или KpError: HTTP 4xx, а также 2xx с `status` ≥ 400 в теле (research kinopub-api §3, §9.1). */
function body(res: ApiResponse): unknown {
  const inBody = num(obj(res.json).status);
  const code = res.status >= 400 ? res.status : inBody >= 400 ? inBody : 0;
  if (code !== 0) throw httpError(res, code);
  return res.json;
}

function pairOf(json: unknown): TokenPairRaw {
  const pair = parseTokenPair(json);
  if (pair.access === "" || pair.refresh === "") throw new KpError("KP-BAD", "bad-token-pair");
  return pair;
}

const oauthError = (json: unknown): string => str(obj(json).error);

/**
 * Клиент API KinoPub (план §0.6.5, спец. §5.2–5.3). Токен — только `?access_token=`; OAuth — POST с параметрами
 * в query и пустым телом. Повторы при сбоях делает транспорт по `retry`; здесь — один повтор после 401 и refresh.
 */
export class KpApi {
  private t: Transport;
  private tokens: TokenSource;

  constructor(t: Transport, tokens: TokenSource) {
    this.t = t;
    this.tokens = tokens;
  }

  // --- OAuth (research kinopub-api §4) ---

  async deviceCode(): Promise<DeviceCode> {
    const dc = parseDeviceCode(body(await this.oauth("/oauth2/device", { grant_type: "device_code" })));
    if (dc.code === "" || dc.userCode === "") throw new KpError("KP-BAD", "bad-device-code");
    return dc;
  }

  /** 400 `authorization_pending` → pending, `slow_down`, `code_expired`/`authorization_expired` → expired, прочие 400 → denied. */
  async deviceToken(code: string): Promise<DeviceTokenResult> {
    const res = await this.oauth("/oauth2/device", { grant_type: "device_token", code });
    const err = oauthError(res.json);
    if (res.status < 300 && err === "") return { kind: "ok", pair: pairOf(res.json) };
    if (res.status >= 300 && res.status !== 400) throw httpError(res, res.status);
    switch (err) {
      case "authorization_pending": return { kind: "pending" };
      case "slow_down": return { kind: "slow_down" };
      case "code_expired":
      case "authorization_expired": return { kind: "expired" };
      default: return { kind: "denied" };
    }
  }

  /** Без автоповтора (спец. §5.3, CM-01): refresh ротирует пару. 400 — отказ `KP-AUTH`; 401 так же классифицирует транспорт. */
  async refreshToken(refresh: string): Promise<TokenPairRaw> {
    const res = await this.oauth("/oauth2/token", { grant_type: "refresh_token", refresh_token: refresh });
    const err = oauthError(res.json);
    if (res.status === 400 || (res.status < 300 && err !== "")) {
      throw new KpError("KP-AUTH", "refresh-rejected", res.status, err || undefined);
    }
    return pairOf(body(res));
  }

  // --- Устройство (research kinopub-api §4.4, §5) ---

  async deviceNotify(title: string, hardware: string, software: string): Promise<void> {
    await this.call({ method: "POST", path: "/v1/device/notify", form: { title, hardware, software } });
  }

  async deviceInfo(): Promise<DeviceInfo> {
    const info = parseDeviceInfo(await this.call({ path: "/v1/device/info" }));
    if (info.id <= 0) throw new KpError("KP-BAD", "bad-device");
    return info;
  }

  async deviceSettingsSave(id: number, s: Partial<DeviceSettings>): Promise<void> {
    const form: Form = {};
    for (const k of SETTING_KEYS) {
      const v = s[k];
      if (v !== undefined) form[k] = v;
    }
    await this.call({ method: "POST", path: `/v1/device/${id}/settings`, form });
  }

  async deviceUnlink(): Promise<void> {
    await this.call({ method: "POST", path: "/v1/device/unlink", retry: "none" });
  }

  // --- Пользователь и справочники ---

  async user(cls?: Cls): Promise<User> {
    return parseUser(await this.call({ path: "/v1/user", cls }));
  }

  async genres(type: string): Promise<Genre[]> {
    return parseItems(await this.call({ path: "/v1/genres", query: { type } }), parseGenre);
  }

  async serverLocations(): Promise<ServerLocation[]> {
    return parseItems(await this.call({ path: "/v1/references/server-location" }), parseServerLocation);
  }

  async voiceoverTypes(): Promise<{ id: number; title: string }[]> {
    return parseItems(await this.call({ path: "/v1/references/voiceover-type" }), parseGenre);
  }

  // --- Каталог (research kinopub-api §6–§7) ---

  /** `quality` — id качества «не ниже»: `4` — 4K (research kinopub-api §6.1). */
  async items(
    q: { type?: string; genre?: string; sort?: string; quality?: string; page: number; perpage: number }, cls?: Cls,
  ): Promise<Page<ItemSummary>> {
    const query = { type: q.type, genre: q.genre, sort: q.sort, quality: q.quality, page: q.page, perpage: q.perpage };
    return parsePage(await this.call({ path: "/v1/items", query, cls }), parseListItem);
  }

  async shelf(
    kind: "fresh" | "popular" | "hot", q: { type?: string; genre?: string; page: number; perpage: number }, cls?: Cls,
  ): Promise<Page<ItemSummary>> {
    const query = { type: q.type, genre: q.genre, page: q.page, perpage: q.perpage };
    return parsePage(await this.call({ path: `/v1/items/${kind}`, query, cls }), parseListItem);
  }

  /** `field=title` — релевантный поиск по названию (research kinopub-api §6.1). */
  async search(q: string, page: number, perpage: number): Promise<Page<ItemSummary>> {
    return parsePage(await this.call({ path: "/v1/items/search", query: { q, field: "title", page, perpage } }), parseListItem);
  }

  /** `nolinks=1`: без ссылок на поток, но с лестницей файлов, озвучками и прогрессом (research kinopub-api §6.3). */
  async item(id: number, cls?: Cls): Promise<ItemDetail> {
    const d = parseItemDetail(await this.call({ path: `/v1/items/${id}`, query: { nolinks: 1 }, timeoutMs: ITEM_MS, cls }));
    if (d.id <= 0) throw new KpError("KP-BAD", "bad-item");
    return d;
  }

  /** Подборки (research kinopub-api §6.1): `sort` — `-created`, `-watchers`, `-views`. */
  async collections(q: { sort: string; page: number; perpage: number }, cls?: Cls): Promise<Page<Collection>> {
    return parsePage(await this.call({ path: "/v1/collections", query: q, cls }), parseCollection);
  }

  async collectionItems(id: number, page: number, perpage: number, cls?: Cls): Promise<Page<ItemSummary>> {
    const json = await this.call({ path: "/v1/collections/view", query: { id, page, perpage }, cls });
    const out = parsePage(json, parseListItem);
    const title = str(obj(obj(json).collection).title);
    if (title !== "") out.title = title;
    return out;
  }

  /** Каналы прямого эфира — раздел «Спорт» официальных клиентов (`sporttv`); пагинации нет. */
  async tv(cls?: Cls): Promise<TvChannel[]> {
    return objs(obj(await this.call({ path: "/v1/tv", cls })).channels).map(parseTvChannel).filter((c) => c.id > 0 && c.stream !== "");
  }

  async similar(id: number, cls?: Cls): Promise<ItemSummary[]> {
    return parseItemList(await this.call({ path: "/v1/items/similar", query: { id }, cls }));
  }

  /** `mid` — id видео или серии, не тайтла; ответ без `status`, ссылки в `urls` (research kinopub-api §7.1). */
  async mediaLinks(mid: number, cls: Cls): Promise<MediaLinks> {
    const timeoutMs = LINKS_MS[typeof cls === "string" ? cls : cls.cls()];
    return parseMediaLinks(await this.call({ path: "/v1/items/media-links", query: { mid }, timeoutMs, cls }), mid);
  }

  // --- Просмотры (research kinopub-api §8.1) ---

  async watching(id: number, cls?: Cls): Promise<WatchingUnit[]> {
    return parseWatching(await this.call({ path: "/v1/watching", query: { id }, cls }));
  }

  /** `video` и `season` — номера, не id; `season` только у сериала. Позиция абсолютная, поэтому повтор безопасен. */
  async marktime(id: number, video: number, time: number, season?: number, cls?: Cls): Promise<void> {
    const query = { id, video, time: Math.max(0, Math.floor(time)), season };
    await this.call({ path: "/v1/watching/marktime", query, timeoutMs: PROGRESS_MS, cls });
  }

  /** Переключатель: не повторяется вслепую (спец. §5.3, CM-01); ответ — новое состояние. */
  async toggle(id: number, video: number, season?: number, cls?: Cls): Promise<{ watched: 0 | 1 }> {
    const query = { id, video, season };
    return parseToggle(await this.call({ path: "/v1/watching/toggle", query, retry: "none", timeoutMs: PROGRESS_MS, cls }));
  }

  async history(page: number, perpage: number, cls?: Cls): Promise<HistoryEntry[]> {
    return parseHistory(await this.historyRaw(page, perpage, cls));
  }

  /** «История» списком: тайтлы записей и `pagination`. */
  async historyPage(page: number, perpage: number, cls?: Cls): Promise<Page<ItemSummary>> {
    return parseHistoryPage(await this.historyRaw(page, perpage, cls));
  }

  /** `subscribed` — только «Я смотрю» (список «Буду смотреть», как у Kodi и других клиентов). */
  async watchingSerials(cls?: Cls, subscribed?: boolean): Promise<SerialWatching[]> {
    const query = subscribed === true ? { subscribed: 1 } : undefined;
    return parseItems(await this.call({ path: "/v1/watching/serials", query, cls }), parseSerialWatching);
  }

  async watchingMovies(cls?: Cls): Promise<ItemSummary[]> {
    return parseItemList(await this.call({ path: "/v1/watching/movies", cls }));
  }

  // --- Закладки (research kinopub-api §8.2) ---

  async bookmarkFolders(cls?: Cls): Promise<BookmarkFolder[]> {
    return parseItems(await this.call({ path: "/v1/bookmarks", cls }), parseBookmarkFolder);
  }

  async bookmarkFolder(id: number, page: number, perpage: number, cls?: Cls): Promise<Page<ItemSummary>> {
    return parsePage(await this.call({ path: `/v1/bookmarks/${id}`, query: { page, perpage }, cls }), parseListItem);
  }

  /** Без автоповтора: повтор создал бы вторую папку. */
  async bookmarkCreate(title: string): Promise<BookmarkFolder> {
    const json = obj(await this.call({ method: "POST", path: "/v1/bookmarks/create", form: { title }, retry: "none" }));
    const folder = parseBookmarkFolder(json.folder);
    if (folder.id <= 0) throw new KpError("KP-BAD", "bad-folder");
    return folder;
  }

  async bookmarkAdd(item: number, folder: number): Promise<void> {
    await this.call({ method: "POST", path: "/v1/bookmarks/add", form: { item, folder } });
  }

  async bookmarkRemove(item: number, folder: number): Promise<void> {
    await this.call({ method: "POST", path: "/v1/bookmarks/remove-item", form: { item, folder } });
  }

  /** Сырой ответ для отпечатка схемы в пробнике. */
  raw(path: string, query?: Record<string, string | number>): Promise<unknown> {
    return this.call(query === undefined ? { path } : { path, query });
  }

  // --- Внутреннее ---

  private historyRaw(page: number, perpage: number, cls?: Cls): Promise<unknown> {
    return this.call({ path: "/v1/history", query: { page, perpage: Math.min(perpage, HISTORY_MAX_PERPAGE) }, cls });
  }

  private oauth(path: string, params: Record<string, string>): Promise<ApiResponse> {
    const { grant_type, ...rest } = params;
    const query: Query = { grant_type, client_id: KP_CLIENT.id, client_secret: KP_CLIENT.secret, ...rest };
    return this.t.send({ method: "POST", path, query, retry: "none", timeoutMs: OAUTH_MS, cls: "fg" });
  }

  /** Запрос с токеном; 401 → `tokens.refresh(gen)` → ровно один повтор (сервер отклонил запрос до выполнения, спец. §5.3). */
  private async call(c: Call): Promise<unknown> {
    const first = this.tokens.access();
    if (first === undefined) throw new KpError("KP-AUTH", "no-token");
    try {
      return body(await this.t.send(this.request(c, first.token)));
    } catch (e) {
      if (!isKpError(e) || e.code !== "KP-AUTH" || e.status !== 401) throw e;
      await this.tokens.refresh(first.gen);
      const next = this.tokens.access();
      if (next === undefined) throw e;
      return body(await this.t.send(this.request(c, next.token)));
    }
  }

  private request(c: Call, token: string): ApiRequest {
    const cls = c.cls ?? "fg";
    const req: ApiRequest = {
      method: c.method ?? "GET", path: c.path, query: { ...c.query, access_token: token },
      retry: c.retry ?? "auto", timeoutMs: c.timeoutMs ?? CATALOG_MS, cls: typeof cls === "string" ? cls : cls.cls(),
    };
    if (typeof cls !== "string") req.prio = cls;
    if (c.form !== undefined) req.form = c.form;
    return req;
  }
}
