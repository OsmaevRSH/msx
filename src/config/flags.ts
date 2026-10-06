import type { KvStore } from "../bridge/storage.ts";
import { BUILD } from "./build.ts";

/** Переключатели развилок Phase 0 (спец. §16.6); переопределения хранятся в `kp.cfg.flags`. */
export interface Flags {
  streamMode: "hls1" | "hls2";
  playerPropsIn: "resolve" | "item";
  heartbeat: "ticks" | "timer" | "percent";
  events: "handleEvent" | "triggers";
  autonext: "button" | "resolve";
  /** Смена озвучки и качества в плеере (фикс 35a): новый поток в открытом плеере или через закрытие плеера. */
  restart: "inplace" | "eject";
  focusPrefetch: "on" | "off";
  postBody: "form" | "query";
  apiBase: string;
  apiFallbackBase: string;
}

export const DEFAULT_FLAGS: Flags = Object.freeze({
  streamMode: "hls1",
  playerPropsIn: "resolve",
  heartbeat: "ticks",
  events: "handleEvent",
  autonext: "button",
  restart: "inplace",
  focusPrefetch: "on",
  postBody: "form",
  apiBase: BUILD.apiBase,
  apiFallbackBase: BUILD.apiFallbackBase,
});

const choices = <T extends string>(...values: T[]): readonly T[] => Object.freeze(values);

export const FLAG_CHOICES: { [K in keyof Flags]?: readonly Flags[K][] } = Object.freeze({
  streamMode: choices("hls1", "hls2"),
  playerPropsIn: choices("resolve", "item"),
  heartbeat: choices("ticks", "timer", "percent"),
  events: choices("handleEvent", "triggers"),
  autonext: choices("button", "resolve"),
  restart: choices("inplace", "eject"),
  focusPrefetch: choices("on", "off"),
  postBody: choices("form", "query"),
});

const KEY = "flags";
const FLAG_KEYS = Object.keys(DEFAULT_FLAGS) as (keyof Flags)[];

export class FlagStore {
  private store: KvStore;
  private defaults: Flags;

  constructor(store: KvStore, defaults: Flags = DEFAULT_FLAGS) {
    this.store = store;
    this.defaults = defaults;
  }

  get(): Flags {
    return { ...this.defaults, ...this.overrides() };
  }

  /** Недопустимое значение игнорируется; значение по умолчанию снимает переопределение. */
  set<K extends keyof Flags>(k: K, v: Flags[K]): void {
    if (!this.valid(k, v)) return;
    const o = this.overrides();
    if (v === this.defaults[k]) delete o[k];
    else o[k] = v;
    if (Object.keys(o).length === 0) this.store.remove("cfg", KEY);
    else this.store.set("cfg", KEY, o);
  }

  reset(): void {
    this.store.remove("cfg", KEY);
  }

  /** Только допустимые и отличные от значений по умолчанию; прочее из хранилища отбрасывается. */
  overrides(): Partial<Flags> {
    const raw = this.store.get<unknown>("cfg", KEY);
    const out: Record<string, unknown> = {};
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
    const stored = raw as Record<string, unknown>;
    for (const k of FLAG_KEYS) {
      const v = stored[k];
      if (v !== this.defaults[k] && this.valid(k, v)) out[k] = v;
    }
    return out as Partial<Flags>;
  }

  // Хост API переключается только вручную между двумя адресами сборки: их же разрешает CSP (решение Р-14, спец. §15.4).
  private valid(k: keyof Flags, v: unknown): boolean {
    if (k === "apiBase" || k === "apiFallbackBase") return v === this.defaults.apiBase || v === this.defaults.apiFallbackBase;
    const allowed: readonly unknown[] | undefined = FLAG_CHOICES[k];
    return allowed !== undefined && allowed.includes(v);
  }
}
