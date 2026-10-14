import type { AppContext, AppState } from "../app/context.ts";
import type { Country } from "../api/models.ts";
import { KpError, toKpError } from "../core/errors.ts";
import { chain, commitMsg, panelAction, replaceContent } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { type ListKey, decodeListKey, encodeListKey, ids, listFlag, msgs } from "../router/ids.ts";
import type { ListEntry } from "./list.ts";
import { UHD_QUALITY, sectionGenre, sortGenreLabels } from "./list-head.ts";
import { choicePanel } from "./panels.ts";

// Фильтры каталога S5/S6 (спец. §11.5): год, страна, рейтинг КП, 4K и «Завершённые» — поля ключа списка, поэтому у
// каждого набора свой список в памяти, своё окно и свой ключ кэша. Красная кнопка каталога сразу открывает панель
// `panel:filters:<ключ>` (Option Shortcut, как вкладки полки): сортировка, жанр и фильтры — там, а опции в ответе списка
// остаются одной строкой, и окно в 96 плиток укладывается в 32 КБ (CNFR-16). Выбор — `act:panel:filter:<поле>:<значение>`
// без ключа: фильтр применяется к открытому списку (`ctx.current`), поэтому и 92 строки «Других стран» — в 16 КБ панели.
//
// Память — на сессию плагина, по разделу (тип и жанр-раздел): пункт меню приходит с ключом без фильтров, а экран
// подставляет фильтры раздела, как вкладку полки (`ListEntry.dataId`). Постоянно не храним: фильтр сужает каталог, и
// забытый с прошлого вечера «КП ≥ 8» выглядел бы как пропавшие фильмы; сортировка и жанр тоже живут до перезапуска.

const TAG = "filters";
const T = {
  title: "Сортировка и фильтры", year: "Год", country: "Страна", rating: "Рейтинг", kp: "Рейтинг КП", others: "Другие страны",
  anyM: "любой", anyF: "любая", uhd: "4K", fin: "Завершённые", reset: "Сбросить фильтры", thisYear: "Этот год",
  more: "Другие страны…", other: "Другие",
};
/** Десятилетия и «до 2000» — диапазон `year=Y1-Y2` (вживую `year=1990-1999` = `conditions[]` по тем же годам). */
const YEARS: readonly (readonly [string, string])[] = [["2020-2029", "2020-е"], ["2010-2019", "2010-е"], ["2000-2009", "2000-е"], ["1900-1999", "до 2000"]];
const KP_MIN = ["6", "7", "8"];
/** Топ-10 стран — порядок фильтра kino.pub (kinopub-apple-client `CatalogPopularity.swift`, 2026-09-26), id — конфиг PWA. */
const TOP_COUNTRIES = [1, 2, 3, 5, 7, 4, 6, 8, 9, 10];
/** «Завершённые» — только у разделов из одних сериалов: у фильмов `finished` всегда `false`. */
const SERIES = ["serial", "docuserial", "tvshow"];
const FIELDS = ["year", "country", "kp", "fin"] as const;
type Field = (typeof FIELDS)[number];
const VALID: Record<Field, RegExp> = { year: /^\d{4}(-\d{4})?$/, country: /^\d{1,5}$/, kp: /^[1-9]$/, fin: /^1$/ };
const HALF = "0,0,4,1";

type Saved = Partial<Pick<ListKey, Field | "quality">>;
/** Фильтры разделов за сессию плагина; у каждого `AppContext` свои. */
const memory = new WeakMap<AppState, Map<string, Saved>>();

const isField = (f: string): f is Field => (FIELDS as readonly string[]).includes(f);
/** 4K — фильтр только при типе: у раздела «4K» (без типа) `quality=4` — сам раздел. */
const uhdFilter = (k: ListKey): boolean => !!k.type && k.quality === UHD_QUALITY;
const series = (k: ListKey): boolean => !!k.type && k.type.split(",").every((t) => SERIES.includes(t));
const section = (k: ListKey): string => `${k.type ?? ""}|${sectionGenre(k.genre) === undefined ? "" : k.genre}|${k.type ? "" : k.quality ?? ""}`;
const yearLabel = (v: string): string => YEARS.find(([y]) => y === v)?.[1] ?? v;
const kpLabel = (v: string): string => `КП ≥ ${v}`;
const upper = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const thisYear = (ctx: AppContext): string => String(new Date(ctx.clock.now()).getFullYear());
const pick = (field: string, value: string | number): string => commitMsg(msgs.act("panel", "filter", field, value));
const open = (ctx: AppContext, type: string, key: string): string => chain(["back", panelAction(ctx.P, ids.panel(type, key))]);

