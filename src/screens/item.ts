import type { AppContext } from "../app/context.ts";
import type { Audio, ItemDetail, MediaUnit } from "../api/models.ts";
import type { ReqClass } from "../api/transport.ts";
import { cacheKeys } from "../cache/repo.ts";
import type { Got } from "../cache/swr.ts";
import { KpError, toKpError } from "../core/errors.ts";
import { fmtMinutes, fmtRating, ruTitle } from "../core/format.ts";
import { chain, commitMsg, contentAction, panelAction, resolveAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot, MsxResolveResponse } from "../msx/types.ts";
import { continueTarget, findUnit, mainButtonLabel, mergedState, neighbours, orderedUnits } from "../playback/episodes.ts";
import type { ContinueTarget, EpRef } from "../playback/episodes.ts";
import { FRESH_CARD_MS } from "../playback/resolve.ts";
import { parseSubsValue, pickAudio, pickFile, pickSubtitle, selectPrefs } from "../playback/select.ts";
import type { SelectPrefs } from "../playback/select.ts";
import { qualityLabel } from "../playback/url.ts";
import { encodeListKey, ids, msgs, parseDataId } from "../router/ids.ts";
import { errorScreen, errorText } from "./error.ts";
import { audioTitle, playerProps, subsTitle } from "./player.ts";
import type { PlayerPropsInput } from "./player.ts";
import { personalHash, scheduleRefresh, trackScreen } from "./refresh.ts";
import type { RefreshSpec } from "./refresh.ts";
import { setWatchlist } from "./tile-actions.ts";

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
  trailer: "Трейлер",
  inList: "✓ В списке",
  toList: "★ Буду смотреть",
  director: "Режиссёр",
  cast: "В ролях",
  voices: "Озвучки",
  andMore: "и ещё",
  watched: "просмотрено",
  of: "из",
  onAir: "Выходит",
  ended: "Завершён",
  noTrailer: "Трейлер недоступен",
  marked: "Отмечено",
  adding: "Добавляю…",
  removing: "Убираю…",
  busy: "Уже выполняется",
  unmarked: "Отметка снята",
  more: "{ico:msx-red:stop} Ещё",
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
/**
 * v1.19: ряд над «▶» — «Трейлер» (2 колонки) и «Буду смотреть» у сериала (3); тогда текст — три ряда сетки, иначе четыре.
 * В ряду сетки при 1920×1080 три строки текста по 82–87 знаков (замер скриншотом web MSX): строка фактов — до `LINE`
 * знаков, сюжет с переносом по словам — по `CPL` на строку, сколько строк осталось.
 */
const LINE = 80;
const CPL = 70;
const MAX_CAST = 6;
/** Без `kp:*` трекер не считает трейлер просмотром (`load_without_kp`); «Назад» и конец ролика закрывают плеер, как эфир. */
const TRAILER_PROPS = { "control:type": "extended", "trigger:back": "player:eject", "trigger:complete": "player:eject" };
/** Главная кнопка: на ней фокус при открытии и после плеера (V-16). */
const MAIN_ID = "b_main";

const TAG = "item";
const PLOT_MAX = 600;
/** Plan B §7.7: условное обновление ждёт свежую карточку не дольше 3 с. */
const REFRESH_WAIT_MS = 3000;
/** Сверка перед переключателем ждёт свежую карточку дольше сроков транспорта: по таймеру отдался бы кэш (CM-01). */
const TOGGLE_WAIT_MS = 60_000;
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
  /** Сериал: «Буду смотреть» и просмотрено серий из всех (с оверлеем). */
  wl?: boolean;
  seen?: [number, number];
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
  if (isSerial(item)) {
    const wl = wlMemory(ctx).get(item.id);
    out.wl = wl !== undefined && wl.at >= fetchedAt ? wl.on : item.watchlist === true;
    out.seen = [refs.filter((r) => mergedState(item, r, ctx.overlay.get, fetchedAt).status === 1).length, refs.length];
  }
  return out;
}

