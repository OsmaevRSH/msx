import { b64urlDecode, b64urlEncode } from "../core/b64url.ts";
import { KpError } from "../core/errors.ts";
import { fnv1a } from "../core/hash.ts";

// Грамматика dataId и сообщений interaction:commit:message:<msg> (спец. §6.2, план §0.6.7).

export type ProbeVariant = "a1" | "a2" | "hls2" | "props" | "ticks" | "autonext";

export type Route =
  | { k: "init" } | { k: "login" } | { k: "home" } | { k: "search" }
  | { k: "settings" } | { k: "bookmarks" } | { k: "dev" }
  | { k: "list"; key: string }
  | { k: "item"; id: number }
  | { k: "season"; id: number; n: number }
  | { k: "panel"; type: string; args: string[] }
  | { k: "probe"; page?: string }
  | { k: "play"; id: number; what: "continue" | "start" }
  | { k: "playEp"; id: number; mid: number; s: number; e: number; start: boolean; at?: number }
  | { k: "probePlay"; variant: ProbeVariant; id: number; mid: number; s: number; e: number }
  | { k: "unknown"; raw: string };

export type PlayRoute = Extract<Route, { k: "play" } | { k: "playEp" }>;

export type SearchControl = "back" | "clear" | "space" | "lang";
export type ActModule = "login" | "item" | "panel" | "set" | "probe";

export type Msg =
  | { k: "extend"; key: string }
  | { k: "searchInput"; ch: string }
  | { k: "searchControl"; c: SearchControl }
  | { k: "pf"; id: number }
  | { k: "act"; module: string; name: string; args: string[] }
  | { k: "unknown"; raw: string };

export interface ListKey {
  src: "catalog" | "fresh" | "popular" | "hot" | "folder" | "similar";
  type?: string; sort?: string; genre?: string; folder?: number; id?: number;
}

const SIMPLE = new Set(["init", "login", "home", "search", "settings", "bookmarks", "dev"]);
const VARIANTS: readonly ProbeVariant[] = ["a1", "a2", "hls2", "props", "ticks", "autonext"];
const CONTROLS: readonly SearchControl[] = ["back", "clear", "space", "lang"];
const MODULES: readonly ActModule[] = ["login", "item", "panel", "set", "probe"];
const SOURCES: readonly ListKey["src"][] = ["catalog", "fresh", "popular", "hot", "folder", "similar"];
const KEY_FIELDS = ["type", "sort", "genre", "folder", "id"] as const;
const NUM_FIELDS = new Set<string>(["folder", "id"]);

/** Неотрицательное целое без знака и ведущих нулей; иначе undefined. */
function uint(s: string | undefined): number | undefined {
  if (s === undefined || !/^(0|[1-9]\d{0,14})$/.test(s)) return undefined;
  return Number(s);
}

function pos(s: string | undefined): number | undefined {
  const n = uint(s);
  return n !== undefined && n > 0 ? n : undefined;
}

function parsePlay(parts: string[]): Route | undefined {
  if (parts[1] === "probe") {
    const [, , variant, ...rest] = parts;
    if (!VARIANTS.includes(variant as ProbeVariant) || rest.length !== 4) return undefined;
    const [id, mid, s, e] = [pos(rest[0]), pos(rest[1]), uint(rest[2]), pos(rest[3])];
    if (id === undefined || mid === undefined || s === undefined || e === undefined) return undefined;
    return { k: "probePlay", variant: variant as ProbeVariant, id, mid, s, e };
  }
  const id = pos(parts[1]);
  if (id === undefined) return undefined;
  if (parts.length === 3) {
    const what = parts[2];
    return what === "continue" || what === "start" ? { k: "play", id, what } : undefined;
  }
  if (parts.length !== 5 && parts.length !== 6) return undefined;
  const [mid, s, e] = [pos(parts[2]), uint(parts[3]), pos(parts[4])];
  if (mid === undefined || s === undefined || e === undefined) return undefined;
  const tail = parts[5];
  if (tail === undefined) return { k: "playEp", id, mid, s, e, start: false };
  if (tail === "start") return { k: "playEp", id, mid, s, e, start: true };
  const at = uint(/^at(\d+)$/.exec(tail)?.[1]);
  return at === undefined ? undefined : { k: "playEp", id, mid, s, e, start: false, at };
}

function route(id: string): Route | undefined {
  if (SIMPLE.has(id)) return { k: id } as Route;
  const parts = id.split(":");
  const head = parts[0];
  const rest = id.slice((head?.length ?? 0) + 1);
  switch (head) {
    case "list":
      return rest !== "" ? { k: "list", key: rest } : undefined;
    case "item": {
      const n = parts.length === 2 ? pos(parts[1]) : undefined;
      return n === undefined ? undefined : { k: "item", id: n };
    }
    case "season": {
      const [sid, n] = [pos(parts[1]), uint(parts[2])];
      return parts.length === 3 && sid !== undefined && n !== undefined ? { k: "season", id: sid, n } : undefined;
    }
    case "panel": {
      const type = parts[1];
      return type ? { k: "panel", type, args: parts.slice(2) } : undefined;
    }
    case "probe":
      return parts.length === 1 ? { k: "probe" } : rest !== "" ? { k: "probe", page: rest } : undefined;
    case "play":
      return parsePlay(parts);
    default:
      return undefined;
  }
}

