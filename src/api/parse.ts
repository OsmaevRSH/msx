import type {
  Audio, BookmarkFolder, Collection, DeviceCode, DeviceInfo, DeviceSettings, FileInfo, Genre, HistoryEntry, ItemDetail, ItemSummary,
  ItemType, MediaLinks, MediaUnit, Page, Pagination, Posters, Season, SerialWatching, ServerLocation, StreamKind, Subtitle,
  TokenPairRaw, TvChannel, User, WatchingUnit, WatchState,
} from "./models.ts";

// Толерантный разбор ответов KinoPub (research kinopub-api §3–§8, Plan B §12.2): числа строкой, `url` и `urls`,
// пустые строки, `null` и отсутствующие поля исключений не бросают — подставляются значения по умолчанию.
// Не-объекты внутри массивов пропускаются.

type Obj = Record<string, unknown>;

export function isObj(x: unknown): x is Obj {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function obj(x: unknown): Obj {
  return isObj(x) ? x : {};
}

/** Только объекты из массива; не массив — пусто. */
export function objs(x: unknown): Obj[] {
  return Array.isArray(x) ? x.filter(isObj) : [];
}

export function num(x: unknown, def = 0): number {
  if (typeof x === "number") return Number.isFinite(x) ? x : def;
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    return Number.isFinite(n) ? n : def;
  }
  return def;
}

export function optNum(x: unknown): number | undefined {
  const n = num(x, Number.NaN);
  return Number.isNaN(n) ? undefined : n;
}

export function str(x: unknown, def = ""): string {
  if (typeof x === "string") return x;
  if (typeof x === "number" && Number.isFinite(x)) return String(x);
  return def;
}

function optStr(x: unknown): string | undefined {
  const s = str(x);
  return s.trim() === "" ? undefined : s;
}

export function bool01(x: unknown): 0 | 1 {
  if (typeof x === "boolean") return x ? 1 : 0;
  if (typeof x === "string" && /^\s*true\s*$/i.test(x)) return 1;
  return num(x) !== 0 ? 1 : 0;
}

const bool = (x: unknown): boolean => bool01(x) === 1;

function put<T extends object, K extends keyof T>(o: T, k: K, v: T[K] | undefined): void {
  if (v !== undefined) o[k] = v;
}

function watchStatus(x: unknown): -1 | 0 | 1 | undefined {
  const n = num(x, Number.NaN);
  return n === 1 || n === 0 || n === -1 ? n : undefined;
}

const ITEM_TYPES: readonly string[] = ["movie", "serial", "3D", "concert", "documovie", "docuserial", "tvshow"];
const isItemType = (x: unknown): x is ItemType => typeof x === "string" && ITEM_TYPES.includes(x);
/** Живые ответы пишут `3d` строчными (research kinopub-api §6.1). */
const itemType = (x: unknown, def: ItemType): ItemType => (x === "3d" ? "3D" : isItemType(x) ? x : def);

function refs(x: unknown): { id: number; title: string }[] {
  return objs(x).map((g) => ({ id: num(g.id), title: str(g.title) })).filter((g) => g.title !== "");
}

export function parsePosters(x: unknown): Posters {
  const p = obj(x);
  const small = str(p.small);
  const medium = str(p.medium);
  const big = str(p.big);
  const out: Posters = { small: small || medium || big, medium: medium || big || small, big: big || medium || small };
  put(out, "wide", optStr(p.wide));
  return out;
}

/** Элемент списка `/v1/items*` (research §6.2). */
export function parseItemSummary(x: unknown): ItemSummary {
  const o = obj(x);
  const out: ItemSummary = {
    id: num(o.id), type: itemType(o.type, "movie"), subtype: str(o.subtype), title: str(o.title),
    genres: refs(o.genres),
    countries: (Array.isArray(o.countries) ? o.countries : []).map((c) => (isObj(c) ? str(c.title) : str(c))).filter((c) => c !== ""),
    quality: num(o.quality), posters: parsePosters(o.posters),
  };
  const year = optNum(o.year);
  if (year !== undefined && year > 0) out.year = year;
  put(out, "imdbRating", optNum(o.imdb_rating));
  put(out, "kpRating", optNum(o.kinopoisk_rating));
  put(out, "durationAvg", isObj(o.duration) ? optNum(o.duration.average) : optNum(o.duration));
  put(out, "plot", optStr(o.plot));
  return out;
}