/** Персональная часть карточки (Plan B §7.7): подпись главной кнопки, её серия, закладки, статус фильма. */
export function itemHash(ctx: AppContext, item: ItemDetail, fetchedAt: number): string {
  const m = model(ctx, item, fetchedAt);
  return personalHash({ b: m.label, m: m.target?.ref.mid ?? 0, bm: m.inBookmarks, w: m.film?.status ?? null, l: m.wl, s: m.seen });
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
    type: "pages", flag: itemFlag(id), cache: false, extension: T.more, options: cardOptions(ctx, item, m),
    pages: [{ items: cardItems(ctx, item, m) }],
  };
  if (ctx.prefs.get().cardBackgrounds) root.background = item.posters.wide ?? item.posters.big;
  if (m.target !== undefined) prefetchLinks(ctx, m.target.ref.mid);
  const spec = itemRefreshSpec(ctx, id, itemHash(ctx, item, got.fetchedAt));
  trackScreen(ctx, spec);
  // QA-PLAY-3: позиция с другого устройства — карточку старше минуты сверяем фоном, экран меняется при новом хеше.
  if (got.stale || ctx.clock.now() - got.fetchedAt > FRESH_CARD_MS) scheduleScreenRefresh(ctx, spec);
  return root;
}

function cardItems(ctx: AppContext, item: ItemDetail, m: CardModel): MsxContentItem[] {
  const { P } = ctx;
  const id = item.id;
  const withProps = ctx.flags.get().playerPropsIn === "item";
  // v1.19: ряд над «▶» — трейлер и «Буду смотреть»; без них текст занимает и этот ряд.
  const row: MsxContentItem[] = [];
  if (item.trailer !== undefined) {
    row.push({ id: "b_trailer", type: "button", layout: "3,3,2,1", label: `{ico:movie} ${T.trailer}`, action: resolveAction(P, ids.playTrailer(id)), properties: TRAILER_PROPS });
  }
  if (m.wl !== undefined) {
    row.push({ id: "b_wl", type: "button", layout: `${row.length > 0 ? 5 : 3},3,3,1`, label: m.wl ? T.inList : T.toList, action: commitMsg(msgs.act("item", "wl", id, m.wl ? 0 : 1)) });
  }
  const rows = row.length > 0 ? 3 : 4;
  const out: MsxContentItem[] = [
    { type: "space", layout: "0,0,3,5", image: item.posters.big, imageFiller: "fit" },
    { type: "space", layout: `3,0,9,${rows}`, headline: ruTitle(item.title), text: describe(item, m, rows) },
    ...row,
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
  // v1.19: тайтлы режиссёра и актёров — поиск `field=director|cast` по одному имени (HC `video.md`).
  const person = (field: "cast" | "director", label: string, n: string): OptionRow => ({
    label: `{ico:search} ${label}: ${n}`, action: contentAction(ctx.P, ids.person(field, n)),
  });
  rows.push(...(item.director ?? []).map((n) => person("director", T.director, n)), ...(item.cast ?? []).slice(0, MAX_CAST).map((n) => person("cast", T.cast, n)));
  rows.push({ label: T.mode, action: panelAction(ctx.P, ids.panel("mode", item.id)) });
  rows.push({ label: T.refresh, action: commitMsg(msgs.act("item", "refresh", item.id)) });
  return optionsRoot(rows, ruTitle(item.title));
}

/**
 * «2023 · Драма, Триллер · США{br}КП 7,9 · IMDb 8,1 · 45 мин · Выходит · просмотрено 12 из 30{br}Режиссёр: …{br}В ролях: …
 * {br}Озвучки: А, Б, В и ещё 2{br}{br}сюжет» — пустые части опускаются. Сюжет — сколько осталось строк в `rows` рядах.
 */
function describe(item: ItemDetail, m: CardModel, rows: number): string {
  const line = (parts: (string | undefined)[]): string => parts.filter((p): p is string => p !== undefined && p !== "").join(" · ");
  const head = line([
    item.year !== undefined && item.year > 0 ? String(item.year) : undefined,
    item.genres.map((g) => g.title).join(", "),
    item.countries.join(", "),
  ]);
  const seen = m.seen !== undefined && m.seen[0] > 0 ? `${T.watched} ${m.seen[0]} ${T.of} ${m.seen[1]}` : undefined;
  const facts = line([
    rating(T.kp, item.kpRating), rating(T.imdb, item.imdbRating),
    item.durationAvg !== undefined && item.durationAvg > 0 ? fmtMinutes(item.durationAvg) : undefined,
    m.seen === undefined || item.finished === undefined ? undefined : item.finished ? T.ended : T.onAir, seen,
  ]);
  const studios = item.voice?.split(",").map((v) => v.trim()).filter((v) => v !== "") ?? [...new Set(m.unit?.audios.map(audioTitle))];
  const info = [head, facts, names(T.director, item.director), names(T.cast, item.cast), voices(studios)].filter((x) => x !== "");
  // Заголовок длиннее строки переносится и забирает строку текста.
  const left = rows * 3 - (ruTitle(item.title).length > 48 ? 1 : 0) - info.reduce((n, x) => n + Math.ceil(x.length / LINE), 0) - 1;
  const plot = left > 0 ? clip((item.plot ?? "").replace(/\s+/g, " ").trim(), Math.min(PLOT_MAX, left * CPL)) : "";
  const text = info.join("{br}");
  return plot === "" ? text : `${text}{br}{br}${plot}`;
}

/** «Режиссёр: А, Б» — имена, пока строка не длиннее `LINE` (хотя бы одно), актёров не больше `MAX_CAST`. */
function names(label: string, list: string[] | undefined): string {
  let out = "";
  for (const n of (list ?? []).slice(0, MAX_CAST)) {
    const next = out === "" ? `${label}: ${n}` : `${out}, ${n}`;
    if (out !== "" && next.length > LINE) break;
    out = next;
  }
  return out;
}

/** «Озвучки: А, Б, В и ещё 2» — до трёх студий в строку, остальные числом. */
function voices(all: string[]): string {
  for (let k = Math.min(3, all.length); k > 0; k--) {
    const s = `${T.voices}: ${all.slice(0, k).join(", ")}${all.length > k ? ` ${T.andMore} ${all.length - k}` : ""}`;
    if (s.length <= LINE || k === 1) return s;
  }
  return "";
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

/** `act:item:<name>:<args…>`: `watched`, `refresh`, `wl`, `season`. */
export async function onItemAct(ctx: AppContext, name: string, args: string[]): Promise<void> {
  switch (name) {
    case "watched":
      return markWatched(ctx, args);
    case "refresh":
      return refreshCard(ctx, args);
    case "wl":
      return watchlist(ctx, args);
    case "season":
      return markSeason(ctx, args);
    default:
      ctx.log.warn(TAG, "unknown_act", { name });
  }
}

const int = (s: string | undefined, min: number): number | undefined => {
  const n = s === undefined || !/^\d+$/.test(s) ? Number.NaN : Number(s);
  return Number.isSafeInteger(n) && n >= min ? n : undefined;
};

/** Действия в полёте по ключу (`w:…`, `s:…`, `wl:…`): повтор до ответа не шлёт мутаций (QA-PLAY-1, QA-PLAY-10). */
const busy = new WeakMap<AppContext, Set<string>>();

/** `fn`, если действия `key` нет в полёте; иначе `false` — повтор. */
async function single(ctx: AppContext, key: string, fn: () => Promise<void>): Promise<boolean> {
  const set = busy.get(ctx) ?? new Set<string>();
  busy.set(ctx, set);
  if (set.has(key)) return false;
  set.add(key);
  try {
    await fn();
  } finally {
    set.delete(key);
  }
  return true;
}

/** Опции, из которых пришла команда, закрываются сразу (QA-PLAY-8): иначе висят с прежней подписью. */
function closeOptions(ctx: AppContext, id: number): void {
  if (showsTitle(ctx, id)) ctx.host.executeAction("cleanup");
}

/**
 * `watched:<id>:<season>:<video>:<0|1>`; отметка видна сразу через оверлей, даже если ушла в outbox (спец. §12). Опции
 * закрываются сразу, итог — коротким `info:`; отказ KinoPub — его текстом (QA-PLAY-8, QA-PLAY-9); повтор до ответа
 * игнорируется (QA-PLAY-10).
 */
async function markWatched(ctx: AppContext, args: string[]): Promise<void> {
  const [id, season, video, desired] = [int(args[0], 1), int(args[1], 0), int(args[2], 1), int(args[3], 0)];
  if (id === undefined || season === undefined || video === undefined || (desired !== 0 && desired !== 1)) {
    ctx.log.warn(TAG, "watched_bad_args", { args });
    return;
  }
  await single(ctx, `w:${id}:${season}:${video}`, async () => {
    closeOptions(ctx, id);
    let result: string;
    try {
      result = await ctx.outbox.setWatched(id, season, video, desired);
    } catch (e) {
      ctx.log.warn(TAG, "watched_failed", { id, season, video, err: toKpError(e).code });
      return ctx.host.executeAction(`info:${errorText(e).text}`);
    }
    ctx.overlay.set(id, season, video, { time: knownTime(ctx, id, season, video), status: desired === 1 ? 1 : -1 });
    ctx.repo.invalidateAfterProgress(id);
    ctx.log.info(TAG, "watched", { id, season, video, desired, result });
    const info = `info:${desired === 1 ? T.marked : T.unmarked}`;
    ctx.host.executeAction(showsTitle(ctx, id) ? chain(["reload:content", info]) : info);
  });
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

/**
 * Итог «Буду смотреть» из ответа переключателя (QA-PLAY-13): главнее карточки, полученной не позже, — `in_watchlist`
 * у KinoPub может отставать. Карточка, перечитанная позже, снова главнее.
 */
const wlMemories = new WeakMap<AppContext, Map<number, { on: boolean; at: number }>>();

function wlMemory(ctx: AppContext): Map<number, { on: boolean; at: number }> {
  const m = wlMemories.get(ctx) ?? new Map<number, { on: boolean; at: number }>();
  wlMemories.set(ctx, m);
  return m;
}

/** Сверка «Буду смотреть» по свежей карточке; кэш вместо неё (нет связи) — ошибка, а не повод переключать (CM-01). */
async function inList(ctx: AppContext, id: number): Promise<boolean> {
  const got = await ctx.repo.item(id, { freshWithinMs: 0, waitMs: TOGGLE_WAIT_MS, cls: "fg" });
  if (got.offline !== undefined) throw new KpError(got.offline, "item-offline");
  return got.value.watchlist === true;
}

/**
 * `wl:<id>:<0|1>` — «Буду смотреть» (v1.19): сразу «Добавляю…»/«Убираю…»; одна сверка свежей карточкой (CM-01: состояние
 * могло смениться на другом ТВ), затем `setWatchlist`, итог — из его ответа (QA-PLAY-13). Одно действие на тайтл в полёте:
 * повтор до ответа — «Уже выполняется» (QA-PLAY-1). «Я смотрю» и главная — устаревшие; перерисовка — только текущего экрана.
 */
async function watchlist(ctx: AppContext, args: string[]): Promise<void> {
  const [id, want] = [int(args[0], 1), args[1]];
  if (id === undefined || (want !== "0" && want !== "1")) return ctx.log.warn(TAG, "wl_bad_args", { args });
  const on = want === "1";
  const ran = await single(ctx, `wl:${id}`, async () => {
    ctx.host.executeAction(`info:${on ? T.adding : T.removing}`);
    try {
      if ((await inList(ctx, id)) !== on) await setWatchlist(ctx, id, on);
    } catch (e) {
      ctx.log.warn(TAG, "wl_failed", { id, err: toKpError(e).code });
      return ctx.host.executeAction(`info:${errorText(e).text}`);
    }
    wlMemory(ctx).set(id, { on, at: ctx.clock.now() });
    ctx.cache.markStale(cacheKeys.serials());
    if (showsTitle(ctx, id)) ctx.host.executeAction("reload:content");
  });
  if (!ran) ctx.host.executeAction(`info:${T.busy}`);
}

/**
 * `season:<id>:<n>:<0|1>` — весь сезон (v1.19). Сверка `watching?id=` (Р-20) → `toggle` сезона без `video` (HC
 * `watching.md`: «модификации подвергаются все эпизоды сезона») только при расхождении → снова сверка; не больше двух
 * переключений: сервер ставит сезону состояние, противоположное целому, и смешанный сезон снимается за два. Что не сошлось
 * (ошибка, сбой связи) — по сериям через outbox: у каждой своя сверка. Оверлей и перерисовка — до него.
 */
async function markSeason(ctx: AppContext, args: string[]): Promise<void> {
  const [id, n, desired] = [int(args[0], 1), int(args[1], 1), int(args[2], 0)];
  if (id === undefined || n === undefined || (desired !== 0 && desired !== 1)) return ctx.log.warn(TAG, "season_bad_args", { args });
  // QA-PLAY-10: повтор до ответа — ни одной мутации; опции закрываются сразу.
  await single(ctx, `s:${id}:${n}`, () => seasonMark(ctx, id, n, desired));
}

async function seasonMark(ctx: AppContext, id: number, n: number, desired: 0 | 1): Promise<void> {
  closeOptions(ctx, id);
  const got = ctx.repo.peekItem(id);
  const eps = got === undefined ? [] : orderedUnits(got.value).filter((r) => r.season === n).map((r) => r.video);
  let left = eps;
  try {
    for (let i = 0; ; i++) {
      left = (await ctx.api.watching(id, "fg")).filter((u) => u.season === n && (u.status === 1 ? 1 : 0) !== desired).map((u) => u.number);
      if (left.length === 0 || i === 2) break;
      await ctx.api.toggleSeason(id, n, "fg");
    }
  } catch (e) {
    ctx.log.warn(TAG, "season_failed", { id, n, err: toKpError(e).code });
  }
  for (const v of eps) ctx.overlay.set(id, n, v, { time: knownTime(ctx, id, n, v), status: desired === 1 ? 1 : -1 });
  ctx.repo.invalidateAfterProgress(id);
  ctx.log.info(TAG, "season", { id, n, desired, left: left.length });
  if (showsTitle(ctx, id)) ctx.host.executeAction("reload:content");
  for (const v of left) {
    await ctx.outbox.setWatched(id, n, v, desired).catch((e: unknown) => ctx.log.warn(TAG, "season_unit_failed", { id, n, v, err: toKpError(e).code }));
  }
}

/** `play:<id>:trailer` (v1.19): ссылка свежей карточки, иначе `items/trailer`; без `kp:*` — без прогресса и `marktime`. */
export async function trailerResolve(ctx: AppContext, id: number): Promise<MsxResolveResponse> {
  const got = await ctx.repo.item(id);
  const url = (got.stale ? undefined : got.value.trailer?.url) ?? (await ctx.api.trailer(id));
  return url === undefined ? { error: T.noTrailer } : { url, label: `${ruTitle(got.value.title)} · ${T.trailer}`, properties: TRAILER_PROPS };
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
