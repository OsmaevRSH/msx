import type { ItemDetail, MediaUnit, WatchState } from "../api/models.ts";
import { KpError } from "../core/errors.ts";
import { fmtClock } from "../core/format.ts";
import type { OverlayLookup } from "../progress/overlay.ts";

/** Адрес серии для `marktime`/`toggle`: у фильма `season` 0, `video` — номер видео. */
export interface EpRef {
  itemId: number;
  mid: number;
  season: number;
  video: number;
}

export interface ContinueTarget {
  ref: EpRef;
  position: number | "none";
  again: boolean;
}

/** Plan B §9.7: короче — случайный запуск, ближе к концу — титры; в обоих случаях смотрим с начала. */
const MIN_RESUME = 30;
const END_MARGIN = 60;
const RESUME_CONTEXT = 3;

const byNumber = <T extends { number: number }>(list: T[]): T[] => list.slice().sort((a, b) => a.number - b.number);

const isSerial = (item: ItemDetail): boolean => item.seasons.some((s) => s.episodes.length > 0);

function units(item: ItemDetail): { unit: MediaUnit; ref: EpRef }[] {
  if (isSerial(item)) {
    return byNumber(item.seasons).flatMap((s) =>
      byNumber(s.episodes).map((unit) => ({ unit, ref: { itemId: item.id, mid: unit.id, season: s.number, video: unit.number } })),
    );
  }
  return byNumber(item.videos).map((unit) => ({ unit, ref: { itemId: item.id, mid: unit.id, season: 0, video: unit.number } }));
}

/** Сезоны и серии (или части фильма) по номерам — порядок «Продолжить» и автоперехода (D-29). */
export function orderedUnits(item: ItemDetail): EpRef[] {
  return units(item).map((u) => u.ref);
}

export function findUnit(item: ItemDetail, mid: number): { unit: MediaUnit; ref: EpRef } | undefined {
  return units(item).find((u) => u.ref.mid === mid);
}

/** Соседи через границу сезона: после последней серии сезона — первая серия следующего (Plan B §5.8, D-29). */
export function neighbours(item: ItemDetail, mid: number): { prev?: EpRef; next?: EpRef } {
  const refs = orderedUnits(item);
  const i = refs.findIndex((r) => r.mid === mid);
  const out: { prev?: EpRef; next?: EpRef } = {};
  if (i < 0) return out;
  const prev = refs[i - 1];
  const next = refs[i + 1];
  if (prev) out.prev = prev;
  if (next) out.next = next;
  return out;
}

/** Оверлей побеждает, только если записан позже ответа карточки; без времени карточки — всегда (Plan B §9.7). */
export function mergedState(item: ItemDetail, ref: EpRef, overlay?: OverlayLookup, cardFetchedAt?: number): WatchState {
  const o = overlay?.(ref.itemId, ref.season, ref.video);
  if (o && (cardFetchedAt === undefined || o.at > cardFetchedAt)) return { status: o.status, time: o.time };
  const w = findUnit(item, ref.mid)?.unit.watching;
  return w ? { status: w.status, time: w.time } : { status: -1, time: 0 };
}

/** Таблица Plan B §9.7. Неизвестная длительность (0) не отменяет продолжение. */
export function startPosition(st: WatchState, duration: number, start?: boolean): number | "none" {
  if (start || st.status === 1) return "none";
  if (!Number.isFinite(st.time) || st.time < MIN_RESUME) return "none";
  if (duration > 0 && st.time > duration - END_MARGIN) return "none";
  return Math.floor(st.time) - RESUME_CONTEXT;
}

/**
 * «Продолжить» (Plan B §9.7, D-41): L — последняя по порядку серия со статусом 0 или 1. Нет L — первая с начала;
 * L начата — она с позиции; L просмотрена — следующая с начала, а если её нет — первая заново (`again`).
 */
export function continueTarget(item: ItemDetail, overlay?: OverlayLookup, cardFetchedAt?: number): ContinueTarget {
  const list = units(item);
  const first = list[0];
  if (!first) throw new KpError("KP-BAD", "Нет видео для воспроизведения", undefined, `item ${item.id}`);
  const states = list.map((u) => mergedState(item, u.ref, overlay, cardFetchedAt));
  let last = -1;
  states.forEach((st, i) => {
    if (st.status === 0 || st.status === 1) last = i;
  });
  if (last < 0) return { ref: first.ref, position: "none", again: false };
  const l = list[last]!;
  const st = states[last]!;
  if (st.status === 0) return { ref: l.ref, position: startPosition(st, l.unit.duration), again: false };
  const next = list[last + 1];
  if (next) return { ref: next.ref, position: "none", again: false };
  return { ref: first.ref, position: "none", again: true };
}

const epTag = (r: EpRef): string => `S${r.season}E${r.video}`;

/**
 * Подпись главной кнопки карточки (Plan B §8.3 S8): «▶ Смотреть», «▶ Продолжить 1:02:15», «▶ Продолжить S2E5»,
 * «▶ S2E6», «▶ Смотреть снова S1E1». У фильма номеров серий нет: «▶ Смотреть снова», «▶ Часть 2».
 */
export function mainButtonLabel(item: ItemDetail, t: { ref: EpRef; position: number | "none"; again: boolean }): string {
  const serial = isSerial(item);
  if (t.again) return serial ? `▶ Смотреть снова ${epTag(t.ref)}` : "▶ Смотреть снова";
  if (typeof t.position === "number") return serial ? `▶ Продолжить ${epTag(t.ref)}` : `▶ Продолжить ${fmtClock(t.position)}`;
  if (orderedUnits(item)[0]?.mid === t.ref.mid) return "▶ Смотреть";
  return serial ? `▶ ${epTag(t.ref)}` : `▶ Часть ${t.ref.video}`;
}