/** Элемент списка с настоящим id или undefined (для пропуска мусора). */
export function parseListItem(x: unknown): ItemSummary | undefined {
  const it = parseItemSummary(x);
  return it.id > 0 ? it : undefined;
}

export function parseAudio(x: unknown, pos = 0): Audio {
  const o = obj(x);
  const out: Audio = { id: num(o.id), index: num(o.index, pos + 1), codec: str(o.codec), channels: num(o.channels), lang: str(o.lang) };
  if (isObj(o.type)) {
    put(out, "typeId", optNum(o.type.id));
    put(out, "typeTitle", optStr(o.type.title));
  } else {
    put(out, "typeTitle", optStr(o.type));
  }
  if (isObj(o.author)) {
    put(out, "authorId", optNum(o.author.id));
    put(out, "authorTitle", optStr(o.author.title));
  }
  return out;
}

const STREAM_KINDS: readonly StreamKind[] = ["http", "hls", "hls2", "hls4"];

/** Ссылки — из `url` (`items/{id}`) и `urls` (`media-links`), `urls` важнее; пустая строка — такого типа нет (research §7.1). */
export function parseFile(x: unknown): FileInfo {
  const o = obj(x);
  const urls: Partial<Record<StreamKind, string>> = {};
  for (const src of [obj(o.url), obj(o.urls)]) {
    for (const k of STREAM_KINDS) {
      const v = str(src[k]).trim();
      if (v !== "") urls[k] = v;
    }
  }
  return {
    codec: str(o.codec), w: num(o.w), h: num(o.h), quality: str(o.quality), qualityId: num(o.quality_id, num(o.qualityId)),
    file: str(o.file), urls,
  };
}

export function parseSubtitle(x: unknown): Subtitle {
  const o = obj(x);
  return { lang: str(o.lang), shift: num(o.shift), embed: bool(o.embed), forced: bool(o.forced), url: str(o.url) };
}

/** `watching.{status,time}` карточки или плоские `status`/`time` из `/v1/watching?id=`; без статуса — по `watched` и `time`. */
export function parseWatchState(x: unknown): WatchState {
  const o = obj(x);
  const w = obj(o.watching);
  const time = Math.max(0, num(w.time, num(o.time)));
  const status = watchStatus(w.status) ?? watchStatus(o.status) ?? (bool(o.watched) ? 1 : time > 0 ? 0 : -1);
  return { status, time };
}

/** Видео фильма (`snumber` 0) или серия сезона `season`; без номера — позиция в списке с 1. */
export function parseMediaUnit(x: unknown, pos = 0, season = 0): MediaUnit {
  const o = obj(x);
  const out: MediaUnit = {
    id: num(o.id), number: num(o.number, pos + 1), snumber: num(o.snumber, season), title: str(o.title), duration: num(o.duration),
    audios: objs(o.audios).map((a, i) => parseAudio(a, i)), files: objs(o.files).map((f) => parseFile(f)),
    subtitles: objs(o.subtitles).map((s) => parseSubtitle(s)), watching: parseWatchState(o),
  };
  put(out, "thumbnail", optStr(o.thumbnail));
  return out;
}

function parseSeason(x: Obj, pos: number): Season {
  const number = num(x.number, pos + 1);
  return { id: num(x.id), number, title: str(x.title), episodes: objs(x.episodes).map((e, i) => parseMediaUnit(e, i, number)) };
}

/** Полная карточка `/v1/items/{id}` (research §6.3); принимает и ответ `{item}`, и сам `item`. */
export function parseItemDetail(x: unknown): ItemDetail {
  const o = isObj(x) && isObj(x.item) ? x.item : obj(x);
  const seasons = objs(o.seasons).map((s, i) => parseSeason(s, i));
  const base = parseItemSummary(o);
  if (o.type !== "3d" && !isItemType(o.type) && seasons.some((s) => s.episodes.length > 0)) base.type = "serial";
  const bookmarks = (Array.isArray(o.bookmarks) ? o.bookmarks : []).map((b) => num(isObj(b) ? b.id : b)).filter((id) => id > 0);
  const out: ItemDetail = { ...base, videos: objs(o.videos).map((v, i) => parseMediaUnit(v, i, 0)), seasons, bookmarks };
  put(out, "voice", optStr(o.voice));
  if (o.finished !== undefined && o.finished !== null) out.finished = bool(o.finished);
  return out;
}

