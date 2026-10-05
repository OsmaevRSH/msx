import { findItem } from "../fixtures.ts";
import type { FxItem, FxUnit } from "../fixtures.ts";
import { HttpError, requireAuth } from "../router.ts";
import type { HandlerCtx, MockResponse, Router } from "../router.ts";
import { watchKey } from "../state.ts";
import type { HistoryRec, MockState } from "../state.ts";

// Просмотры и история (research kinopub-api §8.1, §8.3; Plan B §9.3, §12.3; спец. §10.3, §14.2).
// `video` и `season` — номера (`number`), а не id; у фильма сезон 0.

type Status = -1 | 0 | 1;

const NOT_FOUND = { status: 404, error: "Requested item or video not found." };
const SERIES_TYPES = new Set(["serial", "docuserial", "tvshow"]);
const HISTORY_MAX_PERPAGE = 50;

const nowSec = (): number => Math.floor(Date.now() / 1000);
const isSeries = (it: FxItem): boolean => it.seasons !== undefined || SERIES_TYPES.has(it.type);

/** Поля истории сверх `HistoryRec` (state.ts общий): у записей из фикстур их нет, берутся значения по умолчанию. */
type HistoryRow = HistoryRec & { firstSeen?: number; counter?: number };

export function posters(base: string, id: number): Record<"small" | "medium" | "big" | "wide", string> {
  const p = (size: string): string => `${base}/poster/${size}/${id}.svg`;
  return { small: p("small"), medium: p("medium"), big: p("big"), wide: p("wide") };
}

function allUnits(it: FxItem): { season: number; unit: FxUnit }[] {
  return [
    ...(it.videos ?? []).map((unit) => ({ season: 0, unit })),
    ...(it.seasons ?? []).flatMap((s) => s.episodes.map((unit) => ({ season: s.number, unit }))),
  ];
}

/** Элемент списка в форме `/v1/items*` (research kinopub-api §6.2) — для истории и закладок. */
export function listItem(it: FxItem, base: string): Record<string, unknown> {
  const units = allUnits(it).map((x) => x.unit);
  const total = units.reduce((n, u) => n + u.duration, 0);
  return {
    id: it.id, type: it.type, subtype: it.subtype, title: it.title, year: it.year, cast: "", director: "", voice: null,
    genres: it.genres.map((g) => ({ ...g })), countries: it.countries.map((c) => ({ ...c })),
    duration: { average: units.length > 0 ? Math.round(total / units.length) : 0, total },
    langs: units[0]?.audios.length ?? 0, ac3: units.some((u) => u.audios.some((a) => a.codec === "ac3")) ? 1 : 0,
    quality: it.quality, subtitles: units[0]?.subsFull.length ?? 0, plot: it.plot,
    imdb_rating: it.imdb_rating, kinopoisk_rating: it.kinopoisk_rating, rating: it.rating, views: it.views,
    posters: posters(base, it.id), finished: false, in_watchlist: false, subscribed: false,
    created_at: it.created_at, updated_at: it.updated_at,
  };
}

