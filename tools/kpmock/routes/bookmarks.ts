import { findItem } from "../fixtures.ts";
import { HttpError, requireAuth } from "../router.ts";
import type { HandlerCtx, MockResponse, Router } from "../router.ts";
import type { FolderRec, MockState } from "../state.ts";
import { listItem, num } from "./watching.ts";

// Закладки (research kinopub-api §8.2, Plan B §12.3). POST-параметры берутся из формы только при
// `Content-Type: application/x-www-form-urlencoded`, иначе тело игнорируется (ловушка Apple, спец. §14.2);
// параметры в query принимаются всегда (переключатель postBody: "query").

/** `updated` сверх `FolderRec` (state.ts общий): у папок из фикстур его нет, берётся `created`. */
type FolderRow = FolderRec & { updated?: number };

const NOT_FOUND = { status: 404, error: "Not found" };
const OK: MockResponse = { status: 200, json: { status: 200 } };

const nowSec = (): number => Math.floor(Date.now() / 1000);

function param(ctx: HandlerCtx, name: string): string | undefined {
  const v = (ctx.formAccepted ? ctx.form?.get(name) : undefined) ?? ctx.query.get(name) ?? "";
  return v.trim() === "" ? undefined : v;
}

function numParam(ctx: HandlerCtx, name: string): number | undefined {
  const v = param(ctx, name);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function folderJson(id: number, f: FolderRow): Record<string, unknown> {
  return { id, title: f.title, count: f.items.length, views: 0, created: f.created, updated: f.updated ?? f.created };
}

function folderOr404(s: MockState, id: number): FolderRow {
  const f = s.folders.get(id);
  if (!f) throw new HttpError(404, NOT_FOUND);
  return f;
}

function folderPage(ctx: HandlerCtx, s: MockState): MockResponse {
  const id = Number(ctx.params.id);
  const f = folderOr404(s, id);
  const per = Math.max(1, Math.floor(num(ctx.query, "perpage") ?? 20));
  const page = Math.max(1, Math.floor(num(ctx.query, "page") ?? 1));
  const items = f.items.map((itemId) => findItem(itemId)).filter((it) => it !== undefined).map((it) => listItem(it, ctx.base));
  return {
    status: 200,
    json: {
      status: 200, folder: folderJson(id, f), items: items.slice((page - 1) * per, page * per),
      pagination: { total: Math.max(1, Math.ceil(items.length / per)), current: page, perpage: per, total_items: items.length },
    },
  };
}

/** Пара `item` + `folder` для add/remove-item; нет параметров → undefined (молча `{status:200}`). */
function pair(ctx: HandlerCtx, s: MockState): { item: number; folder: FolderRow } | undefined {
  const item = numParam(ctx, "item");
  const folder = numParam(ctx, "folder");
  if (item === undefined || folder === undefined) return undefined;
  const f = folderOr404(s, folder);
  if (!findItem(item)) throw new HttpError(404, NOT_FOUND);
  return { item, folder: f };
}

export function register(r: Router, s: MockState, base: () => string): void {
  r.add("GET", "/v1/bookmarks", (ctx) => {
    requireAuth(ctx);
    return { status: 200, json: { status: 200, items: [...s.folders].map(([id, f]) => folderJson(id, f)) } };
  });

  r.add("GET", "/v1/bookmarks/:id", (ctx) => {
    requireAuth(ctx);
    return folderPage(ctx, s);
  });

  r.add("POST", "/v1/bookmarks/create", (ctx) => {
    requireAuth(ctx);
    const title = param(ctx, "title");
    if (title === undefined) return OK;
    const id = s.nextId();
    const now = nowSec();
    const f: FolderRow = { title, items: [], created: now, updated: now };
    s.folders.set(id, f);
    return { status: 200, json: { status: 200, folder: folderJson(id, f) } };
  });

  r.add("POST", "/v1/bookmarks/add", (ctx) => {
    requireAuth(ctx);
    const p = pair(ctx, s);
    if (!p) return OK;
    if (p.folder.items.includes(p.item)) return { status: 200, json: { status: 200, exists: true } };
    p.folder.items.unshift(p.item);
    p.folder.updated = nowSec();
    return OK;
  });

  r.add("POST", "/v1/bookmarks/remove-item", (ctx) => {
    requireAuth(ctx);
    const p = pair(ctx, s);
    if (!p) return OK;
    const i = p.folder.items.indexOf(p.item);
    if (i >= 0) {
      p.folder.items.splice(i, 1);
      p.folder.updated = nowSec();
    }
    return OK;
  });

  r.add("POST", "/v1/bookmarks/remove-folder", (ctx) => {
    requireAuth(ctx);
    const folder = numParam(ctx, "folder");
    if (folder === undefined) return OK;
    folderOr404(s, folder);
    s.folders.delete(folder);
    return OK;
  });
}
