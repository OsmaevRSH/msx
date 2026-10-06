import type { HistoryEntry, ItemSummary, ItemType, Posters, SerialWatching } from "../api/models.ts";
import { fmtRemaining } from "../core/format.ts";
import type { OverlayEntry, OverlayLookup } from "../progress/overlay.ts";

// «Продолжить просмотр» (Plan B §8.3.1, Р-21): история по порядку, первая запись тайтла; позиция из оверлея ТВ
// главнее, если она новее записи истории (спец. §10.2).

export interface ContinueTile { id: number; type: ItemType; title: string; posters: Posters; progress?: number; tag?: string; badge?: string; stamp?: string }

const MAX = 15;
/** Plan B §8.3.1 п. 2: фильм с прогрессом от 90 % считается досмотренным. */
const DONE = 0.9;
const SERIES: ReadonlySet<ItemType> = new Set<ItemType>(["serial", "docuserial", "tvshow"]);

/** `Overlay.forItem`: записи тайтла по сезону и серии. */
export type EpisodesLookup = (itemId: number) => (OverlayEntry & { season: number; video: number })[];

const head = (id: number, type: ItemType, title: string, posters: Posters): ContinueTile => ({ id, type, title, posters });

function withBadge(t: ContinueTile, fresh: number): ContinueTile {
  if (fresh > 0) t.badge = `+${fresh}`;
  return t;
}

function film(e: HistoryEntry, overlay: OverlayLookup): ContinueTile | undefined {
  const { item, media } = e;
  let time = e.time;
  const o = overlay(item.id, media.snumber, media.number);
  // `lastSeen` — Unix-секунды KinoPub, `at` оверлея — миллисекунды эпохи.
  if (o !== undefined && o.at > e.lastSeen * 1000) {
    if (o.status === 1) return undefined;
    time = o.time;
  }
  const progress = media.duration > 0 ? time / media.duration : 0;
  if (progress >= DONE) return undefined;
  return { ...head(item.id, item.type, item.title, item.posters), progress, stamp: fmtRemaining(media.duration - time) };
}

function serial(e: HistoryEntry, w: SerialWatching | undefined, episodes: EpisodesLookup): ContinueTile | undefined {
  if (w === undefined) return undefined;
  // Серии, отмеченные на ТВ позже записи истории, KinoPub ещё не учёл: тег — самой дальней, «просмотрено» — в счёт.
  const tv = episodes(e.item.id).filter((o) => o.at > e.lastSeen * 1000);
  const watched = Math.min(w.total, w.watched + tv.filter((o) => o.status === 1).length);
  if (watched >= w.total && w.new <= 0) return undefined;
  const last = tv.at(-1);
  const t = head(e.item.id, e.item.type, e.item.title, e.item.posters);
  t.progress = w.total > 0 ? watched / w.total : 0;
  t.tag = last === undefined ? `S${e.media.snumber}E${e.media.number}` : `S${last.season}E${last.video}`;
  return withBadge(t, w.new);
}

export function buildContinue(
  h: HistoryEntry[], s: SerialWatching[], m: ItemSummary[], overlay: OverlayLookup, episodes: EpisodesLookup = () => [],
): ContinueTile[] {
  if (h.length === 0) {
    return [
      ...s.map((w) => withBadge(head(w.id, w.type, w.title, w.posters), w.new)),
      ...m.map((it) => head(it.id, it.type, it.title, it.posters)),
    ].slice(0, MAX);
  }
  const seen = new Set<number>();
  const out: ContinueTile[] = [];
  for (const e of h) {
    if (out.length >= MAX) break;
    const id = e.item.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = SERIES.has(e.item.type) ? serial(e, s.find((w) => w.id === id), episodes) : film(e, overlay);
    if (t !== undefined) out.push(t);
  }
  return out;
}
