import { castOf, catalog, directorOf, findItem, trailerOf } from "../fixtures.ts";
import type { FxItem, FxUnit } from "../fixtures.ts";
import { HttpError, requireAuth } from "../router.ts";
import type { HandlerCtx, MockResponse, Router } from "../router.ts";
import type { Scenario } from "../scenario.ts";
import type { MockState } from "../state.ts";
import { posterUrl } from "./cdn.ts";

// Списки каталога (Plan B §12.3, research kinopub-api §6.1–6.2): /v1/items, полки, поиск, похожие.

export const SERIES_TYPES: ReadonlySet<string> = new Set(["serial", "docuserial", "tvshow"]);
export const NOT_FOUND = { status: 404, error: "Not found" } as const;

const DEFAULT_PERPAGE = 20;
const SIMILAR_COUNT = 12;
const collator = new Intl.Collator("ru");

export function unitsOf(it: FxItem): FxUnit[] {
  return [...(it.videos ?? []), ...(it.seasons ?? []).flatMap((s) => s.episodes)];
}

export function posters(base: string, id: number): Record<"small" | "medium" | "big" | "wide", string> {
  return {
    small: posterUrl(base, "small", id), medium: posterUrl(base, "medium", id),
    big: posterUrl(base, "big", id), wide: posterUrl(base, "wide", id),
  };
}

/** Трейлер элемента списка и карточки — `{id, file}`, как в фикстурах Kodi; без трейлера — `null` (HC: концерт). */
function trailer(id: number): { id: number; file: string } | null {
  const t = trailerOf(id);
  return t === undefined ? null : { id: t, file: `/trailers/${t % 10}/${(t % 256).toString(16).padStart(2, "0")}/${t}.mp4` };
}

/** Сериал окончен: каждый второй сериал, ТВ-шоу и док. сериал; фильмы — никогда (`finished: false`). */
export const isFinished = (it: FxItem): boolean => SERIES_TYPES.has(it.type) && it.id % 2 === 0;

/**
 * Элемент списка в форме research kinopub-api §6.2 (без videos/seasons). Для проверки толерантного разбора
 * у каждого 7-го id `year` — строка, у каждого 5-го — `imdb_rating`.
 */
export function listItem(it: FxItem, base: string): Record<string, unknown> {
  const units = unitsOf(it);
  const first = units[0];
  const total = units.reduce((sum, u) => sum + u.duration, 0);
  const authors = [...new Set((first?.audios ?? []).flatMap((a) => (a.author ? [a.author.title] : [])))];
  return {
    id: it.id, type: it.type, subtype: it.subtype, title: it.title,
    year: it.id % 7 === 0 ? String(it.year) : it.year,
    cast: castOf(it).join(", "), director: directorOf(it).join(", "), voice: authors.length > 0 ? authors.join(", ") : null,
    genres: it.genres.map((g) => ({ ...g })), countries: it.countries.map((c) => ({ ...c })),
    duration: { average: units.length > 0 ? Math.round(total / units.length) : 0, total },
    langs: first?.audios.length ?? 0, ac3: first?.audios.some((a) => a.codec === "ac3") ? 1 : 0,
    quality: it.quality, subtitles: first?.subsFull.length ?? 0, plot: it.plot,
    imdb_rating: it.id % 5 === 0 ? String(it.imdb_rating) : it.imdb_rating, kinopoisk_rating: it.kinopoisk_rating,
    rating: it.rating, views: it.views, comments: 0,
    posters: posters(base, it.id), trailer: trailer(it.id),
    finished: isFinished(it), advert: false, poor_quality: false,
    in_watchlist: false, subscribed: false, created_at: it.created_at, updated_at: it.updated_at,
  };
}

function positiveInt(q: URLSearchParams, name: string, def: number): number {
  const n = Number(q.get(name));
  return Number.isInteger(n) && n > 0 ? n : def;
}

function csv(q: URLSearchParams, name: string): string[] | undefined {
  const parts = (q.get(name) ?? "").split(",").map((p) => p.trim()).filter((p) => p !== "");
  return parts.length > 0 ? parts : undefined;
}

/** `quality` — id из `/v1/references/video-quality`, «не ниже» (research kinopub-api §6.1): 4 — 4K. */
const QUALITY_MIN: Record<string, number> = { 1: 480, 2: 720, 3: 1080, 4: 2160 };

// Фильтры каталога (спец. §11.5) — как у живого API 2026-09-26 (kinopub-apple-client `docs/providers/kinopub/video.md:477-497`,
// `LibraryFilter.swift`; kinopub-gui `methods.go:61-84`; доки «API 1.3» `video.md:222-330`).

