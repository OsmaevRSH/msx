import { findItem, findUnit } from "../fixtures.ts";
import type { FxItem, FxUnit } from "../fixtures.ts";
import { HttpError, requireAuth } from "../router.ts";
import type { HandlerCtx, Router } from "../router.ts";
import { watchKey } from "../state.ts";
import type { MockState } from "../state.ts";
import { NOT_FOUND, SERIES_TYPES, listItem } from "./catalog.ts";
import { issuedNow, posterUrl, streamUrls, subtitleUrl } from "./cdn.ts";

// Карточка /v1/items/:id и /v1/items/media-links (Plan B §12.3, research kinopub-api §6.3, §7.1):
// в карточке ссылки в `files[].url` (убираются `nolinks=1`), в media-links — в `urls` и без поля `status`.

type Status = -1 | 0 | 1;

interface UnitOpts { ctx: HandlerCtx; item: FxItem; season: number; issued: number; links: boolean }

function unitJson(u: FxUnit, o: UnitOpts): Record<string, unknown> & { watching: { status: Status; time: number } } {
  const { ctx, issued } = o;
  const w = ctx.state.watching.get(watchKey(o.item.id, o.season, u.number));
  const status: Status = w?.status ?? -1;
  return {
    id: u.id, number: u.number, snumber: u.snumber, title: u.title, thumbnail: posterUrl(ctx.base, "thumb", u.id),
    duration: u.duration, tracks: u.audios.length, ac3: u.audios.some((a) => a.codec === "ac3") ? 1 : 0,
    audios: structuredClone(u.audios),
    subtitles: u.subsInItem.map((sub) => ({ ...sub, url: subtitleUrl(ctx.base, u.id, sub.file, issued) })),
    files: u.files.map((f) => (o.links ? { ...f, url: streamUrls(ctx.base, ctx.scenario.media, u.id, f.file, issued) } : { ...f })),
    watched: status === 1 ? 1 : 0,
    watching: { status, time: w?.time ?? 0 },
  };
}

/** Сезон: 1 — все серии просмотрены, 0 — есть начатые или просмотренные, −1 — не смотрел. */
function seasonStatus(eps: { watching: { status: Status } }[]): Status {
  if (eps.length > 0 && eps.every((e) => e.watching.status === 1)) return 1;
  return eps.some((e) => e.watching.status >= 0) ? 0 : -1;
}

function card(ctx: HandlerCtx, it: FxItem): Record<string, unknown> {
  const s = ctx.state;
  const common = { ctx, item: it, issued: issuedNow(), links: ctx.query.get("nolinks") !== "1" };
  const bookmarks = [...s.folders.entries()].filter(([, f]) => f.items.includes(it.id)).map(([id]) => id).sort((a, b) => a - b);
  const started = [...s.watching.keys()].some((k) => k.startsWith(`${it.id}:`));
  const out: Record<string, unknown> = { ...listItem(it, ctx.base), bookmarks, in_watchlist: SERIES_TYPES.has(it.type) && started };
  if (it.seasons) {
    out.seasons = it.seasons.map((se) => {
      const episodes = se.episodes.map((e) => unitJson(e, { ...common, season: se.number }));
      return { id: se.id, number: se.number, title: se.title, watching: { status: seasonStatus(episodes) }, episodes };
    });
  } else {
    out.videos = (it.videos ?? []).map((v) => unitJson(v, { ...common, season: 0 }));
  }
  return out;
}

export function register(r: Router, s: MockState, base: () => string): void {
  r.add("GET", "/v1/items/media-links", (ctx) => {
    requireAuth(ctx);
    const raw = ctx.query.get("mid");
    if (!raw) throw new HttpError(400, { status: 400, error: "Missing required parameter: mid" });
    const hit = findUnit(Number(raw));
    if (!hit || hit.item.deleted) throw new HttpError(404, NOT_FOUND);
    const { unit } = hit;
    const issued = issuedNow();
    return {
      status: 200,
      json: {
        id: unit.id,
        thumbnail: posterUrl(ctx.base, "thumb", unit.id),
        files: unit.files.map((f) => ({ ...f, urls: streamUrls(ctx.base, ctx.scenario.media, unit.id, f.file, issued) })),
        subtitles: unit.subsFull.map((sub) => ({ ...sub, url: subtitleUrl(ctx.base, unit.id, sub.file, issued) })),
      },
    };
  });

  r.add("GET", "/v1/items/:id", (ctx) => {
    requireAuth(ctx);
    const it = /^\d+$/.test(ctx.params.id) ? findItem(Number(ctx.params.id)) : undefined;
    if (!it || it.deleted) throw new HttpError(404, NOT_FOUND);
    return { status: 200, json: { status: 200, item: card(ctx, it) } };
  });
}
