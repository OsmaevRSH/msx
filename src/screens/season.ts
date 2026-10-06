import type { AppContext } from "../app/context.ts";
import type { ItemDetail, MediaUnit } from "../api/models.ts";
import type { Got } from "../cache/swr.ts";
import { KpError } from "../core/errors.ts";
import { fmtMinutes, ruTitle } from "../core/format.ts";
import { panelAction, replaceContent, resolveAction } from "../msx/actions.ts";
import { gridEdges, guard } from "../msx/edges.ts";
import type { Grid } from "../msx/edges.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { continueTarget, episodeName, findUnit, mergedState, orderedUnits } from "../playback/episodes.ts";
import type { EpRef } from "../playback/episodes.ts";
import { ids } from "../router/ids.ts";
import { errorScreen } from "./error.ts";
import {
  freshItem, isSerial, optionsRoot, playerInput, prefetchLinks, scheduleScreenRefresh, watchedRow,
} from "./item.ts";
import { MAX_BYTES, bytes } from "./list.ts";
import type { OptionRow } from "./item.ts";
import { contextFields, contextPlayerProps, idleContextFields } from "./player.ts";
import { personalHash, trackScreen } from "./refresh.ts";
import type { RefreshSpec } from "./refresh.ts";

// Серии S9 (спец. §11, Plan B §8.3 S9): плитка запускает выбранную серию; автопереход — из свойств плеера (D-29).

const T = {
  season: "Сезон", of: "из", parts: "Части", episode: "Серия", part: "Часть", fromStart: "Смотреть с начала", more: "▾",
  seasons: "Сезоны", pickSeason: "Сезоны…", current: "{ico:check}", episodes: "Серии",
};
/** V-23: вкладки уходят за верх экрана, когда фокус на серии, — подсказка красной кнопки видна всегда. */
const SEASONS_HINT = `{ico:msx-red:stop} ${T.seasons}`;

/** V-24: вкладка `3×1` вмещает «✓ Сезон 1 · 12/24»; больше 5 в ряд 16×8 не помещается — тогда кнопка с панелью. */
const MAX_TABS = 5;
const TAB_W = 3;
/**
 * Кадр 408×300, 4 плитки в ряд; 4 ряда сетки на плитку — на экран 16×8 ровно два ряда серий, без половины ряда под
 * подвалом (V-25). `enumerate: false` — поведение не зависит от плейлиста MSX (FX-06).
 */
const TEMPLATE: MsxContentItem = {
  type: "separate", layout: "0,0,4,4", color: "msx-glass", imageFiller: "cover", progress: -1, progressColor: "msx-blue",
  enumerate: false,
};
/** Плиток в ряду сетки серий: часть длинного сезона — целые ряды. */
const ROW = 4;
/**
 * Сетка серий для стражей (`msx/edges.ts`): «вверх» и «вниз» на краю сезона не переносят фокус по кругу. Над первым
 * рядом страж — в шапке над вкладками сезонов, а без вкладок (фильм из частей) — над плитками.
 */
const GRID: Grid = { width: 16, height: 8, w: 4, h: 4 };

export const seasonFlag = (id: number, n: number): string => `ep_${id}_${n}`;

interface EpisodeModel { ref: EpRef; unit: MediaUnit; status: -1 | 0 | 1; progress?: number }

interface SeasonModel {
  serial: boolean;
  episodes: EpisodeModel[];
  /** Серия «Продолжить», если она в этом сезоне. */
  focus?: number;
  /** Сезоны сериала с сериями; у фильма из частей — пусто. */
  seasons: number[];
  tabs: { n: number; label: string }[] | { n: number; label: string; more: true };
}

const byNumber = <T extends { number: number }>(list: T[]): T[] => list.slice().sort((a, b) => a.number - b.number);

/** Сезон сериала по номеру; у фильма «сезон» 1 — его части (Plan B S8, `subtype: multi`). */
function seasonRefs(item: ItemDetail, n: number): EpRef[] {
  const refs = orderedUnits(item);
  return isSerial(item) ? refs.filter((r) => r.season === n) : n === 1 ? refs : [];
}