/** Есть ли у ключа каталога фильтры. */
export const hasFilters = (k: ListKey): boolean => FIELDS.some((f) => k[f] !== undefined) || (!!k.type && k.quality !== undefined);

/** Ключ каталога без фильтров (пункт меню) — с фильтрами его раздела за эту сессию; иначе тот же объект. */
export function withFilters(ctx: AppContext, k: ListKey): ListKey {
  if (k.src !== "catalog" || hasFilters(k)) return k;
  const saved = memory.get(ctx.state)?.get(section(k));
  return saved === undefined ? k : { ...k, ...saved };
}

function remember(ctx: AppContext, k: ListKey): void {
  let m = memory.get(ctx.state);
  if (m === undefined) memory.set(ctx.state, (m = new Map()));
  const saved: Saved = {};
  for (const f of FIELDS) if (k[f] !== undefined) saved[f] = k[f];
  if (uhdFilter(k)) saved.quality = k.quality;
  if (Object.keys(saved).length > 0) m.set(section(k), saved);
  else m.delete(section(k));
}

/** Фильтры ключа → поля источника каталога (`ListSource`); чужое значение — `KP-BAD`: ключи строит только плагин. */
export function filterSource(k: ListKey): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  for (const f of FIELDS) {
    const v = k[f];
    if (v === undefined) continue;
    if (!VALID[f].test(v)) throw new KpError("KP-BAD", "bad list key");
    out[f] = v;
  }
  return out;
}

/** Короткие подписи фильтров для `extension` (вместо сортировки): «2010-е · США · КП ≥ 7 · 4K · завершённые». */
export function filterTokens(k: ListKey, country: string | undefined): string[] {
  const out: string[] = [];
  if (k.year) out.push(yearLabel(k.year));
  if (k.country) out.push(country ?? `${T.country} ${k.country}`);
  if (k.kp) out.push(kpLabel(k.kp));
  if (uhdFilter(k)) out.push(T.uhd);
  if (k.fin) out.push(T.fin.toLowerCase());
  return out;
}

/** Название страны ключа для шапки: справочник обычно уже в кэше (его грузит панель, 24 ч); сбой не мешает списку. */
export async function countryTitle(ctx: AppContext, k: ListKey): Promise<string | undefined> {
  if (!k.country) return undefined;
  try {
    return (await ctx.repo.countries()).value.find((c) => String(c.id) === k.country)?.title;
  } catch (e) {
    ctx.log.debug(TAG, "countries_failed", { err: toKpError(e).code });
    return undefined;
  }
}

// --- Панели ---

/** `panel:<filters|year|country|countries|kp>:<ключ каталога>`; фильтры ключа меню — из памяти сессии. */
export async function filterPanel(ctx: AppContext, type: string, arg: string | undefined): Promise<MsxContentRoot> {
  const key = arg ?? "";
  const k = withFilters(ctx, decodeListKey(key));
  if (k.src !== "catalog") throw new KpError("KP-BAD", "bad panel list");
  const rows = (field: Field, cur: string | undefined, opts: (readonly [string, string])[]) =>
    opts.map(([v, label]) => ({ label, action: pick(field, v), current: (cur ?? "") === v }));
  switch (type) {
    case "year":
      return choicePanel(ctx, T.year, rows("year", k.year, [["", upper(T.anyM)], ...YEARS.map(([v, l]) => [v, upper(l)] as const), [thisYear(ctx), T.thisYear]]));
    case "kp":
      return choicePanel(ctx, T.kp, rows("kp", k.kp, [["", upper(T.anyM)], ...KP_MIN.map((v) => [v, kpLabel(v)] as const)]));
    case "country":
    case "countries":
      return countryPanel(ctx, key, k, type === "countries");
    default:
      return filtersPanel(ctx, key, k);
  }
}

/**
 * Красная кнопка каталога: строки с текущими значениями; строка значения закрывает панель (`back`) и открывает свою,
 * переключатели 4K и «Завершённые» и «Сбросить» — сообщением сразу.
 */
