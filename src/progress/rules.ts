import type { PlaybackSession } from "./session.ts";

/** Plan B §9.3: случайный запуск короче 30 с не должен создавать «начатый» тайтл. */
export const MIN_POSITION = 30;
/** CNFR-14, Plan B §9.4: «просмотрено» — только в окне от 90 % длительности. */
export const WATCHED_RATIO = 0.9;

export function isWatchedPosition(pos: number, duration: number): boolean {
  if (!Number.isFinite(pos) || !Number.isFinite(duration) || duration <= 0) return false;
  // Деление, а не умножение: pos / duration ровно на границе даёт ровно 0.9, а duration × 0.9 может уйти вверх.
  return pos / duration >= WATCHED_RATIO;
}

/**
 * Склейку событий в пределах 2 с делает трекер (этап 19); здесь — только решение по одной позиции.
 * Правила одинаковы для всех `kind`: `pause`/`stop`/`end` тоже не шлют ту же позицию (Plan B §9.3).
 */
export function decideMarktime(
  s: PlaybackSession,
  pos: number,
  kind: "hb" | "pause" | "stop" | "end" | "snapshot",
): { send: boolean; time?: number; reason: string } {
  if (!Number.isFinite(pos) || pos < 0) return { send: false, reason: "no-position" };
  if (pos < MIN_POSITION) return { send: false, reason: "below-threshold" };
  const time = Math.floor(pos);
  if (s.lastSentPos !== undefined && Math.floor(s.lastSentPos) === time) return { send: false, reason: "same" };
  // A-18: после отметки «просмотрено» не спорим с ней позицией < 90 %.
  if (s.watchedDone && !isWatchedPosition(pos, s.duration)) return { send: false, reason: "after-watched" };
  return { send: true, time, reason: "ok" };
}

/** Plan B §9.4: никогда при старте; `toggle` — переключатель, поэтому при статусе 1 его не шлём. */
export function decideWatched(
  s: PlaybackSession,
  pos: number,
  kind: "load" | "play" | "hb" | "pause" | "stop" | "end" | "snapshot",
  status: -1 | 0 | 1,
): "none" | "toggle" {
  if (kind === "load" || kind === "play") return "none";
  if (status === 1 || s.watchedDone) return "none";
  return isWatchedPosition(pos, s.duration) ? "toggle" : "none";
}

/** Повторный `toggle` допустим один раз — это решает вызывающий (спец. §10.3, CM-01). */
export function checkToggleResult(desired: 0 | 1, resp: { watched: 0 | 1 }): "done" | "toggle-again" {
  return Number(resp.watched) === desired ? "done" : "toggle-again";
}