function watchedOf(ctx: AppContext, item: ItemDetail, fetchedAt: number, refs: EpRef[]): number {
  return refs.filter((r) => mergedState(item, r, ctx.overlay.get, fetchedAt).status === 1).length;
}

/** «Сезон N · просмотрено/всего» с учётом оверлея (Plan B §8.4); для панели выбора сезона (этап 26). */
export function seasonLabel(ctx: AppContext, item: ItemDetail, fetchedAt: number, n: number): string {
  const refs = seasonRefs(item, n);
  return `${T.season} ${n} · ${watchedOf(ctx, item, fetchedAt, refs)}/${refs.length}`;
}

/** Подпись вкладки сезона: открытый сезон отмечен «✓», как текущий пункт в панелях выбора (V-24). */
export function seasonTabLabel(ctx: AppContext, item: ItemDetail, fetchedAt: number, n: number, current: boolean): string {
  const label = seasonLabel(ctx, item, fetchedAt, n);
  return current ? `${T.current} ${label}` : label;
}

const ratio = (time: number, duration: number): number =>
  duration > 0 ? Math.round(Math.min(1, Math.max(0, time / duration)) * 1000) / 1000 : 0;

function model(ctx: AppContext, item: ItemDetail, fetchedAt: number, n: number): SeasonModel | undefined {
  const refs = seasonRefs(item, n);
  if (refs.length === 0) return undefined;
  const episodes = refs.map((ref): EpisodeModel => {
    const unit = findUnit(item, ref.mid)?.unit as MediaUnit;
    const st = mergedState(item, ref, ctx.overlay.get, fetchedAt);
    const e: EpisodeModel = { ref, unit, status: st.status };
    if (st.status === 0) e.progress = ratio(st.time, unit.duration);
    return e;
  });
  const target = continueTarget(item, ctx.overlay.get, fetchedAt).ref.mid;
  const serial = isSerial(item);
  const seasons = serial ? byNumber(item.seasons).filter((s) => s.episodes.length > 0).map((s) => s.number) : [];
  const out: SeasonModel = { serial, episodes, seasons, tabs: [] };
  if (refs.some((r) => r.mid === target)) out.focus = target;
  if (serial) {
    out.tabs = seasons.length > MAX_TABS
      ? { n, label: `${T.season} ${n} ${T.more}`, more: true }
      : seasons.map((s) => ({ n: s, label: seasonTabLabel(ctx, item, fetchedAt, s, s === n) }));
  }
  return out;
}

/** Персональная часть сезона (Plan B §7.7): статус и прогресс в процентах каждой серии, вкладки, фокус. */
export function seasonHash(ctx: AppContext, item: ItemDetail, fetchedAt: number, n: number): string {
  const m = model(ctx, item, fetchedAt, n);
  if (m === undefined) return personalHash(null);
  return personalHash({
    e: m.episodes.map((e) => [e.ref.mid, e.status, Math.round((e.progress ?? 0) * 100)]),
    t: Array.isArray(m.tabs) ? m.tabs.map((t) => t.label) : m.tabs.label,
    f: m.focus ?? 0,
  });
}

export function seasonRefreshSpec(ctx: AppContext, id: number, n: number, hash: string, from?: number): RefreshSpec {
  return {
    dataId: ids.season(id, n, from), flag: seasonFlag(id, n), hash,
    recompute: async () => {
      const got = await freshItem(ctx, id, "bg");
      return seasonHash(ctx, got.value, got.fetchedAt, n);
    },
  };
}

