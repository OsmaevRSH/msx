import type { Audio } from "../api/models.ts";
import type { KvStore } from "../bridge/storage.ts";
import { audioKey } from "./select.ts";

export type StreamMode = "hls1" | "hls2";

/** Настройки воспроизведения и UI этого ТВ (Plan B §5.4–5.6, §5.14, спец. §11 S12); хранятся в `kp.cfg.prefs`. */
export interface Prefs {
  maxQuality: 480 | 720 | 1080 | 2160;
  allowHevc: boolean;
  audioLang: string;
  audioType?: number;
  audioAuthors: number[];
  allowAc3: boolean;
  subsLang: "off" | "rus" | "eng";
  loc?: string;
  titleAudio: Record<string, string>;
  titleQuality: Record<string, number>;
  titleSubs: Record<string, string>;
  titleMode: Record<string, StreamMode>;
  streamMode?: StreamMode;
  bufferInit: 2 | 4 | 6 | 8;
  bufferResume: 4 | 6 | 8 | 10;
  posterSize: "small" | "medium";
  cardBackgrounds: boolean;
}

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null) {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

// 4K и HEVC выключены по умолчанию: настройки устройства KinoPub тоже 4K 0, HEVC 0 (спец. §7.1).
export const DEFAULT_PREFS: Prefs = deepFreeze({
  maxQuality: 1080,
  allowHevc: false,
  audioLang: "rus",
  audioAuthors: [],
  allowAc3: false,
  subsLang: "off",
  titleAudio: {},
  titleQuality: {},
  titleSubs: {},
  titleMode: {},
  bufferInit: 4,
  bufferResume: 6,
  posterSize: "medium",
  cardBackgrounds: false,
});

const KEY = "prefs";
const MAX_AUTHORS = 10;
const QUALITIES: readonly number[] = [480, 720, 1080, 2160];
const MODES: readonly string[] = ["hls1", "hls2"];

const INVALID = Symbol("invalid");
type Norm = (v: unknown) => unknown;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const oneOf = (values: readonly unknown[]): Norm => (v) => (values.includes(v) ? v : INVALID);
const bool: Norm = (v) => (typeof v === "boolean" ? v : INVALID);
const nonEmpty: Norm = (v) => (typeof v === "string" && v !== "" ? v : INVALID);
const posInt: Norm = (v) => (isPosInt(v) ? v : INVALID);
const optional = (n: Norm): Norm => (v) => (v === undefined ? undefined : n(v));

const authors: Norm = (v) => {
  if (!Array.isArray(v)) return INVALID;
  const out: number[] = [];
  for (const x of v) if (isPosInt(x) && !out.includes(x)) out.push(x);
  return out.slice(0, MAX_AUTHORS);
};

/** Записи по тайтлам: ключ — id тайтла, битые записи отбрасываются поштучно. */
const record = (n: Norm): Norm => (v) => {
  if (!isObject(v)) return INVALID;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const y = n(x);
    if (/^[1-9]\d*$/.test(k) && y !== INVALID && y !== undefined) out[k] = y;
  }
  return out;
};

const NORM: { [K in keyof Prefs]-?: Norm } = {
  maxQuality: oneOf(QUALITIES),
  allowHevc: bool,
  audioLang: nonEmpty,
  audioType: optional(posInt),
  audioAuthors: authors,
  allowAc3: bool,
  subsLang: oneOf(["off", "rus", "eng"]),
  loc: optional(nonEmpty),
  titleAudio: record(nonEmpty),
  titleQuality: record(oneOf(QUALITIES)),
  titleSubs: record(nonEmpty),
  titleMode: record(oneOf(MODES)),
  streamMode: optional(oneOf(MODES)),
  bufferInit: oneOf([2, 4, 6, 8]),
  bufferResume: oneOf([4, 6, 8, 10]),
  posterSize: oneOf(["small", "medium"]),
  cardBackgrounds: bool,
};
const PREF_KEYS = Object.keys(NORM) as (keyof Prefs)[];