async function filtersPanel(ctx: AppContext, key: string, k: ListKey): Promise<MsxContentRoot> {
  const st: ListEntry | undefined = ctx.state.lists.get(encodeListKey(k));
  const country = k.country === undefined ? undefined : st?.country ?? (await countryTitle(ctx, k)) ?? k.country;
  const row = (id: string, icon: string, label: string, action: string): MsxContentItem => ({ id, icon, label, action });
  const toggle = (id: string, label: string, on: boolean, field: string): MsxContentItem =>
    row(id, on ? "check-box" : "check-box-outline-blank", label, pick(field, on ? "" : 1));
  const [sort, genre] = sortGenreLabels(k, st?.genre);
  const items = [
    row("f_sort", "sort", sort, open(ctx, "sort", key)),
    row("f_genre", "category", genre, open(ctx, "genre", key)),
    row("f_year", "date-range", `${T.year}: ${k.year ? yearLabel(k.year) : T.anyM}`, open(ctx, "year", key)),
    row("f_country", "public", `${T.country}: ${country ?? T.anyF}`, open(ctx, "country", key)),
    row("f_kp", "star", `${T.rating}: ${k.kp ? kpLabel(k.kp) : T.anyM}`, open(ctx, "kp", key)),
  ];
  if (k.type) items.push(toggle("f_uhd", T.uhd, uhdFilter(k), "uhd"));
  if (series(k)) items.push(toggle("f_fin", T.fin, k.fin === "1", "fin"));
  if (hasFilters(k)) items.push(row("f_reset", "clear", T.reset, commitMsg(msgs.act("panel", "filter", "reset"))));
  return { type: "list", headline: T.title, cache: false, reuse: false, template: { type: "control", layout: "0,0,8,1", enumerate: false }, items };
}

/** Топ-10 и «Другие страны…» (две колонки, один экран); «Другие» — остальной справочник по алфавиту. */
async function countryPanel(ctx: AppContext, key: string, k: ListKey, others: boolean): Promise<MsxContentRoot> {
  const all = (await ctx.repo.countries()).value;
  const cur = k.country ?? "";
  const row = (c: Country) => ({ label: c.title, action: pick("country", c.id), current: String(c.id) === cur });
  const top = (c: Country): boolean => TOP_COUNTRIES.includes(c.id);
  if (others) return choicePanel(ctx, T.others, all.filter((c) => !top(c)).sort((a, b) => a.title.localeCompare(b.title, "ru")).map(row), HALF);
  const other = all.find((c) => !top(c) && String(c.id) === cur);
  return choicePanel(ctx, T.country, [
    { label: upper(T.anyF), action: pick("country", ""), current: cur === "" },
    ...TOP_COUNTRIES.flatMap((id) => all.filter((c) => c.id === id)).map(row),
    { label: other === undefined ? T.more : `${T.other}: ${other.title}`, action: open(ctx, "countries", key), current: other !== undefined },
  ], HALF);
}

// --- Выбор ---

/** Ключ после выбора; чужое поле или значение — `undefined`. `uhd` — `quality=4` (только при типе). */
function applied(k: ListKey, field: string, value: string): ListKey | undefined {
  const next: Record<string, unknown> & ListKey = { ...k };
  if (field === "reset") {
    for (const f of FIELDS) delete next[f];
    if (next.type) delete next.quality;
    return next;
  }
  const uhd = field === "uhd";
  if (uhd ? !k.type || (value !== "" && value !== "1") : !isField(field) || (value !== "" && !VALID[field].test(value))) return undefined;
  const f = uhd ? "quality" : field;
  if (value === "") delete next[f];
  else next[f] = uhd ? UHD_QUALITY : value;
  return next;
}

/**
 * `act:panel:filter:<year|country|kp|uhd|fin>:<значение>` (пустое — снять) и `act:panel:filter:reset` — у открытого
 * каталога: фильтры запоминаются для раздела, список заменяется по флагу открытого экрана, панель закрывается.
 */
export function onFilterAct(ctx: AppContext, args: string[]): void {
  const [field = "", value = ""] = args;
  const cur = ctx.current.get() ?? "";
  const key = cur.startsWith("list:") ? cur.slice("list:".length) : "";
  let next: ListKey | undefined;
  try {
    const k = withFilters(ctx, decodeListKey(key));
    next = k.src === "catalog" && args.length <= 2 ? applied(k, field, value) : undefined;
  } catch {
    next = undefined;
  }
  if (next === undefined) {
    ctx.log.warn(TAG, "bad_args", { name: "filter", args });
    return;
  }
  remember(ctx, next);
  ctx.host.executeAction(chain(["back", replaceContent(listFlag(key), ctx.P, ids.list(encodeListKey(next)))]));
}