export async function seasonScreen(ctx: AppContext, id: number, n: number, from?: number): Promise<MsxContentRoot> {
  const dataId = ids.season(id, n, from);
  let got: Got<ItemDetail>;
  try {
    got = await ctx.repo.item(id);
  } catch (e) {
    return errorScreen(ctx, e, dataId);
  }
  const item = got.value;
  const m = model(ctx, item, got.fetchedAt, n);
  if (m === undefined) return errorScreen(ctx, new KpError("KP-404", "season-not-found", undefined, `${id}:${n}`), dataId);

  const withProps = ctx.flags.get().playerPropsIn === "item";
  const template: MsxContentItem = { ...TEMPLATE };
  // CDG-06, Р-18: свойства плеера в шаблоне через {context:…}, значения — полями каждой серии.
  if (withProps) template.properties = contextPlayerProps(ctx);
  const title = ruTitle(item.title);
  const many = m.seasons.length > 1;
  // Красная кнопка открывает панель сезонов сразу (Option Shortcut): MSX ищет его в опциях элемента в фокусе, поэтому
  // пункт есть и у корня, и у каждой серии. Без `back` в начале: у ярлыка опции не открыты, и `back` ушёл бы с экрана.
  const seasonsRow: OptionRow[] = many ? [{ label: T.pickSeason, action: panelAction(ctx.P, ids.panel("seasons", id, n)), key: "red" }] : [];
  const root: MsxContentRoot = {
    type: "list", compress: true, flag: seasonFlag(id, n), cache: false,
    headline: `${title} · ${m.serial ? `${T.season} ${n}${many ? ` ${T.of} ${m.seasons.length}` : ""}` : T.parts}`,
    template, items: m.episodes.map((e) => episodeItem(ctx, item, m, e, withProps, seasonsRow)),
  };
  if (m.serial) root.header = tabItems(ctx, id, n, m);
  if (many) {
    root.extension = SEASONS_HINT;
    root.options = optionsRoot(seasonsRow, title);
  }
  // Переходы между частями не запускают видео, но поля для `{context:…}` у каждого элемента — строки (Р-36).
  fitParts(ctx, root, id, n, m, from, withProps ? idleContextFields() : {});

  const next = m.episodes.find((e) => e.status !== 1);
  if (next !== undefined) prefetchLinks(ctx, next.ref.mid);
  const spec = seasonRefreshSpec(ctx, id, n, seasonHash(ctx, item, got.fetchedAt, n), from);
  trackScreen(ctx, spec);
  if (got.stale) scheduleScreenRefresh(ctx, spec);
  return root;
}

/** «Серии 33–64» по номерам первой и последней серии части [from, to). */
const range = (m: SeasonModel, from: number, to: number): string =>
  `${m.serial ? T.episodes : T.parts} ${m.episodes[from]!.ref.video}–${m.episodes[to - 1]!.ref.video}`;

/**
 * CNFR-16 при любом числе серий: ответ со всеми сериями больше 32 КБ — в нём одна часть сезона, целые ряды, сколько
 * помещается по самой длинной плитке, и плитки-переходы к соседним частям по краям («‹ Серии 1–24», «Серии 49–72 ›»,
 * `replace:content` с флагом сезона). Без `from` — часть с серией «Продолжить»; в части без неё фокус на первой серии.
 */
function fitParts(
  ctx: AppContext, root: MsxContentRoot, id: number, n: number, m: SeasonModel, from: number | undefined, blank: Record<string, string>,
): void {
  const all = root.items ?? [];
  // Стражи краёв — вместе с сериями: их байты тоже входят в предел.
  const frame = (items: MsxContentItem[]): void => {
    const framed = gridEdges(items, GRID, { top: m.serial ? undefined : "shift", bottom: true });
    root.items = framed.items;
    if (framed.inserts === undefined) delete root.inserts;
    else root.inserts = framed.inserts;
  };
  frame(all);
  if (bytes(root) <= MAX_BYTES) return;
  const hint = root.extension;
  const at = Math.max(0, m.episodes.findIndex((e) => e.ref.mid === m.focus));
  const per = Math.max(...all.map(bytes)) + 1;
  const nav = (a: number, b: number, next: boolean): MsxContentItem => ({
    ...blank, id: next ? "e_next" : "e_prev", icon: next ? "navigate-next" : "navigate-before",
    title: next ? `${range(m, a, b)} ›` : `‹ ${range(m, a, b)}`, action: replaceContent(seasonFlag(id, n), ctx.P, ids.season(id, n, a)),
  });
  for (let size = Math.max(ROW, Math.floor((MAX_BYTES - bytes({ ...root, items: [], inserts: [] })) / per / ROW) * ROW); ; size -= ROW) {
    const start = Math.min(from ?? Math.floor(at / size) * size, all.length - 1);
    const end = Math.min(all.length, start + size);
    const items = all.slice(start, end);
    if (!items.some((i) => i.focus === true)) items[0] = { ...items[0], focus: true };
    if (start > 0) items.unshift(nav(Math.max(0, start - size), start, false));
    if (end < all.length) items.push(nav(end, Math.min(all.length, end + size), true));
    frame(items);
    // Номера части — в `extension`: заголовок с названием сериала и сезоном и так длинный.
    root.extension = hint === undefined ? range(m, start, end) : `${range(m, start, end)} · ${hint}`;
    if (size <= ROW || bytes(root) <= MAX_BYTES) return;
  }
}

