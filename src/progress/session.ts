import { numberFrom } from "./samples.ts";

/** Наши маркеры в свойствах ответа resolve: по ним события плеера сопоставляются с сессией (спец. §9.2). */
export const KP_PROPS = { item: "kp:i", mid: "kp:m", season: "kp:s", episode: "kp:e", duration: "kp:d", hasNext: "kp:n", probe: "kp:p" } as const;
/** Стартовая позиция из ответа resolve (`screens/player.ts`, Plan B §9.7): число — «Продолжить», `none` — с начала. */
const RESUME_PROP = "resume:position";

export interface PlaybackSession {
  itemId: number;
  mid: number;
  season: number;
  video: number;
  duration: number;
  hasNext: boolean;
  probe?: string;
  loadedAt: number;
  started: boolean;
  /** Последняя позиция, которой можно верить (`judgePosition`). */
  lastPos?: number;
  /** Максимум проверенной позиции за сессию; при «Продолжить» — с `resume:position` (этап 33c). */
  peak: number;
  /** Откат дальше `BACK_SLACK_SEC`, который ждёт подтверждения вторым наблюдением. */
  held?: number;
  lastSentPos?: number;
  lastSentAt?: number;
  watchedDone: boolean;
  ended: boolean;
}

function intFrom(v: unknown, min: number): number | undefined {
  const n = numberFrom(v);
  return n !== undefined && Number.isInteger(n) && n >= min ? n : undefined;
}

function flagFrom(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true";
}

/**
 * Сессия из свойств `kp:*` (MSX возвращает их строками). Без `kp:i`, `kp:m` или `kp:e` сессии нет:
 * `marktime` без номера видео KinoPub отклоняет (Plan B §9.3). `kp:s` нет у фильма — сезон 0;
 * испорченный `kp:s` сессию не создаёт, иначе `marktime` сериала ушёл бы без сезона.
 */
export function sessionFromProps(props: Record<string, unknown> | undefined, now: number): PlaybackSession | undefined {
  if (!props) return undefined;
  const itemId = intFrom(props[KP_PROPS.item], 1);
  const mid = intFrom(props[KP_PROPS.mid], 1);
  const video = intFrom(props[KP_PROPS.episode], 1);
  const rawSeason = props[KP_PROPS.season];
  const season = rawSeason === undefined ? 0 : intFrom(rawSeason, 0);
  if (itemId === undefined || mid === undefined || video === undefined || season === undefined) return undefined;
  const duration = numberFrom(props[KP_PROPS.duration]);
  const resume = numberFrom(props[RESUME_PROP]);
  const s: PlaybackSession = {
    itemId,
    mid,
    season,
    video,
    duration: duration !== undefined && duration > 0 ? duration : 0,
    hasNext: flagFrom(props[KP_PROPS.hasNext]),
    loadedAt: now,
    started: false,
    peak: resume !== undefined && resume > 0 ? resume : 0,
    watchedDone: false,
    ended: false,
  };
  const probe = props[KP_PROPS.probe];
  if (typeof probe === "string" && probe !== "") s.probe = probe;
  return s;
}
