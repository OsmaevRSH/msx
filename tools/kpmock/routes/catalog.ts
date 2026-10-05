import { catalog, findItem } from "../fixtures.ts";
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
    cast: "", director: "", voice: authors.length > 0 ? authors.join(", ") : null,
    genres: it.genres.map((g) => ({ ...g })), countries: it.countries.map((c) => ({ ...c })),
    duration: { average: units.length > 0 ? Math.round(total / units.length) : 0, total },
    langs: first?.audios.length ?? 0, ac3: first?.audios.some((a) => a.codec === "ac3") ? 1 : 0,
    quality: it.quality, subtitles: first?.subsFull.length ?? 0, plot: it.plot,
    imdb_rating: it.id % 5 === 0 ? String(it.imdb_rating) : it.imdb_rating, kinopoisk_rating: it.kinopoisk_rating,
    rating: it.rating, views: it.views, comments: 0,
    posters: {
      small: posterUrl(base, "small", it.id), medium: posterUrl(base, "medium", it.id),
      big: posterUrl(base, "big", it.id), wide: posterUrl(base, "wide", it.id),
    },
    finished: SERIES_TYPES.has(it.type) && it.id % 2 === 0, advert: false, poor_quality: false,
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

/** Видимые тайтлы (без удалённых) с фильтрами `type` и `genre` (через запятую = ИЛИ). */
function filtered(q: URLSearchParams): FxItem[] {
  const types = csv(q, "type");
  const genres = csv(q, "genre")?.map(Number);
  return catalog().filter((it) => !it.deleted && (!types || types.includes(it.type)) &&
    (!genres || it.genres.some((g) => genres.includes(g.id))));
}

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

export function register(r: Router, s: MockState, base: () => string): void {
  r.add("GET", "/v1/items", (ctx) => {
    requireAuth(ctx);
    const { key, desc } = parseSort(ctx.query.get("sort"));
    return listResponse(ctx, sorted(filtered(ctx.query), key, desc));
  });

  for (const [shelf, key] of Object.entries(SHELVES)) {
    r.add("GET", `/v1/items/${shelf}`, (ctx) => {
      requireAuth(ctx);
      return listResponse(ctx, sorted(filtered(ctx.query), key, true));
    });
  }

  r.add("GET", "/v1/items/search", (ctx) => {
    requireAuth(ctx);
    const q = (ctx.query.get("q") ?? "").trim().toLowerCase();
    if (q === "") throw new HttpError(400, { status: 400, error: "Missing required parameter: q" });
    return listResponse(ctx, filtered(ctx.query).filter((it) => it.title.toLowerCase().includes(q)));
  });

  r.add("GET", "/v1/items/similar", (ctx) => {
    requireAuth(ctx);
    const id = Number(ctx.query.get("id"));
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, { status: 400, error: "Missing required parameter: id" });
    const target = findItem(id);
    if (!target || target.deleted) throw new HttpError(404, NOT_FOUND);
    const similar = catalog()
      .filter((it) => !it.deleted && it.type === target.type && it.id !== id)
      .sort((a, b) => Math.abs(a.id - id) - Math.abs(b.id - id) || a.id - b.id)
      .slice(0, SIMILAR_COUNT);
    return { status: 200, json: { status: 200, items: similar.map((it) => listItem(it, ctx.base)) } };
  });
}