const TITLE_FIELD = { quality: "titleQuality", subs: "titleSubs", mode: "titleMode" } as const;
const TITLE_NORM: Record<keyof typeof TITLE_FIELD, Norm> = { quality: oneOf(QUALITIES), subs: nonEmpty, mode: oneOf(MODES) };

const isDefault = (k: keyof Prefs, v: unknown): boolean => JSON.stringify(v) === JSON.stringify(DEFAULT_PREFS[k]);

/** Дорожка субтитров, выбранная для тайтла: у одного языка бывают обычная и форсированная (Plan B S10). */
export interface SubsChoice { lang: string; forced: boolean }

const FORCED_SUFFIX = ".forced";

/** Значение `titleSubs`: код языка — обычная дорожка, `<код>.forced` — форсированная (этап 26), `"off"` — без субтитров. */
export function subsValue(c: SubsChoice): string {
  return c.forced ? `${c.lang}${FORCED_SUFFIX}` : c.lang;
}

export function parseSubsValue(v: string): SubsChoice | "off" {
  if (v === "off") return "off";
  const forced = v.endsWith(FORCED_SUFFIX);
  return { lang: forced ? v.slice(0, -FORCED_SUFFIX.length) : v, forced };
}

/** Хранит только отличия от значений по умолчанию; недопустимые значения игнорируются (как `FlagStore`). */
export class PrefsStore {
  private store: KvStore;

  constructor(store: KvStore) {
    this.store = store;
  }

  get(): Prefs {
    const defaults = JSON.parse(JSON.stringify(DEFAULT_PREFS)) as Prefs;
    return { ...defaults, ...this.overrides() };
  }

  /** `undefined` у необязательного поля снимает его. */
  update(patch: Partial<Prefs>): void {
    const o = this.overrides() as Record<string, unknown>;
    for (const k of PREF_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      const v = NORM[k](patch[k]);
      if (v === INVALID) continue;
      if (v === undefined || isDefault(k, v)) delete o[k];
      else o[k] = v;
    }
    if (Object.keys(o).length === 0) this.store.remove("cfg", KEY);
    else this.store.set("cfg", KEY, o);
  }

  /** Plan B §5.5: выбор действует на весь тайтл; последний выбранный автор — первым в `audioAuthors`. */
  chooseAudio(itemId: number, a: Audio): void {
    if (!isPosInt(itemId)) return;
    const p = this.get();
    p.titleAudio[String(itemId)] = audioKey(a);
    const patch: Partial<Prefs> = { titleAudio: p.titleAudio };
    if (isPosInt(a.authorId)) {
      const id = a.authorId;
      patch.audioAuthors = [id, ...p.audioAuthors.filter((x) => x !== id)].slice(0, MAX_AUTHORS);
    }
    this.update(patch);
  }

  /** `undefined` снимает выбор для тайтла. */
  setTitle(kind: "quality" | "subs" | "mode", itemId: number, value: string | number | undefined): void {
    if (!isPosInt(itemId)) return;
    const v = value === undefined ? undefined : TITLE_NORM[kind](value);
    if (v === INVALID) return;
    const field = TITLE_FIELD[kind];
    const rec = { ...this.get()[field] } as Record<string, unknown>;
    if (v === undefined) delete rec[String(itemId)];
    else rec[String(itemId)] = v;
    this.update({ [field]: rec } as Partial<Prefs>);
  }

  private overrides(): Partial<Prefs> {
    const raw = this.store.get<unknown>("cfg", KEY);
    const out: Record<string, unknown> = {};
    if (!isObject(raw)) return out;
    for (const k of PREF_KEYS) {
      const v = NORM[k](raw[k]);
      if (v !== INVALID && v !== undefined && !isDefault(k, v)) out[k] = v;
    }
    return out as Partial<Prefs>;
  }
}
