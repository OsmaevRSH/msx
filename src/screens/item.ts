import type { AppContext } from "../app/context.ts";
import type { Audio, ItemDetail, MediaUnit } from "../api/models.ts";
import type { ReqClass } from "../api/transport.ts";
import type { Got } from "../cache/swr.ts";
import { toKpError } from "../core/errors.ts";
import { fmtMinutes, fmtRating, ruTitle } from "../core/format.ts";
import { commitMsg, contentAction, panelAction, resolveAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { continueTarget, findUnit, mainButtonLabel, mergedState, neighbours, orderedUnits } from "../playback/episodes.ts";
import type { ContinueTarget, EpRef } from "../playback/episodes.ts";
import { parseSubsValue, pickAudio, pickFile, pickSubtitle, selectPrefs } from "../playback/select.ts";
import type { SelectPrefs } from "../playback/select.ts";
import { qualityLabel } from "../playback/url.ts";
import { encodeListKey, ids, msgs, parseDataId } from "../router/ids.ts";
import { errorScreen } from "./error.ts";
import { audioTitle, playerProps, subsTitle } from "./player.ts";
import type { PlayerPropsInput } from "./player.ts";
import { personalHash, scheduleRefresh, trackScreen } from "./refresh.ts";
import type { RefreshSpec } from "./refresh.ts";

// Карточка S8 (спец. §11, Plan B §8.3 S8): кнопки ведут в resolve, серия «Продолжить» выбирается в момент запуска (D-41).

const T = {
  seasons: "Сезоны",
  parts: "Части",
  fromStart: "С начала",
  inBookmarks: "★ В закладках",
  toBookmarks: "☆ В закладки",
  similar: "Похожие",
  auto: "Авто",
  markFilm: "Отметить просмотренным",
  markEpisode: "Отметить просмотренной",
  unmark: "Снять отметку",
  mode: "Способ воспроизведения",
  refresh: "Обновить",
  kp: "КП",
  imdb: "IMDb",
};
/** V-15: значения без префиксов «Озвучка:», «Качество:», «Субтитры:» — иконки MSX. */
const ICO = { audio: "{ico:record-voice-over}", quality: "{ico:hd}", subs: "{ico:subtitles}" };

/**
 * Сетка 12×6 (V-15, V-18): «▶» — 5 колонок, чтобы «▶ Продолжить: 1 сезон, 4 серия» не обрезалась; закладки — под
 * постером; субтитрам — 4 колонки на «Английские · только надписи».
 */
const L = {
  main: "3,4,5,1", second: "8,4,2,1", similar: "10,4,2,1", similarWide: "8,4,4,1",
  bm: "0,5,3,1", audio: "3,5,3,1", quality: "6,5,2,1", subs: "8,5,4,1",
};
/** Главная кнопка: на ней фокус при открытии и после плеера (V-16). */
const MAIN_ID = "b_main";

const TAG = "item";
const PLOT_MAX = 600;
/** Plan B §7.7: условное обновление ждёт свежую карточку не дольше 3 с. */
const REFRESH_WAIT_MS = 3000;
/** Панель опций (красная кнопка) — сетка 8×6, строка на пункт. */
const OPTION_TEMPLATE: MsxContentItem = { type: "button", layout: "0,0,8,1" };

/** `key` — кнопка пульта, которая выполняет пункт без открытия опций (Option Shortcut MSX). */
export interface OptionRow { label: string; action: string; key?: string }

export const itemFlag = (id: number): string => `item_${id}`;

/** Сериал — есть сезоны с сериями; иначе единицы — `videos` (фильм или части фильма). */
export const isSerial = (item: ItemDetail): boolean => item.seasons.some((s) => s.episodes.length > 0);

export function optionsRoot(rows: OptionRow[], headline?: string): MsxContentRoot {
  const items = rows.map((r): MsxContentItem => ({ ...r }));
  return headline === undefined ? { template: OPTION_TEMPLATE, items } : { headline, template: OPTION_TEMPLATE, items };
}

/** Ручная отметка единицы — через сверку статуса в outbox (спец. §10.3, CM-01); `act:item:watched:<id>:<s>:<v>:<0|1>`. */
export function watchedRow(ref: EpRef, status: -1 | 0 | 1, film: boolean): OptionRow {
  const desired = status === 1 ? 0 : 1;
  return {
    label: desired === 0 ? T.unmark : film ? T.markFilm : T.markEpisode,
    action: commitMsg(msgs.act("item", "watched", ref.itemId, ref.season, ref.video, desired)),
  };
}

/** Вход свойств плеера для единицы: длительность и соседи через границу сезона (D-29). */
export function playerInput(item: ItemDetail, ref: EpRef): PlayerPropsInput {
  const p: PlayerPropsInput = { itemId: item.id, ref, duration: findUnit(item, ref.mid)?.unit.duration ?? 0 };
  const { prev, next } = neighbours(item, ref.mid);
  if (prev !== undefined) p.prev = prev;
  if (next !== undefined) p.next = next;
  return p;
}

/** Карточка, обновлённая в KinoPub: ждём не дольше 3 с, иначе — кэш, обновление продолжается фоном (D-41). */
export function freshItem(ctx: AppContext, id: number, cls: ReqClass): Promise<Got<ItemDetail>> {
  return ctx.repo.item(id, { freshWithinMs: 0, waitMs: REFRESH_WAIT_MS, cls });
}

/** Экран отдан из устаревших данных: после обновления заменить его, если персональная часть изменилась (спец. §6.3). */
export function scheduleScreenRefresh(ctx: AppContext, spec: RefreshSpec): void {
  ctx.log.info(TAG, `refresh scheduled ${spec.flag}`, { dataId: spec.dataId });
  scheduleRefresh(ctx, spec);
}

/** Фоновые ссылки единицы, которую вероятнее всего запустят (спец. §8.3). */
export function prefetchLinks(ctx: AppContext, mid: number): void {
  ctx.repo.links(mid, { cls: "bg" }).catch((e: unknown) => {
    ctx.log.debug(TAG, "links_prefetch_failed", { mid, err: toKpError(e).code });
  });
}

// --- Модель карточки ---

interface CardModel {
  target?: ContinueTarget;
  unit?: MediaUnit;
  label: string;
  /** Фильм из одного видео: отметка «просмотрено» — в опциях карточки. */
  film?: { ref: EpRef; status: -1 | 0 | 1 };
  inBookmarks: boolean;
}

function model(ctx: AppContext, item: ItemDetail, fetchedAt: number): CardModel {
  const refs = orderedUnits(item);
  const first = refs[0];
  const out: CardModel = { label: "", inBookmarks: item.bookmarks.length > 0 };
  if (first === undefined) return out;
  const target = continueTarget(item, ctx.overlay.get, fetchedAt);
  out.target = target;
  out.label = mainButtonLabel(item, target);
  const unit = findUnit(item, target.ref.mid)?.unit;
  if (unit !== undefined) out.unit = unit;
  if (!isSerial(item) && refs.length === 1) {
    out.film = { ref: first, status: mergedState(item, first, ctx.overlay.get, fetchedAt).status };
  }
  return out;
}

/** Персональная часть карточки (Plan B §7.7): подпись главной кнопки, её серия, закладки, статус фильма. */
export function itemHash(ctx: AppContext, item: ItemDetail, fetchedAt: number): string {
  const m = model(ctx, item, fetchedAt);
  return personalHash({ b: m.label, m: m.target?.ref.mid ?? 0, bm: m.inBookmarks, w: m.film?.status ?? null });
}

export function itemRefreshSpec(ctx: AppContext, id: number, hash: string): RefreshSpec {
  return {
    dataId: ids.item(id), flag: itemFlag(id), hash, focus: MAIN_ID,
    recompute: async () => {
      const got = await freshItem(ctx, id, "bg");
      return itemHash(ctx, got.value, got.fetchedAt);
    },
  };
}

// --- Экран ---

export async function itemScreen(ctx: AppContext, id: number): Promise<MsxContentRoot> {
  let got: Got<ItemDetail>;
  try {
    got = await ctx.repo.item(id);
  } catch (e) {
    return errorScreen(ctx, e, ids.item(id));
  }
  const item = got.value;
  const m = model(ctx, item, got.fetchedAt);
  const root: MsxContentRoot = {
    type: "pages", flag: itemFlag(id), cache: false, options: cardOptions(ctx, item, m), pages: [{ items: cardItems(ctx, item, m) }],
  };
  if (ctx.prefs.get().cardBackgrounds) root.background = item.posters.wide ?? item.posters.big;
  if (m.target !== undefined) prefetchLinks(ctx, m.target.ref.mid);
  const spec = itemRefreshSpec(ctx, id, itemHash(ctx, item, got.fetchedAt));
  trackScreen(ctx, spec);
  if (got.stale) scheduleScreenRefresh(ctx, spec);
  return root;
}

function cardItems(ctx: AppContext, item: ItemDetail, m: CardModel): MsxContentItem[] {
  const { P } = ctx;
  const id = item.id;
  const withProps = ctx.flags.get().playerPropsIn === "item";
  const out: MsxContentItem[] = [
    { type: "space", layout: "0,0,3,5", image: item.posters.big, imageFiller: "fit" },
    { type: "space", layout: "3,0,9,4", headline: ruTitle(item.title), text: describe(item) },
  ];
  const bm: MsxContentItem = {
    id: "b_bm", type: "button", layout: L.bm, label: m.inBookmarks ? T.inBookmarks : T.toBookmarks,
    action: panelAction(P, ids.panel("bookmarks", id)),
  };
  const similar = (layout: string): MsxContentItem => ({
    id: "b_similar", type: "button", layout, label: T.similar, action: contentAction(P, ids.list(encodeListKey({ src: "similar", id }))),
  });
  const t = m.target;
  if (t === undefined) return [...out, { ...bm, focus: true }, similar(L.similarWide)];
  const main: MsxContentItem = {
    id: MAIN_ID, type: "button", layout: L.main, label: m.label, focus: true, action: resolveAction(P, ids.playContinue(id)),
  };
  // Р-18: у карточки нет шаблона — свойства плеера явно у кнопок, которые запускают видео.
  if (withProps) main.properties = playerProps(ctx, playerInput(item, t.ref));
  const second = secondButton(ctx, item, t, withProps);
  // V-17: у фильма без позиции «▶» уже запускает с начала — на месте «С начала» «Похожие».
  out.push(main, ...(second === undefined ? [similar(L.similarWide)] : [second, similar(L.similar)]), bm);
  if (m.unit !== undefined) out.push(...prefButtons(ctx, item, m.unit, t.ref.mid));
  return out;
}

function secondButton(ctx: AppContext, item: ItemDetail, t: ContinueTarget, withProps: boolean): MsxContentItem | undefined {
  const b: MsxContentItem = { id: "b_second", type: "button", layout: L.second };
  if (isSerial(item)) return { ...b, label: T.seasons, action: contentAction(ctx.P, ids.season(item.id, t.ref.season)) };
  if (item.subtype === "multi" || item.videos.length > 1) return { ...b, label: T.parts, action: contentAction(ctx.P, ids.season(item.id, 1)) };
  if (typeof t.position !== "number") return undefined;
  b.label = T.fromStart;
  b.action = resolveAction(ctx.P, ids.playStart(item.id));
  const first = orderedUnits(item)[0];
  if (withProps && first !== undefined) b.properties = playerProps(ctx, playerInput(item, first));
  return b;
}

/** Озвучка, качество и субтитры, с которыми запустится единица «Продолжить» (Plan B §5.4–5.6). */
function prefButtons(ctx: AppContext, item: ItemDetail, unit: MediaUnit, mid: number): MsxContentItem[] {
  const sp = selectPrefs(ctx.prefs.get(), item.id);
  const audio = pickAudio(unit.audios, sp);
  const file = pickFile(unit.files, sp);
  const row = (id: string, layout: string, label: string, panel: string): MsxContentItem => ({
    id, type: "button", layout, label, action: panelAction(ctx.P, ids.panel(panel, item.id, mid, "c")),
  });
  return [
    row("b_audio", L.audio, `${ICO.audio} ${audio === undefined ? T.auto : audioTitle(audio)}`, "audio"),
    row("b_quality", L.quality, `${ICO.quality} ${file === undefined ? T.auto : qualityLabel(file)}`, "quality"),
    row("b_subs", L.subs, `${ICO.subs} ${subsName(unit, sp, audio)}`, "subs"),
  ];
}

function cardOptions(ctx: AppContext, item: ItemDetail, m: CardModel): MsxContentRoot {
  const rows: OptionRow[] = [];
  if (m.film !== undefined) rows.push(watchedRow(m.film.ref, m.film.status, true));
  rows.push({ label: T.mode, action: panelAction(ctx.P, ids.panel("mode", item.id)) });
  rows.push({ label: T.refresh, action: commitMsg(msgs.act("item", "refresh", item.id)) });
  return optionsRoot(rows, ruTitle(item.title));
}

/** «2023 · Драма, Триллер · США{br}КП 7,9 · IMDb 8,1 · 2 ч 01 мин{br}{br}сюжет» — пустые части опускаются. */
function describe(item: ItemDetail): string {
  const line = (parts: (string | undefined)[]): string => parts.filter((p): p is string => p !== undefined && p !== "").join(" · ");
  const head = line([
    item.year !== undefined && item.year > 0 ? String(item.year) : undefined,
    item.genres.map((g) => g.title).join(", "),
    item.countries.join(", "),
  ]);
  const facts = line([
    rating(T.kp, item.kpRating), rating(T.imdb, item.imdbRating),
    item.durationAvg !== undefined && item.durationAvg > 0 ? fmtMinutes(item.durationAvg) : undefined,
  ]);
  const plot = clip((item.plot ?? "").replace(/\s+/g, " ").trim(), PLOT_MAX);
  const text = [head, facts].filter((s) => s !== "").join("{br}");
  return plot === "" ? text : `${text}{br}{br}${plot}`;
}

function rating(name: string, v: number | undefined): string | undefined {
  const r = fmtRating(v);
  return r === "" ? undefined : `${name} ${r}`;
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * Субтитры карточки `nolinks=1` — неполный список (полный приходит с `media-links`), поэтому без совпадения
 * показываем выбранную в настройках дорожку: resolve найдёт её в полном списке.
 */
function subsName(unit: MediaUnit, sp: SelectPrefs, audio: Audio | undefined): string {
  const sub = pickSubtitle(unit.subtitles, sp, audio?.lang);
  return subsTitle(sub ?? parseSubsValue(sp.titleSubs ?? sp.subsLang));
}

// --- Сообщения `act:item:*` ---

/** `act:item:<name>:<args…>`: `watched`, `refresh`. */
export async function onItemAct(ctx: AppContext, name: string, args: string[]): Promise<void> {
  switch (name) {
    case "watched":
      return markWatched(ctx, args);
    case "refresh":
      return refreshCard(ctx, args);
    default:
      ctx.log.warn(TAG, "unknown_act", { name });
  }
}

const int = (s: string | undefined, min: number): number | undefined => {
  const n = s === undefined || !/^\d+$/.test(s) ? Number.NaN : Number(s);
  return Number.isSafeInteger(n) && n >= min ? n : undefined;
};

/** `watched:<id>:<season>:<video>:<0|1>`; отметка видна сразу через оверлей, даже если ушла в outbox (спец. §12). */
async function markWatched(ctx: AppContext, args: string[]): Promise<void> {
  const [id, season, video, desired] = [int(args[0], 1), int(args[1], 0), int(args[2], 1), int(args[3], 0)];
  if (id === undefined || season === undefined || video === undefined || (desired !== 0 && desired !== 1)) {
    ctx.log.warn(TAG, "watched_bad_args", { args });
    return;
  }
  const result = await ctx.outbox.setWatched(id, season, video, desired);
  ctx.overlay.set(id, season, video, { time: knownTime(ctx, id, season, video), status: desired === 1 ? 1 : -1 });
  ctx.repo.invalidateAfterProgress(id);
  ctx.log.info(TAG, "watched", { id, season, video, desired, result });
  if (showsTitle(ctx, id)) ctx.host.executeAction("reload:content");
}

async function refreshCard(ctx: AppContext, args: string[]): Promise<void> {
  const id = int(args[0], 1);
  if (id === undefined) {
    ctx.log.warn(TAG, "refresh_bad_args", { args });
    return;
  }
  await freshItem(ctx, id, "fg");
  if (showsTitle(ctx, id)) ctx.host.executeAction("reload:content");
}

/** Позиция, которую знает ТВ: KinoPub при переключении отметки её не сбрасывает. */
function knownTime(ctx: AppContext, id: number, season: number, video: number): number {
  const got = ctx.repo.peekItem(id);
  const hit = got === undefined ? undefined : orderedUnits(got.value).find((r) => r.season === season && r.video === video);
  return got === undefined || hit === undefined ? 0 : mergedState(got.value, hit, ctx.overlay.get, got.fetchedAt).time;
}

/** Перерисовка — только если текущий экран — карточка или сезон этого тайтла (спец. §6.3, CD-16). */
function showsTitle(ctx: AppContext, id: number): boolean {
  const cur = ctx.current.get();
  if (cur === undefined) return false;
  const r = parseDataId(cur);
  return (r.k === "item" || r.k === "season") && r.id === id;
}
