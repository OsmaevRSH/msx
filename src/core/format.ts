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

/** 2820 → "47 мин", 7260 → "2 ч 01 мин". Любая положительная длительность — не меньше 1 мин. */
export function fmtMinutes(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const total = s > 0 ? Math.max(1, Math.round(s / 60)) : 0;
  if (total < 60) return `${total} мин`;
  return `${Math.floor(total / 60)} ч ${pad2(total % 60)} мин`;
}

export function fmtRemaining(sec: number): string {
  return `осталось ${fmtMinutes(sec)}`;
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