/** `media-links` приходит без `status` (research §7.1); субтитры без ссылки не нужны плееру. */
export function parseMediaLinks(x: unknown, mid?: number): MediaLinks {
  const o = obj(x);
  return {
    mid: mid ?? num(o.id), files: objs(o.files).map((f) => parseFile(f)),
    subtitles: objs(o.subtitles).map((s) => parseSubtitle(s)).filter((s) => s.url !== ""),
  };
}

/** Без `total_items` число найденного известно, только когда всё на одной странице: его не выдумываем. */
export function parsePagination(x: unknown, count: number): Pagination {
  const p = obj(x);
  const out: Pagination = { total: Math.max(0, num(p.total, 1)), current: Math.max(1, num(p.current, 1)), perpage: num(p.perpage, count) };
  put(out, "totalItems", optNum(p.total_items) ?? optNum(p.totalItems) ?? (out.total <= 1 ? count : undefined));
  return out;
}

/** `items[]` + `pagination` (`total_items` → `totalItems`); `item` возвращает undefined для мусора. */
export function parsePage<T>(x: unknown, item: (v: unknown) => T | undefined): Page<T> {
  const o = obj(x);
  const raw = Array.isArray(o.items) ? o.items : [];
  const items: T[] = [];
  for (const v of raw) {
    const it = item(v);
    if (it !== undefined) items.push(it);
  }
  return { items, pagination: parsePagination(o.pagination, raw.length) };
}

/** Список элементов каталога из поля `items` (полки без пагинации, `similar`, `watching/movies`). */
export function parseItemList(x: unknown): ItemSummary[] {
  return parsePage(x, parseListItem).items;
}

/** `/v1/history`: список в поле `history`, а не `items` (research §8.3). */
export function parseHistory(x: unknown): HistoryEntry[] {
  const list = Array.isArray(x) ? x : obj(x).history;
  const out: HistoryEntry[] = [];
  for (const e of objs(list)) {
    const item = parseListItem(e.item);
    if (!item) continue;
    const m = obj(e.media);
    out.push({
      item, media: { id: num(m.id), number: num(m.number), snumber: num(m.snumber), title: str(m.title), duration: num(m.duration) },
      time: num(e.time), lastSeen: num(e.last_seen),
    });
  }
  return out;
}

/** История страницей (`/v1/history?page=`): тайтлы записей по порядку, повторы убирает список. */
export function parseHistoryPage(x: unknown): Page<ItemSummary> {
  const raw = obj(x).history;
  return { items: parseHistory(x).map((e) => e.item), pagination: parsePagination(obj(x).pagination, Array.isArray(raw) ? raw.length : 0) };
}

/**
 * Подборка `/v1/collections` (research §6.1): постеры без `wide`. Числа тайтлов в ответе нет (доки «API 1.3», снимок
 * api2); если сервер его всё же пришлёт (`items_count` у Apple-клиента, `count` у aqualhume) — берём, иначе `count` нет.
 */
export function parseCollection(x: unknown): Collection | undefined {
  const o = obj(x);
  const c: Collection = { id: num(o.id), title: str(o.title), posters: parsePosters(o.posters) };
  const n = optNum(o.items_count ?? o.count);
  if (n !== undefined && n > 0) c.count = n;
  return c.id > 0 ? c : undefined;
}

/** Канал `/v1/tv`: без адреса эфира не нужен; логотип — `m`, иначе `s` или `l` (research §7.4). */
export function parseTvChannel(x: unknown): TvChannel {
  const o = obj(x);
  const l = obj(o.logos);
  return { id: num(o.id), title: str(o.title) || str(o.name), logo: str(l.m) || str(l.s) || str(l.l), stream: str(o.stream).trim() };
}

/** Элемент `/v1/watching/serials`: `total` приходит строкой (research §8.1). */
export function parseSerialWatching(x: unknown): SerialWatching {
  const o = obj(x);
  return {
    id: num(o.id), type: itemType(o.type, "serial"), title: str(o.title), posters: parsePosters(o.posters),
    total: num(o.total), watched: num(o.watched), new: num(o.new),
  };
}

function watchingUnit(x: Obj, pos: number, season: number): WatchingUnit {
  const w = parseWatchState(x);
  return { number: num(x.number, pos + 1), season, status: w.status, time: w.time, duration: num(x.duration) };
}

