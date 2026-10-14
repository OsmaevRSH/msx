import { findItem } from "../fixtures.ts";
import type { FxItem, FxUnit } from "../fixtures.ts";
import { HttpError, requireAuth } from "../router.ts";
import type { HandlerCtx, MockResponse, Router } from "../router.ts";
import { watchKey } from "../state.ts";
import type { HistoryRec, MockState } from "../state.ts";
import { NOT_FOUND as ITEM_NOT_FOUND, SERIES_TYPES, listItem, missingParam, posters } from "./catalog.ts";

// Просмотры и история (research kinopub-api §8.1, §8.3; Plan B §9.3, §12.3; спец. §10.3, §14.2).
// `video` и `season` — номера (`number`), а не id; у фильма сезон 0.

type Status = -1 | 0 | 1;

const NOT_FOUND = { status: 404, error: "Requested item or video not found." };
const HISTORY_MAX_PERPAGE = 50;

const nowSec = (): number => Math.floor(Date.now() / 1000);
const isSeries = (it: FxItem): boolean => it.seasons !== undefined || SERIES_TYPES.has(it.type);

/** Поля истории сверх `HistoryRec` (state.ts общий): у записей из фикстур их нет, берутся значения по умолчанию. */
type HistoryRow = HistoryRec & { firstSeen?: number; counter?: number };

function allUnits(it: FxItem): { season: number; unit: FxUnit }[] {
  return [
    ...(it.videos ?? []).map((unit) => ({ season: 0, unit })),
    ...(it.seasons ?? []).flatMap((s) => s.episodes.map((unit) => ({ season: s.number, unit }))),
  ];
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

/**
 * `toggle` без `video` (v1.16): все серии сезона, у фильма — все видео (HC `watching.md`: «Если отсутствует, модификации
 * подвергаются все эпизоды сезона»; Kodi — сезон и фильм из частей). Сериал без `season` или неизвестный сезон — 404.
 */
function scope(ctx: HandlerCtx): Target[] {
  const item = findItem(num(ctx.query, "id") ?? -1);
  if (!item) throw new HttpError(404, NOT_FOUND);
  const season = isSeries(item) ? num(ctx.query, "season") ?? -1 : 0;
  const units = season === 0 ? item.videos ?? [] : item.seasons?.find((x) => x.number === season)?.episodes ?? [];
  if (units.length === 0) throw new HttpError(404, NOT_FOUND);
  return units.map((unit) => ({ item, season, unit, key: watchKey(item.id, season, unit.number) }));
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

function statusesOf(s: MockState, it: FxItem): Status[] {
  return allUnits(it).map((x) => statusOf(s, it.id, x.season, x.unit));
}

/** Сериал в «Я смотрю»: выбор `togglewatchlist`, иначе — начат и не досмотрен (или вышли новые серии). */
function listed(s: MockState, id: number, statuses: Status[]): boolean {
  return s.watchlist.get(id) ?? (statuses.some((x) => x !== -1) && (statuses.some((x) => x !== 1) || (s.newEpisodes.get(id) ?? 0) > 0));
}

/** `in_watchlist` и `subscribed` карточки (v1.16): то же правило; фильм в списке не бывает. */
export function inWatchlist(s: MockState, it: FxItem): boolean {
  return isSeries(it) && listed(s, it.id, statusesOf(s, it));
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

  // Переключатель: всё в области просмотрено → снять отметки, иначе — отметить всё (у сезона — как у Apple-клиента).
  r.add("GET", "/v1/watching/toggle", (ctx) => {
    requireAuth(ctx);
    const ts = num(ctx.query, "video") === undefined ? scope(ctx) : [target(ctx)];
    const status: -1 | 1 = ts.every((t) => s.watching.get(t.key)?.status === 1) ? -1 : 1;
    for (const t of ts) s.watching.set(t.key, { time: s.watching.get(t.key)?.time ?? 0, status, updated: nowSec() });
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

  // `subscribed=1` — список «Я смотрю» («Буду смотреть»): выбор `togglewatchlist`, а без него — начатые сериалы, кроме
  // досмотренных без новых серий; без параметра — сериалы с просмотренными сериями (их берёт «Продолжить» главной).
  r.add("GET", "/v1/watching/serials", (ctx) => {
    requireAuth(ctx);
    const sub = ctx.query.get("subscribed") === "1";
    const rows = watchedItems(s);
    // Добавленный в «Я смотрю» сериал без просмотров тоже в списке.
    for (const [id, on] of sub ? s.watchlist : []) {
      const item = findItem(id);
      if (on && item && !rows.some((w) => w.item.id === id)) rows.push({ item, statuses: statusesOf(s, item) });
    }
    const wanted = (w: { item: FxItem; statuses: Status[] }): boolean => !sub ? w.statuses.includes(1) : listed(s, w.item.id, w.statuses);
    const items = rows.filter((w) => isSeries(w.item) && wanted(w)).map(({ item, statuses }) => ({
      id: item.id, type: item.type, title: item.title, posters: posters(ctx.base, item.id),
      total: String(statuses.length),   // строкой, как у боевого API (research kinopub-api §8.1)
      watched: statuses.filter((x) => x === 1).length, new: s.newEpisodes.get(item.id) ?? 0,
    }));
    return { status: 200, json: { status: 200, items } };
  });

  // «Я смотрю» («Буду смотреть», research kinopub-api §8.1): переключатель, ответ — новое состояние `watching`.
  // Строго (v1.16, как v1.14): без `id` — 400 Yii; неизвестный, удалённый и не сериал — 404 (HC: «id — идентификатор сериала»).
  r.add("GET", "/v1/watching/togglewatchlist", (ctx) => {
    requireAuth(ctx);
    if (num(ctx.query, "id") === undefined) throw missingParam("id");
    const item = findItem(num(ctx.query, "id") ?? -1);
    if (!item || item.deleted || !isSeries(item)) throw new HttpError(404, ITEM_NOT_FOUND);
    const watching = !listed(s, item.id, statusesOf(s, item));
    s.watchlist.set(item.id, watching);
    // watchlistLostResponse (CM-01): переключение применено, а ответ клиент не получит.
    if ((ctx.scenario.watchlistLostResponse ?? 0) > 0) {
      ctx.scenario.watchlistLostResponse = (ctx.scenario.watchlistLostResponse ?? 1) - 1;
      return { status: 200, drop: true };
    }
    return { status: 200, json: { status: 200, watching } };
  });

  // Удаление из истории (research kinopub-api §8.3): POST, `id` в query — тайтл, серия (`media.id`) или сезон (`id`
  // сезона); ответ — HTTP 200 и тело `null`. Просмотры (`/v1/watching`) не меняются.
  const clear = (ctx: HandlerCtx, drop: (h: HistoryRec, id: number) => boolean): MockResponse => {
    requireAuth(ctx);
    const id = num(ctx.query, "id") ?? -1;
    s.history = s.history.filter((h) => !drop(h, id));
    return { status: 200, json: null };
  };
  const unitOf = (h: HistoryRec): FxUnit | undefined => {
    const item = findItem(h.item);
    return item && allUnits(item).find((x) => x.season === h.season && x.unit.number === h.video)?.unit;
  };
  r.add("POST", "/v1/history/clear-for-item", (ctx) => clear(ctx, (h, id) => h.item === id));
  r.add("POST", "/v1/history/clear-for-media", (ctx) => clear(ctx, (h, id) => unitOf(h)?.id === id));
  r.add("POST", "/v1/history/clear-for-season", (ctx) =>
    clear(ctx, (h, id) => findItem(h.item)?.seasons?.some((x) => x.id === id && x.number === h.season) === true));

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