/** Число из query; пусто или не число → undefined. */
export function num(q: URLSearchParams, name: string): number | undefined {
  const v = q.get(name);
  if (v === null || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

interface Target { item: FxItem; season: number; unit: FxUnit; key: string }

/** Проверка как у боевого API: без `video` — 400; неверная пара номеров или сериал без `season` — 404 с текстом. */
function target(ctx: HandlerCtx): Target {
  const video = num(ctx.query, "video");
  if (video === undefined) throw new HttpError(400, { status: 400, error: "Missing required parameters: video" });
  const item = findItem(num(ctx.query, "id") ?? -1);
  if (!item) throw new HttpError(404, NOT_FOUND);
  const season = isSeries(item) ? num(ctx.query, "season") ?? -1 : 0;
  const unit = season === 0
    ? item.videos?.find((v) => v.number === video)
    : item.seasons?.find((s) => s.number === season)?.episodes.find((e) => e.number === video);
  if (!unit) throw new HttpError(404, NOT_FOUND);
  return { item, season, unit, key: watchKey(item.id, season, unit.number) };
}

/** Запись истории — на единицу (item, season, video); обновлённая переезжает в начало. */
function touchHistory(s: MockState, t: Target, time: number, now: number): void {
  const i = s.history.findIndex((h) => h.item === t.item.id && h.season === t.season && h.video === t.unit.number);
  const prev: HistoryRow | undefined = i >= 0 ? s.history.splice(i, 1)[0] : undefined;
  const row: HistoryRow = {
    item: t.item.id, season: t.season, video: t.unit.number, time, lastSeen: now,
    firstSeen: prev ? prev.firstSeen ?? prev.lastSeen : now, counter: prev ? (prev.counter ?? 1) + 1 : 1,
  };
  s.history.unshift(row);
}

/** Агрегат тайтла или сезона: всё просмотрено → 1, что-то начато → 0, иначе −1. */
function aggregate(statuses: Status[]): Status {
  if (statuses.length > 0 && statuses.every((x) => x === 1)) return 1;
  return statuses.some((x) => x !== -1) ? 0 : -1;
}

function statusOf(s: MockState, itemId: number, season: number, u: FxUnit): Status {
  return s.watching.get(watchKey(itemId, season, u.number))?.status ?? -1;
}

function watchUnit(s: MockState, itemId: number, season: number, u: FxUnit): Record<string, unknown> {
  const rec = s.watching.get(watchKey(itemId, season, u.number));
  return { id: u.id, number: u.number, title: u.title, duration: u.duration, time: rec?.time ?? 0, status: rec?.status ?? -1, updated: rec?.updated ?? null };
}

function watchingItem(s: MockState, it: FxItem): Record<string, unknown> {
  const head = { id: it.id, title: it.title, type: it.type, status: aggregate(allUnits(it).map((x) => statusOf(s, it.id, x.season, x.unit))) };
  if (!isSeries(it)) return { ...head, videos: (it.videos ?? []).map((u) => watchUnit(s, it.id, 0, u)) };
  const seasons = (it.seasons ?? []).map((season) => {
    const statuses = season.episodes.map((u) => statusOf(s, it.id, season.number, u));
    return {
      id: season.id, number: season.number, status: aggregate(statuses), watched: statuses.filter((x) => x === 1).length,
      episodes: season.episodes.map((u) => watchUnit(s, it.id, season.number, u)),
    };
  });
  return { ...head, seasons };
}

/** Тайтлы, упомянутые в `watching`, со статусами всех единиц; по убыванию последнего изменения. */
function watchedItems(s: MockState): { item: FxItem; statuses: Status[] }[] {
  const ids = new Set<number>();
  for (const key of s.watching.keys()) ids.add(Number(key.split(":")[0]));
  const out: { item: FxItem; statuses: Status[]; updated: number }[] = [];
  for (const id of ids) {
    const item = findItem(id);
    if (!item) continue;
    let updated = 0;
    const statuses = allUnits(item).map(({ season, unit }) => {
      const rec = s.watching.get(watchKey(id, season, unit.number));
      if (rec) updated = Math.max(updated, rec.updated);
      return rec?.status ?? -1;
    });
    out.push({ item, statuses, updated });
  }
  return out.sort((a, b) => b.updated - a.updated || a.item.id - b.item.id);
}

function historyEntry(h: HistoryRow, base: string): Record<string, unknown> | undefined {
  const item = findItem(h.item);
  const unit = item && allUnits(item).find((x) => x.season === h.season && x.unit.number === h.video)?.unit;
  if (!item || !unit) return undefined;
  return {
    counter: h.counter ?? 1, first_seen: h.firstSeen ?? h.lastSeen, last_seen: h.lastSeen, time: h.time,
    deleted: item.deleted === true, item: listItem(item, base),
    media: { id: unit.id, number: unit.number, snumber: unit.snumber, title: unit.title, duration: unit.duration },
  };
}

function history(ctx: HandlerCtx, s: MockState): MockResponse {
  const perpage = num(ctx.query, "perpage") ?? 20;
  if (perpage > HISTORY_MAX_PERPAGE) throw new HttpError(400, { status: 400, error: `perpage must be no greater than ${HISTORY_MAX_PERPAGE}` });
  const per = Math.max(1, Math.floor(perpage));
  const page = Math.max(1, Math.floor(num(ctx.query, "page") ?? 1));
  // Сортировка стабильная: при равном last_seen первой остаётся запись, обновлённая позже (она в начале массива).
  const rows = [...s.history].sort((a, b) => b.lastSeen - a.lastSeen)
    .map((h) => historyEntry(h, ctx.base)).filter((e) => e !== undefined);
  return {
    status: 200,
    json: {
      status: 200, history: rows.slice((page - 1) * per, page * per),
      pagination: { total: Math.max(1, Math.ceil(rows.length / per)), current: page, perpage: per, total_items: rows.length },
    },
  };
}

export function register(r: Router, s: MockState, base: () => string): void {
  r.add("GET", "/v1/watching/marktime", (ctx) => {
    requireAuth(ctx);
    const t = target(ctx);
    const time = num(ctx.query, "time");
    if (time === undefined || time < 0) throw new HttpError(400, { status: 400, error: "Missing required parameters: time" });
    const now = nowSec();
    const sec = Math.floor(time);
    // Статус «просмотрено» marktime не снимает; иначе единица становится начатой.
    s.watching.set(t.key, { time: sec, status: s.watching.get(t.key)?.status === 1 ? 1 : 0, updated: now });
    touchHistory(s, t, sec, now);
    return { status: 200, json: { status: 200 } };
  });

  r.add("GET", "/v1/watching/toggle", (ctx) => {
    requireAuth(ctx);
    const t = target(ctx);
    const prev = s.watching.get(t.key);
    const status: -1 | 1 = prev?.status === 1 ? -1 : 1;
    s.watching.set(t.key, { time: prev?.time ?? 0, status, updated: nowSec() });
    // toggle_lost_response (спец. §14.2, CM-01): переключение применено, а ответ клиент не получит.
    if (ctx.scenario.toggleLostResponse > 0) {
      ctx.scenario.toggleLostResponse -= 1;
      return { status: 200, drop: true };
    }
    return { status: 200, json: { status: 200, watched: status === 1 ? 1 : 0, watching: { status } } };
  });

  r.add("GET", "/v1/watching", (ctx) => {
    requireAuth(ctx);
    // Удалённый из каталога тайтл здесь отвечает (research kinopub-api §9.1).
    const item = findItem(num(ctx.query, "id") ?? -1);
    if (!item) throw new HttpError(404, { status: 404, error: "Not found" });
    return { status: 200, json: { status: 200, item: watchingItem(s, item) } };
  });

  r.add("GET", "/v1/watching/serials", (ctx) => {
    requireAuth(ctx);
    const items = watchedItems(s).filter((w) => isSeries(w.item) && w.statuses.includes(1)).map(({ item, statuses }) => ({
      id: item.id, type: item.type, title: item.title, posters: posters(ctx.base, item.id),
      total: String(statuses.length),   // строкой, как у боевого API (research kinopub-api §8.1)
      watched: statuses.filter((x) => x === 1).length, new: s.newEpisodes.get(item.id) ?? 0,
    }));
    return { status: 200, json: { status: 200, items } };
  });

  r.add("GET", "/v1/watching/movies", (ctx) => {
    requireAuth(ctx);
    const items = watchedItems(s).filter((w) => !isSeries(w.item) && aggregate(w.statuses) === 0)
      .map(({ item }) => ({ id: item.id, type: item.type, subtype: item.subtype, title: item.title, posters: posters(ctx.base, item.id) }));
    return { status: 200, json: { status: 200, items } };
  });

  r.add("GET", "/v1/history", (ctx) => {
    requireAuth(ctx);
    return history(ctx, s);
  });
}
