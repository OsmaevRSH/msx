import { allCollections, findItem } from "../fixtures.ts";
import type { FxCollection } from "../fixtures.ts";
import { HttpError, requireAuth } from "../router.ts";
import type { HandlerCtx, Router } from "../router.ts";
import type { MockState } from "../state.ts";
import { NOT_FOUND, listItem, paginate, posters } from "./catalog.ts";

// Подборки (research kinopub-api §6.1, отчёт v1.11): `/v1/collections` (= `/index`) — `sort` по `created`, `updated`,
// `watchers`, `views`, `title`, `id` (минус префиксом или суффиксом, по умолчанию `updated-`), `title` от 3 символов,
// `page`/`perpage`; `/v1/collections/view?id=` — подборка, её тайтлы и `pagination`.

type Key = (c: FxCollection) => number | string;
const KEYS: Record<string, Key> = {
  created: (c) => c.created, updated: (c) => c.updated, watchers: (c) => c.watchers, views: (c) => c.views, title: (c) => c.title, id: (c) => c.id,
};

/** Постеры подборки — без `wide`, как у живого API. */
function json(c: FxCollection, base: string): Record<string, unknown> {
  const { wide: _wide, ...p } = posters(base, c.id);
  return { id: c.id, title: c.title, watchers: c.watchers, views: c.views, count: c.items.length, created: c.created, updated: c.updated, posters: p };
}

function sorted(raw: string | null): FxCollection[] {
  let field = raw ?? "";
  const desc = field.startsWith("-") || field.endsWith("-") || field === "";
  field = field.replace(/^-|-$/g, "");
  const key = Object.hasOwn(KEYS, field) ? KEYS[field] : KEYS.updated;
  return [...allCollections()].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    const c = typeof x === "string" ? x.localeCompare(String(y), "ru") : x - Number(y);
    return (desc ? -c : c) || a.id - b.id;
  });
}

function index(ctx: HandlerCtx) {
  requireAuth(ctx);
  const title = (ctx.query.get("title") ?? "").trim().toLowerCase();
  const all = sorted(ctx.query.get("sort")).filter((c) => title.length < 3 || c.title.toLowerCase().includes(title));
  const page = paginate(all, ctx.query, ctx.scenario);
  return { status: 200, json: { status: 200, items: page.items.map((c) => json(c, ctx.base)), pagination: page.pagination } };
}

export function register(r: Router, _s: MockState, _base: () => string): void {
  r.add("GET", "/v1/collections", index);
  r.add("GET", "/v1/collections/index", index);
  r.add("GET", "/v1/collections/view", (ctx) => {
    requireAuth(ctx);
    const c = allCollections().find((x) => x.id === Number(ctx.query.get("id")));
    if (c === undefined) throw new HttpError(404, NOT_FOUND);
    const items = c.items.map((id) => findItem(id)).filter((it) => it !== undefined);
    const page = paginate(items, ctx.query, ctx.scenario);
    return {
      status: 200,
      json: { status: 200, collection: json(c, ctx.base), items: page.items.map((it) => listItem(it, ctx.base)), pagination: page.pagination },
    };
  });
}
