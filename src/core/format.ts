const pad2 = (n: number): string => String(n).padStart(2, "0");

const wholeSeconds = (sec: number): number => (Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0);

/** 3735 → "1:02:15", 59 → "0:59". */
export function fmtClock(sec: number): string {
  const s = wholeSeconds(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = pad2(s % 60);
  return h > 0 ? `${h}:${pad2(m)}:${ss}` : `${m}:${ss}`;
}

/** Целые минуты; любая положительная длительность — не меньше 1 мин. */
const wholeMinutes = (sec: number): number => (Number.isFinite(sec) && sec > 0 ? Math.max(1, Math.round(sec / 60)) : 0);

/** 2820 → "47 мин", 7260 → "2 ч 01 мин". */
export function fmtMinutes(sec: number): string {
  const total = wholeMinutes(sec);
  if (total < 60) return `${total} мин`;
  return `${Math.floor(total / 60)} ч ${pad2(total % 60)} мин`;
}

/**
 * Остаток для `stamp` постера (V-05): MSX пишет его прописными и режет после ~8 знаков, поэтому без «осталось» и
 * с «м» после часов. 2820 → "47 мин", 4200 → "1 ч 10 м", 7200 → "2 ч".
 */
export function fmtRemaining(sec: number): string {
  const total = wholeMinutes(sec);
  if (total < 60) return `${total} мин`;
  const m = total % 60;
  return m === 0 ? `${total / 60} ч` : `${Math.floor(total / 60)} ч ${m} м`;
}

/** Русское множественное число: 1 фильм, 2 фильма, 5 фильмов; разряды — неразрывным пробелом (1 234). */
export function fmtCount(n: number, forms: readonly [string, string, string]): string {
  const v = Math.max(0, Math.floor(n));
  const [ten, hundred] = [v % 10, v % 100];
  const form = ten === 1 && hundred !== 11 ? forms[0] : ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14) ? forms[1] : forms[2];
  return `${String(v).replace(/\B(?=(\d{3})+$)/g, "\u00a0")} ${form}`;
}

/** Unix-секунды → "DD.MM.YYYY" в местном времени ТВ. */
export function fmtDate(ts: number): string {
  const d = new Date(ts * 1000);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Миллисекунды эпохи → "HH:MM" в местном времени ТВ. */
export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Русская часть названия KinoPub "Рус / Eng". */
export function ruTitle(title: string): string {
  const i = title.indexOf(" / ");
  return (i >= 0 ? title.slice(0, i) : title).trim();
}

/** Рейтинг КП/IMDb с одним знаком после запятой: 7.912 → "7,9", 8 → "8,0"; 0, отсутствие и нечисло — "". */
export function fmtRating(r: number | undefined): string {
  return r !== undefined && Number.isFinite(r) && r > 0 ? r.toFixed(1).replace(".", ",") : "";
}