/** `year`: год или `Y1-Y2` включительно (`year=1990-1999` вживую = `conditions[]` по тем же границам). */
const YEAR = /^(\d{4})(?:-(\d{4}))?$/;
/**
 * `conditions[]=<поле><оп><число>`: проверены `>=` и `<=` по этим полям; условия через И. Другие поля (`quality`, `finished`,
 * `ac3`, `age` …) живой API молча игнорирует, форму без `[]` — тоже (kinopub-gui `methods.go:69`).
 */
const COND = /^([a-z_]+)(>=|<=)(-?\d+(?:\.\d+)?)$/;
const COND_FIELDS: Record<string, (it: FxItem) => number> = {
  year: (it) => it.year, kinopoisk_rating: (it) => it.kinopoisk_rating, imdb_rating: (it) => it.imdb_rating,
  rating: (it) => it.rating, views: (it) => it.views, created: (it) => it.created_at,
};

/** Условия `conditions[]`, которые API применяет; остальные пропускаются. */
function conditions(q: URLSearchParams): ((it: FxItem) => boolean)[] {
  const out: ((it: FxItem) => boolean)[] = [];
  for (const raw of q.getAll("conditions[]")) {
    const m = COND.exec(raw);
    const field = m !== null && Object.hasOwn(COND_FIELDS, m[1]) ? COND_FIELDS[m[1]] : undefined;
    if (m === null || field === undefined) continue;
    const v = Number(m[3]);
    out.push(m[2] === ">=" ? (it) => field(it) >= v : (it) => field(it) <= v);
  }
  return out;
}

/** Диапазон `year`; неразборчивое значение не находит ничего (`year=abc` в SQL — сравнение с 0). */
function years(q: URLSearchParams): [number, number] | undefined {
  const raw = q.get("year");
  if (raw === null || raw === "") return undefined;
  const m = YEAR.exec(raw);
  return m === null ? [1, 0] : [Number(m[1]), Number(m[2] ?? m[1])];
}

/** `finished` — по наличию: `1`, `y`, `n` одинаково оставляют окончённые; `0` и пустое игнорируются («идущих» не выбрать). */
const finishedOnly = (q: URLSearchParams): boolean => !["", "0", null].includes(q.get("finished"));

/**
 * Видимые тайтлы (без удалённых и тех, что только по id) с фильтрами `type` (без учёта регистра: живой API пишет `3d`),
 * `genre` и `country` (через запятую = ИЛИ), `quality`, `year`, `finished` и `conditions[]` — все через И; неизвестное
 * качество не находит ничего, как `quality=1080` у живого API.
 */
function filtered(q: URLSearchParams): FxItem[] {
  const types = csv(q, "type")?.map((t) => t.toLowerCase());
  const genres = csv(q, "genre")?.map(Number);
  const countries = csv(q, "country")?.map(Number);
  const quality = q.get("quality");
  const min = quality === null || quality === "" ? 0 : QUALITY_MIN[quality] ?? Infinity;
  const span = years(q);
  const fin = finishedOnly(q);
  const conds = conditions(q);
  return catalog().filter((it) => !it.deleted && !it.unlisted && (!types || types.includes(it.type.toLowerCase())) &&
    (!genres || it.genres.some((g) => genres.includes(g.id))) && it.quality >= min &&
    (!countries || it.countries.some((c) => countries.includes(c.id))) &&
    (!span || (it.year >= span[0] && it.year <= span[1])) && (!fin || isFinished(it)) && conds.every((c) => c(it)));
}

/** `type[]=…`, `genre[]=…`, `genre[0]=…` — 502 у живого API: списки только через запятую (`video.md:477, 507`). */
const BRACKETS = /^(type|genre)\[/;
const badGateway = (q: URLSearchParams): MockResponse | undefined =>
  [...q.keys()].some((k) => BRACKETS.test(k)) ? { status: 502, text: "Bad Gateway" } : undefined;

type SortKey = (it: FxItem) => number | string;

const SORT_FIELDS: Record<string, SortKey> = {
  updated: (it) => it.updated_at, created: (it) => it.created_at, year: (it) => it.year, title: (it) => it.title,
  rating: (it) => it.rating, kinopoisk_rating: (it) => it.kinopoisk_rating, imdb_rating: (it) => it.imdb_rating,
  views: (it) => it.views, watchers: (it) => it.views,
};

/** `-field` и `field-` — по убыванию, без знака — по возрастанию (research kinopub-api §6.1); неизвестное — `-updated`. */
export function parseSort(raw: string | null): { key: SortKey; desc: boolean } {
  let field = raw ?? "";
  let desc = false;
  if (field.startsWith("-")) {
    desc = true;
    field = field.slice(1);
  } else if (field.endsWith("-")) {
    desc = true;
    field = field.slice(0, -1);
  }
  return Object.hasOwn(SORT_FIELDS, field) ? { key: SORT_FIELDS[field], desc } : { key: SORT_FIELDS.updated, desc: true };
}

function sorted(items: FxItem[], key: SortKey, desc: boolean): FxItem[] {
  return [...items].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = typeof x === "string" ? collator.compare(x, String(y)) : x - Number(y);
    return (desc ? -c : c) || a.id - b.id;
  });
}