export function parseDataId(id: string): Route {
  return route(id) ?? { k: "unknown", raw: id };
}

/** Панели открываются поверх экрана и не меняют текущий (спец. §6.3): S6/S10 и переключатель «Для разработчика». */
const PANEL_PREFIXES = ["panel:", "probe:flag:"] as const;

export function isPanelId(id: string): boolean {
  return PANEL_PREFIXES.some((p) => id.startsWith(p));
}

function message(m: string): Msg | undefined {
  const parts = m.split(":");
  switch (parts[0]) {
    case "extend": {
      const key = m.slice("extend:".length);
      return parts.length > 1 && key !== "" ? { k: "extend", key } : undefined;
    }
    case "search":
      if (parts[1] === "input") {
        const ch = m.slice("search:input:".length);
        return parts.length > 2 && ch !== "" ? { k: "searchInput", ch } : undefined;
      }
      if (parts[1] === "control" && parts.length === 3 && CONTROLS.includes(parts[2] as SearchControl)) {
        return { k: "searchControl", c: parts[2] as SearchControl };
      }
      return undefined;
    case "pf": {
      const id = parts.length === 2 ? pos(parts[1]) : undefined;
      return id === undefined ? undefined : { k: "pf", id };
    }
    case "act": {
      const [, module, name, ...args] = parts;
      return module !== undefined && MODULES.includes(module as ActModule) && name ? { k: "act", module, name, args } : undefined;
    }
    default:
      return undefined;
  }
}

/** Нераскрытый `pf:{context:kid}` тоже `unknown`: маршрутизатор считает такие сообщения отдельно (CDG-12). */
export function parseMessage(m: string): Msg {
  return message(m) ?? { k: "unknown", raw: m };
}

const join = (parts: (string | number)[]): string => parts.join(":");

export const ids = {
  init: (): string => "init",
  login: (): string => "login",
  home: (): string => "home",
  list: (key: string): string => `list:${key}`,
  search: (): string => "search",
  item: (id: number): string => `item:${id}`,
  season: (id: number, n: number): string => `season:${id}:${n}`,
  panel: (type: string, ...args: (string | number)[]): string => join(["panel", type, ...args]),
  settings: (): string => "settings",
  bookmarks: (): string => "bookmarks",
  probe: (page?: string): string => (page === undefined || page === "" ? "probe" : `probe:${page}`),
  dev: (): string => "dev",
  playContinue: (id: number): string => `play:${id}:continue`,
  playStart: (id: number): string => `play:${id}:start`,
  playEp: (id: number, mid: number, s: number, e: number, opt?: { start?: boolean; at?: number }): string => {
    const base = join(["play", id, mid, s, e]);
    if (opt?.start === true) return `${base}:start`;
    if (opt?.at !== undefined && Number.isFinite(opt.at)) return `${base}:at${Math.max(0, Math.floor(opt.at))}`;
    return base;
  },
  probePlay: (variant: string, id: number, mid: number, s: number, e: number): string => join(["play", "probe", variant, id, mid, s, e]),
};

export const msgs = {
  extend: (key: string): string => `extend:${key}`,
  searchInput: (ch: string): string => `search:input:${ch}`,
  searchControl: (c: string): string => `search:control:${c}`,
  pf: (id: number | string): string => `pf:${id}`,
  act: (module: string, name: string, ...args: (string | number)[]): string => join(["act", module, name, ...args]),
};

/** b64url("src|type=…|sort=…|genre=…|folder=…|id=…"): только заданные поля, в этом порядке. */
export function encodeListKey(k: ListKey): string {
  const parts: string[] = [k.src];
  for (const f of KEY_FIELDS) {
    const v = k[f];
    if (v === undefined) continue;
    const s = String(v);
    if (s.includes("|")) throw new Error(`encodeListKey: "|" in ${f}=${s}`);
    parts.push(`${f}=${s}`);
  }
  return b64urlEncode(parts.join("|"));
}

export function decodeListKey(s: string): ListKey {
  let text: string;
  try {
    text = b64urlDecode(s);
  } catch {
    throw new KpError("KP-BAD", "bad list key");
  }
  const [src, ...fields] = text.split("|");
  if (!SOURCES.includes(src as ListKey["src"])) throw new KpError("KP-BAD", "bad list key");
  const out: ListKey = { src: src as ListKey["src"] };
  for (const field of fields) {
    const eq = field.indexOf("=");
    const name = field.slice(0, eq);
    const value = field.slice(eq + 1);
    if (eq < 1 || !(KEY_FIELDS as readonly string[]).includes(name)) throw new KpError("KP-BAD", "bad list key");
    if (NUM_FIELDS.has(name)) {
      const n = uint(value);
      if (n === undefined) throw new KpError("KP-BAD", "bad list key");
      (out as unknown as Record<string, number>)[name] = n;
    } else {
      (out as unknown as Record<string, string>)[name] = value;
    }
  }
  return out;
}

export function listFlag(key: string): string {
  return `list_${fnv1a(key)}`;
}