/** `/v1/watching?id=`: `item.videos[]` (сезон 0) или `item.seasons[].episodes[]`. */
export function parseWatching(x: unknown): WatchingUnit[] {
  const root = obj(x);
  const it = isObj(root.item) ? root.item : root;
  const out = objs(it.videos).map((v, i) => watchingUnit(v, i, 0));
  objs(it.seasons).forEach((s, si) => {
    const n = num(s.number, si + 1);
    objs(s.episodes).forEach((e, i) => out.push(watchingUnit(e, i, n)));
  });
  return out;
}

export function parseToggle(x: unknown): { watched: 0 | 1 } {
  const o = obj(x);
  if (o.watched !== undefined && o.watched !== null) return { watched: bool01(o.watched) };
  return { watched: watchStatus(obj(o.watching).status) === 1 ? 1 : 0 };
}

const SETTING_KEYS: readonly (keyof DeviceSettings)[] = ["supportSsl", "supportHevc", "supportHdr", "support4k", "mixedPlaylist"];

/** `/v1/device/info`: настройки в обёртке `{label, value, type}` (research §5.2); принимает `{device}` и само устройство. */
export function parseDeviceInfo(x: unknown): DeviceInfo {
  const root = obj(x);
  const d = isObj(root.device) ? root.device : root;
  const s = obj(d.settings);
  const settings = {} as DeviceSettings;
  for (const k of SETTING_KEYS) {
    const v = s[k];
    settings[k] = bool01(isObj(v) ? v.value : v);
  }
  const out: DeviceInfo = { id: num(d.id), title: str(d.title), hardware: str(d.hardware), software: str(d.software), settings };
  // Списочная настройка — массив вариантов с флагом `selected`.
  const sel = objs(obj(s.serverLocation).value).find((x) => num(x.selected) === 1);
  if (sel !== undefined) out.location = { id: num(sel.id), label: str(sel.label) };
  return out;
}

const DEFAULT_VERIFICATION_URI = "https://kino.watch/device";
const DEFAULT_INTERVAL_SEC = 5;
const DEFAULT_CODE_TTL_SEC = 600;
const DEFAULT_ACCESS_TTL_SEC = 3600;

/** Поле кода — `code`, а не `device_code`; `interval` бывает строкой, по умолчанию 5 (research §4.2). */
export function parseDeviceCode(x: unknown): DeviceCode {
  const o = obj(x);
  const interval = num(o.interval, DEFAULT_INTERVAL_SEC);
  const expiresIn = num(o.expires_in, DEFAULT_CODE_TTL_SEC);
  return {
    code: str(o.code) || str(o.device_code), userCode: str(o.user_code), verificationUri: optStr(o.verification_uri) ?? DEFAULT_VERIFICATION_URI,
    interval: interval > 0 ? interval : DEFAULT_INTERVAL_SEC, expiresIn: expiresIn > 0 ? expiresIn : DEFAULT_CODE_TTL_SEC,
  };
}

export function parseTokenPair(x: unknown): TokenPairRaw {
  const o = obj(x);
  const ttl = num(o.expires_in, DEFAULT_ACCESS_TTL_SEC);
  return { access: str(o.access_token), refresh: str(o.refresh_token), expiresIn: ttl > 0 ? ttl : DEFAULT_ACCESS_TTL_SEC };
}

export function parseUser(x: unknown): User {
  const root = obj(x);
  const u = isObj(root.user) ? root.user : root;
  const s = obj(u.subscription);
  return { username: str(u.username), subscription: { active: bool(s.active), endTime: num(s.end_time), days: num(s.days) } };
}

export function parseBookmarkFolder(x: unknown): BookmarkFolder {
  const o = obj(x);
  return { id: num(o.id), title: str(o.title), count: num(o.count) };
}

export function parseGenre(x: unknown): Genre {
  const o = obj(x);
  return { id: num(o.id), title: str(o.title) };
}

export function parseServerLocation(x: unknown): ServerLocation {
  const o = obj(x);
  return { id: num(o.id), location: str(o.location), name: str(o.name) };
}

/** Объекты из поля `items` с положительным id (справочники, папки закладок, сериалы в просмотре). */
export function parseItems<T extends { id: number }>(x: unknown, parse: (v: unknown) => T): T[] {
  return objs(obj(x).items).map((v) => parse(v)).filter((v) => v.id > 0);
}

/** Текст ошибки API (`error` OAuth и `/v1/*`, `message` старого формата Yii) для `KpError.detail`. */
export function errorText(x: unknown): string | undefined {
  const o = obj(x);
  const s = optStr(o.error) ?? optStr(o.message);
  return s === undefined ? undefined : s.slice(0, 200);
}