/** Страница списка; при `clampPages` страница за концом зажимается до последней (A-13). */
export function paginate<T>(all: T[], q: URLSearchParams, scenario: Scenario): { items: T[]; pagination: Record<string, number> } {
  const perpage = positiveInt(q, "perpage", DEFAULT_PERPAGE);
  const total = Math.ceil(all.length / perpage);
  let current = positiveInt(q, "page", 1);
  if (scenario.clampPages && current > total) current = Math.max(total, 1);
  const items = all.slice((current - 1) * perpage, current * perpage);
  return { items, pagination: { total, current, perpage, total_items: all.length } };
}

function listResponse(ctx: HandlerCtx, all: FxItem[]): MockResponse {
  const page = paginate(all, ctx.query, ctx.scenario);
  return { status: 200, json: { status: 200, items: page.items.map((it) => listItem(it, ctx.base)), pagination: page.pagination } };
}

const SHELVES: Record<string, SortKey> = {
  fresh: (it) => it.created_at, popular: (it) => it.views, hot: (it) => it.rating,
};

/**
 * Ответ Yii2 на действие без обязательного параметра: HTTP 400 в старом формате ошибки (research kinopub-api §3, §9.1);
 * текст — как у живого API на полке без `type` (kinopub-gui `internal/gui/discover.go:479`).
 */
export const missingParam = (name: string): HttpError =>
  new HttpError(400, { name: "Bad Request", message: `Отсутствуют обязательные параметры: ${name}`, code: 0, status: 400 });

/**
 * Полка (research kinopub-api §6.1): `type` обязателен (доки «API 1.3» — без скобок, kinopub-gui `methods.go:147`),
 * несколько через запятую — одна общая лента (ИЛИ); пустой, `all` и неизвестный тип — пустой список (Kodi #379).
 * Других фильтров полка не применяет — `genre` и прочие игнорируются.
 */
function shelfItems(q: URLSearchParams): FxItem[] {
  const type = q.get("type");
  if (type === null) throw missingParam("type");
  return type.trim() === "" ? [] : filtered(new URLSearchParams({ type }));
}

export function register(r: Router, s: MockState, base: () => string): void {
  r.add("GET", "/v1/items", (ctx) => {
    requireAuth(ctx);
    const { key, desc } = parseSort(ctx.query.get("sort"));
    return badGateway(ctx.query) ?? listResponse(ctx, sorted(filtered(ctx.query), key, desc));
  });

  for (const [shelf, key] of Object.entries(SHELVES)) {
    r.add("GET", `/v1/items/${shelf}`, (ctx) => {
      requireAuth(ctx);
      return listResponse(ctx, sorted(shelfItems(ctx.query), key, true));
    });
  }

  // `field=cast|director` — одно поле на запрос; без него и с любым другим значением — по названию (HC `video.md`, 2026-09-26).
  r.add("GET", "/v1/items/search", (ctx) => {
    requireAuth(ctx);
    const q = (ctx.query.get("q") ?? "").trim().toLowerCase();
    if (q === "") throw new HttpError(400, { status: 400, error: "Missing required parameter: q" });
    const field = ctx.query.get("field");
    const text = (it: FxItem): string => (field === "cast" ? castOf(it) : field === "director" ? directorOf(it) : [it.title]).join(", ");
    return listResponse(ctx, filtered(ctx.query).filter((it) => text(it).toLowerCase().includes(q)));
  });

  r.add("GET", "/v1/items/similar", (ctx) => {
    requireAuth(ctx);
    const id = Number(ctx.query.get("id"));
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, { status: 400, error: "Missing required parameter: id" });
    const target = findItem(id);
    if (!target || target.deleted) throw new HttpError(404, NOT_FOUND);
    const similar = catalog()
      .filter((it) => !it.deleted && !it.unlisted && it.type === target.type && it.id !== id)
      .sort((a, b) => Math.abs(a.id - id) - Math.abs(b.id - id) || a.id - b.id)
      .slice(0, SIMILAR_COUNT);
    return { status: 200, json: { status: 200, items: similar.map((it) => listItem(it, ctx.base)) } };
  });
}