/**
 * Вкладка ведёт `replace:content` с флагом текущего сезона: новый экран придёт со своим флагом (M-01). Вкладки стоят
 * рядом ниже стражей и поднимаются на ряд (`offset`), высота шапки — прежняя.
 */
function tabItems(ctx: AppContext, id: number, n: number, m: SeasonModel): { offset: string; items: MsxContentItem[] } {
  const tab = (key: string, i: number, label: string, action: string): MsxContentItem =>
    ({ id: `t_${key}`, type: "button", layout: `${i * TAB_W},1,${TAB_W},1`, offset: "0,-1,0,0", label, action });
  const tabs = Array.isArray(m.tabs)
    ? m.tabs.map((t, i) => tab(String(t.n), i, t.label, replaceContent(seasonFlag(id, n), ctx.P, ids.season(id, t.n))))
    : [tab("more", 0, m.tabs.label, panelAction(ctx.P, ids.panel("seasons", id, n)))];
  const guards = tabs.map((t, i) => guard({ id: t.id as string, x: i * TAB_W, y: 0, w: TAB_W, h: 1 }, 0));
  return { offset: "0,0,0,-1", items: [...tabs, ...guards] };
}

/** «Серия 4» без названия (или с названием «Серия 4»), «4. Название» с названием (V-26). */
function episodeTitle(title: string, n: number, serial: boolean): string {
  const generic = `${serial ? T.episode : T.part} ${n}`;
  const name = title.trim();
  return name === "" || name.toLowerCase() === generic.toLowerCase() ? generic : `${n}. ${name}`;
}

function episodeItem(
  ctx: AppContext, item: ItemDetail, m: SeasonModel, e: EpisodeModel, withProps: boolean, seasonsRow: OptionRow[],
): MsxContentItem {
  const { ref, unit } = e;
  const id = item.id;
  const out: MsxContentItem = {
    id: `e${ref.mid}`, title: episodeTitle(unit.title, ref.video, m.serial), titleFooter: fmtMinutes(unit.duration),
    playerLabel: playerLabel(item, ref, m.serial), action: resolveAction(ctx.P, ids.playEp(id, ref.mid, ref.season, ref.video)),
  };
  if (unit.thumbnail !== undefined && unit.thumbnail !== "") out.image = unit.thumbnail;
  if (e.progress !== undefined) out.progress = e.progress;
  if (e.status === 1) {
    out.badge = "✓";
    out.badgeColor = "msx-green";
  }
  if (m.focus === ref.mid) out.focus = true;
  out.options = optionsRoot([
    ...seasonsRow,
    watchedRow(ref, e.status, false),
    { label: T.fromStart, action: resolveAction(ctx.P, ids.playEp(id, ref.mid, ref.season, ref.video, { start: true })) },
  ]);
  return withProps ? { ...out, ...contextFields(ctx, playerInput(item, ref)) } : out;
}

/** Как метка ответа resolve: сериал «<название> · 1 сезон, 5 серия», часть фильма «<название> · Часть 2». */
function playerLabel(item: ItemDetail, ref: EpRef, serial: boolean): string {
  const title = ruTitle(item.title);
  if (serial) return `${title} · ${episodeName(ref)}`;
  return item.videos.length > 1 ? `${title} · ${T.part} ${ref.video}` : title;
}
