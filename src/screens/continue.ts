import type { HistoryEntry, ItemSummary, ItemType, Posters, SerialWatching } from "../api/models.ts";
import { fmtRemaining } from "../core/format.ts";
import { episodeName } from "../playback/episodes.ts";
import type { OverlayEntry, OverlayLookup } from "../progress/overlay.ts";

// «Продолжить просмотр» (Plan B §8.3.1, Р-21): история по порядку, первая запись тайтла; позиция из оверлея ТВ
// главнее, если она новее записи истории (спец. §10.2). Фикс 2026-10-22 (QA-API-1): история — одна страница, строка на серию,
// и неделя одного сериала вытесняет из неё всё остальное; поэтому за тайтлами истории идут недосмотренные сериалы
// `watching/serials` и начатые фильмы `watching/movies`, которых в странице нет.

/** Год и рейтинг — для серой строки под названием, как у плиток каталога (есть у записей истории и фильмов в просмотре). */
export interface ContinueTile {
  id: number; type: ItemType; title: string; posters: Posters; year?: number; kpRating?: number;
  progress?: number; tag?: string; badge?: string; stamp?: string;
}

const MAX = 15;
/** Plan B §8.3.1 п. 2: фильм с прогрессом от 90 % считается досмотренным. */
const DONE = 0.9;
const SERIES: ReadonlySet<ItemType> = new Set<ItemType>(["serial", "docuserial", "tvshow"]);

/** `Overlay.forItem`: записи тайтла по сезону и серии. */
export type EpisodesLookup = (itemId: number) => (OverlayEntry & { season: number; video: number })[];

const head = (id: number, type: ItemType, title: string, posters: Posters): ContinueTile => ({ id, type, title, posters });

/** Год и рейтинг тайтла, если они известны. */
function meta(t: ContinueTile, it: Pick<ItemSummary, "year" | "kpRating">): ContinueTile {
  if (it.year !== undefined) t.year = it.year;
  if (it.kpRating !== undefined) t.kpRating = it.kpRating;
  return t;
}

function withBadge(t: ContinueTile, fresh: number): ContinueTile {
  if (fresh > 0) t.badge = `+${fresh}`;
  return t;
}

/** Фильм из записи истории: прогресс и остаток, позиция ТВ — если новее; досмотренный (90 %) — `undefined`. */
export function film(e: HistoryEntry, overlay: OverlayLookup): ContinueTile | undefined {
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
  return { ...meta(head(item.id, item.type, item.title, item.posters), item), progress, stamp: fmtRemaining(media.duration - time) };
}

/** Сериал досмотрен: все серии просмотрены и новых нет. `total` 0 — число серий неизвестно, не досмотрен. */
const finished = (w: SerialWatching, watched = w.watched): boolean => w.total > 0 && watched >= w.total && w.new <= 0;

/**
 * Сериал из записи истории. `w` — его строка `watching/serials`, `known: false` — список не ответил. Строки нет:
 * серия истории досмотрена — сериал досмотрен; серия не досмотрена — он начат (QA-API-7: начатый сериал без
 * просмотренных серий список может не отдавать), а без списка — неизвестно. Такие остаются с тегом серии, без прогресса
 * и бейджа (фикс 2026-10-22: иначе полка пустела молча).
 */
function serial(e: HistoryEntry, w: SerialWatching | undefined, known: boolean, episodes: EpisodesLookup): ContinueTile | undefined {
  // Серии, отмеченные на ТВ позже записи истории, KinoPub ещё не учёл: тег — самой дальней, «просмотрено» — в счёт.
  const tv = episodes(e.item.id).filter((o) => o.at > e.lastSeen * 1000);
  const last = tv.at(-1);
  if (w === undefined && known && (last !== undefined ? last.status === 1 : e.media.duration > 0 && e.time / e.media.duration >= DONE)) {
    return undefined;
  }
  const t = meta(head(e.item.id, e.item.type, e.item.title, e.item.posters), e.item);
  if (w !== undefined) {
    const watched = Math.min(w.total, w.watched + tv.filter((o) => o.status === 1).length);
    if (finished(w, watched)) return undefined;
    t.progress = w.total > 0 ? watched / w.total : 0;
  }
  // V-18: тег — «1×4» вместо латинского «S1E4» (`episodeName`, короткая форма: лента тега узкая).
  t.tag = episodeName(last ?? { season: e.media.snumber, video: e.media.number }, "short");
  return withBadge(t, w?.new ?? 0);
}

/**
 * Тайтлы списков без записи в истории — без прогресса (Plan B §8.3.1 п. 4): сериалы — сначала с меньшим остатком серий
 * (`total − watched`, как у Apple; `new` не берётся — QA-API-2), при равном — в порядке KinoPub; затем фильмы.
 */
function rest(s: SerialWatching[], m: ItemSummary[], seen: ReadonlySet<number>): ContinueTile[] {
  const left = (w: SerialWatching): number => (w.total > 0 ? w.total - w.watched : Infinity);
  const serials = s.filter((w) => !seen.has(w.id) && !finished(w)).sort((a, b) => left(a) - left(b));
  return [
    ...serials.map((w) => withBadge(head(w.id, w.type, w.title, w.posters), w.new)),
    ...m.filter((it) => !seen.has(it.id)).map((it) => meta(head(it.id, it.type, it.title, it.posters), it)),
  ];
}

/** `s` — `watching/serials`; `undefined` — список не ответил (сериалы истории не отбрасываются). */
export function buildContinue(
  h: HistoryEntry[], s: SerialWatching[] | undefined, m: ItemSummary[], overlay: OverlayLookup, episodes: EpisodesLookup = () => [],
): ContinueTile[] {
  const seen = new Set<number>();
  const out: ContinueTile[] = [];
  for (const e of h) {
    if (out.length >= MAX) break;
    const id = e.item.id;
    if (seen.has(id)) continue;
    seen.add(id);
    const t = SERIES.has(e.item.type) ? serial(e, s?.find((w) => w.id === id), s !== undefined, episodes) : film(e, overlay);
    if (t !== undefined) out.push(t);
  }
  // Тайтл истории, пропущенный как досмотренный, из списков не возвращается: он в `seen`.
  return [...out, ...rest(s ?? [], m, seen)].slice(0, MAX);
}
