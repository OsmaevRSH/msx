import type { AppContext } from "../app/context.ts";
import type { ItemDetail, MediaUnit } from "../api/models.ts";
import type { Got } from "../cache/swr.ts";
import { KpError } from "../core/errors.ts";
import { fmtMinutes, ruTitle } from "../core/format.ts";
import { panelAction, replaceContent, resolveAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { continueTarget, findUnit, mergedState, orderedUnits } from "../playback/episodes.ts";
import type { EpRef } from "../playback/episodes.ts";
import { ids } from "../router/ids.ts";
import { errorScreen } from "./error.ts";
import {
  freshItem, isSerial, optionsRoot, playerInput, prefetchLinks, scheduleScreenRefresh, watchedRow,
} from "./item.ts";
import { contextFields, contextPlayerProps } from "./player.ts";
import { personalHash, trackScreen } from "./refresh.ts";
import type { RefreshSpec } from "./refresh.ts";

// Серии S9 (спец. §11, Plan B §8.3 S9): плитка запускает выбранную серию; автопереход — из свойств плеера (D-29).

const T = { season: "Сезон", parts: "Части", episode: "Серия", part: "Часть", fromStart: "Смотреть с начала", more: "▾" };

/** Plan B S9: больше 8 вкладок `2×1` в ряд 16×8 не помещается — тогда одна кнопка с панелью выбора. */
const MAX_TABS = 8;
const TAB_W = 2;
/** Кадр 408×192, 4 плитки в ряд; `enumerate: false` — поведение не зависит от плейлиста MSX (FX-06). */
const TEMPLATE: MsxContentItem = {
  type: "separate", layout: "0,0,4,3", color: "msx-glass", imageFiller: "cover", progress: -1, progressColor: "msx-blue",
  enumerate: false,
};

export const seasonFlag = (id: number, n: number): string => `ep_${id}_${n}`;

interface EpisodeModel { ref: EpRef; unit: MediaUnit; status: -1 | 0 | 1; progress?: number }

interface SeasonModel {
  serial: boolean;
  episodes: EpisodeModel[];
  /** Серия «Продолжить», если она в этом сезоне. */
  focus?: number;
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
  const out: SeasonModel = { serial, episodes, tabs: [] };
  if (refs.some((r) => r.mid === target)) out.focus = target;
  if (serial) {
    const seasons = byNumber(item.seasons).filter((s) => s.episodes.length > 0).map((s) => s.number);
    out.tabs = seasons.length > MAX_TABS
      ? { n, label: `${T.season} ${n} ${T.more}`, more: true }
      : seasons.map((s) => ({ n: s, label: seasonLabel(ctx, item, fetchedAt, s) }));
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

export function seasonRefreshSpec(ctx: AppContext, id: number, n: number, hash: string): RefreshSpec {
  return {
    dataId: ids.season(id, n), flag: seasonFlag(id, n), hash,
    recompute: async () => {
      const got = await freshItem(ctx, id, "bg");
      return seasonHash(ctx, got.value, got.fetchedAt, n);
    },
  };
}

export async function seasonScreen(ctx: AppContext, id: number, n: number): Promise<MsxContentRoot> {
  const dataId = ids.season(id, n);
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
  const root: MsxContentRoot = {
    type: "list", compress: true, flag: seasonFlag(id, n), cache: false,
    headline: `${ruTitle(item.title)} · ${m.serial ? `${T.season} ${n}` : T.parts}`,
    template, items: m.episodes.map((e) => episodeItem(ctx, item, m, e, withProps)),
  };
  if (m.serial) root.header = { items: tabItems(ctx, id, n, m) };

  const next = m.episodes.find((e) => e.status !== 1);
  if (next !== undefined) prefetchLinks(ctx, next.ref.mid);
  const spec = seasonRefreshSpec(ctx, id, n, seasonHash(ctx, item, got.fetchedAt, n));
  trackScreen(ctx, spec);
  if (got.stale) scheduleScreenRefresh(ctx, spec);
  return root;
}

/** Вкладка ведёт `replace:content` с флагом текущего сезона: новый экран придёт со своим флагом (M-01). */
function tabItems(ctx: AppContext, id: number, n: number, m: SeasonModel): MsxContentItem[] {
  if (!Array.isArray(m.tabs)) {
    return [{ type: "button", layout: `0,0,${TAB_W},1`, label: m.tabs.label, action: panelAction(ctx.P, ids.panel("seasons", id, n)) }];
  }
  return m.tabs.map((t, i) => ({
    type: "button", layout: `${i * TAB_W},0,${TAB_W},1`, label: t.label,
    action: replaceContent(seasonFlag(id, n), ctx.P, ids.season(id, t.n)),
  }));
}

function episodeItem(ctx: AppContext, item: ItemDetail, m: SeasonModel, e: EpisodeModel, withProps: boolean): MsxContentItem {
  const { ref, unit } = e;
  const id = item.id;
  const name = unit.title !== "" ? unit.title : `${m.serial ? T.episode : T.part} ${ref.video}`;
  const out: MsxContentItem = {
    id: `e${ref.mid}`, title: `${ref.video}. ${name}`, titleFooter: fmtMinutes(unit.duration),
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
    watchedRow(ref, e.status, false),
    { label: T.fromStart, action: resolveAction(ctx.P, ids.playEp(id, ref.mid, ref.season, ref.video, { start: true })) },
  ]);
  return withProps ? { ...out, ...contextFields(ctx, playerInput(item, ref)) } : out;
}

/** Как метка ответа resolve: сериал «<название> · S1E5», часть фильма «<название> · Часть 2». */
function playerLabel(item: ItemDetail, ref: EpRef, serial: boolean): string {
  const title = ruTitle(item.title);
  if (serial) return `${title} · S${ref.season}E${ref.video}`;
  return item.videos.length > 1 ? `${title} · ${T.part} ${ref.video}` : title;
}
