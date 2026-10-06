import type { AppContext } from "../app/context.ts";
import type { FileInfo, ItemDetail, MediaUnit, Subtitle } from "../api/models.ts";
import { cacheKeys } from "../cache/repo.ts";
import { sleep } from "../core/clock.ts";
import { KpError, toKpError } from "../core/errors.ts";
import { chain, commitMsg, playerMsg, replaceContent, resolveAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { type EpRef, findUnit } from "../playback/episodes.ts";
import { playLabel } from "../playback/resolve.ts";
import { type SubsChoice, parseSubsValue, subsValue } from "../playback/prefs.ts";
import { pickAudio, pickFile, pickSubtitle, selectPrefs } from "../playback/select.ts";
import { qualityOf, withLoc } from "../playback/url.ts";
import { positionFrom } from "../progress/samples.ts";
import { type ListKey, decodeListKey, encodeListKey, ids, listFlag, msgs } from "../router/ids.ts";
import { errorScreen, errorText } from "./error.ts";
import { genresOrStatic } from "./genres-static.ts";
import { freshItem } from "./item.ts";
import { SORTS } from "./list.ts";
import { MODE_NAMES, audioName, countryName, dim, folderName, subsName } from "./panels-labels.ts";
import { seasonFlag, seasonLabel } from "./season.ts";
import { settingPanel } from "./settings.ts";

// Панели S6 и S10 (спец. §3.4, §9.1, §11; Plan B S6, S10, §5.10): сетка 8×6, строка-кнопка на вариант.
// Выбор приходит сообщением `act:panel:…`; до старта (`c`) — сохранить и перерисовать карточку, в плеере (`p`) —
// озвучка и качество перезапуском того же `mid` с текущей позиции, субтитры — без перезапуска.

const T = {
  sort: "Сортировка", genre: "Жанр", allGenres: "Все жанры", audio: "Озвучка", quality: "Качество", auto: "Авто",
  upTo: "до", subs: "Субтитры", subsOff: "Выключены", bookmarks: "Закладки", createFolder: "Создать папку „MSX“ и добавить",
  seasons: "Сезоны", mode: "Способ воспроизведения",
  modeTv: "Как в настройках", loc: "CDN-сервер", locDefault: "По умолчанию", none: "Нет вариантов",
  noPos: "Не удалось узнать позицию — выбор сработает при следующем запуске",
};

const TAG = "panels";
const CHECK = "{ico:check} ";
const ROW = "0,0,8,1";
/** V-13: 31 жанр — две колонки, 12 на экран. */
const HALF = "0,0,4,1";
const BACK_RELOAD = chain(["back", "reload:content"]);
const MSX_FOLDER = "MSX";
/** «Обновлённые» — первая в списке и сортировка по умолчанию у ключей без `sort` (list.ts). */
const DEFAULT_SORT = SORTS[0].id;
/** Название локации устройства — подсказка к «По умолчанию»; панель не ждёт его дольше этого. */
const DEVICE_WAIT_MS = 1500;
const SUBS_VALUE = /^(off|[a-z]{2,8}(\.forced)?)$/i;
const LOC_CODE = /^[a-z0-9_-]+$/i;
const SUBTITLE = "tizen:subtitle";

type Where = "c" | "p";
interface Row { label: string; action: string; current: boolean }
interface UnitArgs { id: number; mid: number; where: Where }
interface TitleUnit { item: ItemDetail; unit: MediaUnit; ref: EpRef }

const bad = (what: string): KpError => new KpError("KP-BAD", `bad panel ${what}`);
const int = (s: string | undefined, min: number): number | undefined => {
  const n = s === undefined || !/^\d+$/.test(s) ? Number.NaN : Number(s);
  return Number.isSafeInteger(n) && n >= min ? n : undefined;
};
const where = (s: string | undefined): Where | undefined => (s === "c" || s === "p" ? s : undefined);
const sameLang = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const isAvc = (f: FileInfo): boolean => /^(h264|avc)/i.test(f.codec);
const fileQuality = (f: FileInfo | undefined): number | undefined => (f === undefined ? undefined : qualityOf(f));

export function choicePanel(ctx: AppContext, title: string, rows: Row[], layout: string = ROW): MsxContentRoot {
  const list = rows.length > 0 ? rows : [{ label: T.none, action: "back", current: false }];
  const first = list.findIndex((r) => r.current);
  const items = list.map((r, i): MsxContentItem => {
    const it: MsxContentItem = { label: r.current ? CHECK + r.label : r.label, action: r.action };
    return i === first ? { ...it, focus: true } : it;
  });
  return { type: "list", headline: title, cache: false, reuse: false, template: { type: "button", layout }, items };
}

/** `panel:<тип>:<аргументы>`; любая ошибка — экран ошибки внутри панели (сетка 8, «Повторить» — `reload:panel`). */
export async function panelScreen(ctx: AppContext, type: string, args: string[]): Promise<MsxContentRoot> {
  try {
    switch (type) {
      case "sort": return sortPanel(ctx, args[0]);
      case "genre": return await genrePanel(ctx, args[0]);
      case "audio": return await audioPanel(ctx, unitArgs(args));
      case "quality": return await qualityPanel(ctx, unitArgs(args));
      case "subs": return await subsPanel(ctx, unitArgs(args));
      case "bookmarks": return await bookmarksPanel(ctx, int(args[0], 1));
      case "mode": return modePanel(ctx, int(args[0], 1));
      case "loc": return await locPanel(ctx);
      case "seasons": return await seasonsPanel(ctx, int(args[0], 1), int(args[1], 0));
      case "setting": return await settingPanel(ctx, args[0] ?? "");
      default: throw bad(type);
    }
  } catch (e) {
    ctx.log.warn(TAG, "panel_failed", { type, err: toKpError(e).code });
    return errorScreen(ctx, e, ids.panel(type, ...args));
  }
}

// --- S6: сортировка и жанр ---

function listArg(arg: string | undefined, sources: readonly ListKey["src"][]): { key: string; k: ListKey } {
  const key = arg ?? "";
  const k = decodeListKey(key);
  if (!sources.includes(k.src)) throw bad("list");
  return { key, k };
}

/** `replace:` по флагу текущего списка: новый список придёт со своим флагом (спец. §11 S6). */
const switchList = (ctx: AppContext, key: string, next: ListKey): string =>
  chain(["back", replaceContent(listFlag(key), ctx.P, ids.list(encodeListKey(next)))]);

function sortPanel(ctx: AppContext, arg: string | undefined): MsxContentRoot {
  const { key, k } = listArg(arg, ["catalog"]);
  const cur = k.sort || DEFAULT_SORT;
  return choicePanel(ctx, T.sort, SORTS.map((s) => ({ label: s.title, action: switchList(ctx, key, { ...k, sort: s.id }), current: s.id === cur })));
}

async function genrePanel(ctx: AppContext, arg: string | undefined): Promise<MsxContentRoot> {
  const { key, k } = listArg(arg, ["catalog", "fresh", "popular", "hot"]);
  const { genre: cur, ...all } = k;
  const rows: Row[] = [{ label: T.allGenres, action: switchList(ctx, key, all), current: !cur }];
  for (const g of await genresOrStatic(ctx, (k.type ?? "").split(",")[0])) {
    rows.push({ label: g.title, action: switchList(ctx, key, { ...k, genre: String(g.id) }), current: cur === String(g.id) });
  }
  return choicePanel(ctx, T.genre, rows, HALF);
}

// --- S10: озвучка, качество, субтитры ---

function unitArgs(args: string[]): UnitArgs {
  const [id, mid, w] = [int(args[0], 1), int(args[1], 1), where(args[2])];
  if (id === undefined || mid === undefined || w === undefined) throw bad("unit");
  return { id, mid, where: w };
}

async function titleUnit(ctx: AppContext, id: number, mid: number): Promise<TitleUnit> {
  const item = (await ctx.repo.item(id)).value;
  const hit = findUnit(item, mid);
  if (hit === undefined) throw new KpError("KP-404", "unit-not-found", undefined, `mid ${mid}`);
  return { item, unit: hit.unit, ref: hit.ref };
}

const panelAct = (name: string, ...args: (string | number)[]): string => commitMsg(msgs.act("panel", name, ...args));

/** Строка на дорожку: выбор идёт по `index`, а ключ озвучки без кодека (Plan B F12). */
async function audioPanel(ctx: AppContext, a: UnitArgs): Promise<MsxContentRoot> {
  const { unit } = await titleUnit(ctx, a.id, a.mid);
  const p = ctx.prefs.get();
  const cur = pickAudio(unit.audios, selectPrefs(p, a.id));
  const audios = unit.audios.slice().sort((x, y) => x.index - y.index);
  return choicePanel(ctx, T.audio, audios.map((x) => ({
    label: audioName(x, p.allowAc3), action: panelAct("audio", a.id, a.mid, x.index, a.where), current: x.index === cur?.index,
  })));
}

/** Качества, которые может выбрать `pickFile`: без HEVC — только AVC, если он есть (Plan B §5.4). */
function ladder(files: FileInfo[], allowHevc: boolean): number[] {
  const avc = files.filter(isAvc);
  const cands = !allowHevc && avc.length > 0 ? avc : files;
  return [...new Set(cands.map(qualityOf))].sort((x, y) => y - x);
}

async function qualityPanel(ctx: AppContext, a: UnitArgs): Promise<MsxContentRoot> {
  const { unit } = await titleUnit(ctx, a.id, a.mid);
  const p = ctx.prefs.get();
  const chosen = p.titleQuality[String(a.id)];
  const rows: Row[] = [{ label: `${T.auto} (${T.upTo} ${p.maxQuality}p)`, action: panelAct("quality", a.id, a.mid, 0, a.where), current: chosen === undefined }];
  for (const q of ladder(unit.files, p.allowHevc)) {
    rows.push({ label: q > p.maxQuality ? dim(`${q}p`) : `${q}p`, action: panelAct("quality", a.id, a.mid, q, a.where), current: chosen === q });
  }
  return choicePanel(ctx, T.quality, rows);
}

const findTrack = (subs: Subtitle[], c: SubsChoice): Subtitle | undefined =>
  subs.find((s) => s.forced === c.forced && sameLang(s.lang, c.lang));
/** Обычная и форсированная дорожки языка — разные строки; несколько обычных одного языка — одна (Plan B S10). */
const subsTracks = (subs: Subtitle[]): SubsChoice[] =>
  subs.filter((s) => s.lang !== "" && findTrack(subs, s) === s).map((s) => ({ lang: s.lang, forced: s.forced }));

/** Выбор для тайтла, иначе то, что подберёт resolve (Plan B §5.6). */
function currentSubs(ctx: AppContext, id: number, unit: MediaUnit, subs: Subtitle[]): SubsChoice | "off" {
  const p = ctx.prefs.get();
  const v = p.titleSubs[String(id)];
  if (v !== undefined) return parseSubsValue(v);
  const sp = selectPrefs(p, id);
  const s = pickSubtitle(subs, sp, pickAudio(unit.audios, sp)?.lang);
  return s === undefined ? "off" : { lang: s.lang, forced: s.forced };
}

/** Полный список субтитров — только в `media-links` (в карточке 0–3 строки, Plan B §5.6). */
async function subsPanel(ctx: AppContext, a: UnitArgs): Promise<MsxContentRoot> {
  const { unit } = await titleUnit(ctx, a.id, a.mid);
  const subs = (await ctx.repo.links(a.mid, { cls: "fg" })).subtitles;
  const cur = currentSubs(ctx, a.id, unit, subs);
  const rows: Row[] = [{ label: T.subsOff, action: panelAct("subs", a.id, a.mid, "off", a.where), current: cur === "off" }];
  for (const c of subsTracks(subs)) {
    rows.push({
      label: subsName(c), action: panelAct("subs", a.id, a.mid, subsValue(c), a.where),
      current: cur !== "off" && cur.forced === c.forced && sameLang(cur.lang, c.lang),
    });
  }
  return choicePanel(ctx, T.subs, rows);
}

// --- S10: закладки, режим потока, CDN; сезоны S9 ---

async function bookmarksPanel(ctx: AppContext, id: number | undefined): Promise<MsxContentRoot> {
  if (id === undefined) throw bad("bookmarks");
  const [folders, got] = await Promise.all([ctx.repo.bookmarkFolders(), ctx.repo.item(id)]);
  const marked = new Set(got.value.bookmarks);
  const rows = folders.value.map((f) => ({
    label: folderName(f.title, marked.has(f.id)), action: panelAct("bm", id, f.id, marked.has(f.id) ? "remove" : "add"), current: marked.has(f.id),
  }));
  const create = { label: T.createFolder, action: panelAct("bm", id, 0, "create"), current: false };
  return choicePanel(ctx, T.bookmarks, rows.length > 0 ? rows : [create]);
}

/** Р-28: «Авто» тайтла — это способ из настроек ТВ, если там он выбран вручную. */
function modePanel(ctx: AppContext, id: number | undefined): MsxContentRoot {
  if (id === undefined) throw bad("mode");
  const p = ctx.prefs.get();
  const chosen = p.titleMode[String(id)];
  const auto = p.streamMode === undefined ? T.auto : `${T.modeTv}: ${MODE_NAMES[p.streamMode]}`;
  return choicePanel(ctx, T.mode, (["auto", "hls1", "hls2"] as const).map((m) => ({
    label: m === "auto" ? auto : MODE_NAMES[m], action: panelAct("mode", id, m), current: (chosen ?? "auto") === m,
  })));
}

/**
 * Plan B §5.14: без выбора ТВ ссылки идут с `loc` устройства KinoPub — её страна подсказывает «По умолчанию» и
 * не повторяется в списке (V-35), если её не выбрали вручную.
 */
async function locPanel(ctx: AppContext): Promise<MsxContentRoot> {
  const device = Promise.race([deviceLocation(ctx), sleep(ctx.clock, DEVICE_WAIT_MS).then(() => undefined)]);
  const [locs, dev] = await Promise.all([ctx.repo.serverLocations(), device]);
  const cur = ctx.prefs.get().loc;
  const own = dev === undefined ? undefined : locs.value.find((l) => l.id === dev.id);
  const name = own === undefined ? dev?.label : countryName(own.location, own.name);
  const rows: Row[] = [{ label: name ? `${T.locDefault} (${name})` : T.locDefault, action: panelAct("loc", "default"), current: cur === undefined }];
  for (const l of locs.value) {
    if (!LOC_CODE.test(l.location) || (l === own && cur !== l.location)) continue;
    rows.push({ label: countryName(l.location, l.name), action: panelAct("loc", l.location), current: cur === l.location });
  }
  return choicePanel(ctx, T.loc, rows);
}

/** CDN-сервер устройства KinoPub — из кэша `device/info` (Plan B §7.2); сбой не мешает панели. */
async function deviceLocation(ctx: AppContext): Promise<{ id: number; label: string } | undefined> {
  try {
    return (await ctx.repo.deviceInfo()).value.location;
  } catch (e) {
    ctx.log.debug(TAG, "device_location_failed", { err: toKpError(e).code });
    return undefined;
  }
}

/** Plan B S9: больше 8 сезонов — выбор панелью; замена по флагу текущего сезона (M-01). */
async function seasonsPanel(ctx: AppContext, id: number | undefined, n: number | undefined): Promise<MsxContentRoot> {
  if (id === undefined || n === undefined) throw bad("seasons");
  const got = await ctx.repo.item(id);
  const numbers = got.value.seasons.filter((s) => s.episodes.length > 0).map((s) => s.number).sort((x, y) => x - y);
  if (numbers.length === 0) throw new KpError("KP-404", "no-seasons", undefined, `item ${id}`);
  return choicePanel(ctx, T.seasons, numbers.map((s) => ({
    label: seasonLabel(ctx, got.value, got.fetchedAt, s), current: s === n,
    action: chain(["back", replaceContent(seasonFlag(id, n), ctx.P, ids.season(id, s))]),
  })));
}

// --- Сообщения `act:panel:*` ---

/** `act:panel:<name>:<args…>`: `audio`, `quality`, `subs`, `bm`, `mode`, `loc`. */
export async function onPanelAct(ctx: AppContext, name: string, args: string[]): Promise<void> {
  switch (name) {
    case "audio": return chooseAudio(ctx, args);
    case "quality": return chooseQuality(ctx, args);
    case "subs": return chooseSubs(ctx, args);
    case "bm": return bookmark(ctx, args);
    case "mode": return chooseMode(ctx, args);
    case "loc": return chooseLoc(ctx, args);
    default: ctx.log.warn(TAG, "unknown_act", { name });
  }
}

const badArgs = (ctx: AppContext, name: string, args: string[]): void => ctx.log.warn(TAG, "bad_args", { name, args });

/** `audio:<id>:<mid>:<index>:<c|p>`. Ключ озвучки без кодека (Plan B F12): строки одной озвучки дают один выбор. */
async function chooseAudio(ctx: AppContext, args: string[]): Promise<void> {
  const [id, mid, index, w] = [int(args[0], 1), int(args[1], 1), int(args[2], 1), where(args[3])];
  if (id === undefined || mid === undefined || index === undefined || w === undefined) return badArgs(ctx, "audio", args);
  const tu = await titleUnit(ctx, id, mid);
  const a = tu.unit.audios.find((x) => x.index === index);
  if (a === undefined) return badArgs(ctx, "audio", args);
  const playing = (): number | undefined => pickAudio(tu.unit.audios, selectPrefs(ctx.prefs.get(), id))?.index;
  const before = playing();
  ctx.prefs.chooseAudio(id, a);
  await applied(ctx, w, tu, playing() !== before);
}

/** `quality:<id>:<mid>:<q|0>:<c|p>`; 0 — «Авто» (потолок из настроек). */
async function chooseQuality(ctx: AppContext, args: string[]): Promise<void> {
  const [id, mid, q, w] = [int(args[0], 1), int(args[1], 1), int(args[2], 0), where(args[3])];
  if (id === undefined || mid === undefined || q === undefined || w === undefined) return badArgs(ctx, "quality", args);
  const tu = await titleUnit(ctx, id, mid);
  const playing = (): number | undefined => fileQuality(pickFile(tu.unit.files, selectPrefs(ctx.prefs.get(), id)));
  const before = playing();
  ctx.prefs.setTitle("quality", id, q === 0 ? undefined : q);
  await applied(ctx, w, tu, playing() !== before);
}

/**
 * До старта — перерисовать карточку; в плеере — перезапуск с позиции, если меняется то, что играет (спец. §9.1).
 * Позиция неизвестна — без перезапуска: с 0 он потерял бы просмотренное (X-2), выбор сработает при следующем запуске.
 */
async function applied(ctx: AppContext, w: Where, tu: TitleUnit, changed: boolean): Promise<void> {
  if (w === "c" || !changed) return ctx.host.executeAction(w === "c" ? BACK_RELOAD : "back");
  const { item, ref } = tu;
  const pos = await playerPosition(ctx, item.id, ref);
  if (pos === undefined) {
    ctx.log.warn(TAG, "no_position", { mid: ref.mid });
    return ctx.host.executeAction(chain(["back", `info:${T.noPos}`]));
  }
  const resolve = resolveAction(ctx.P, ids.playEp(item.id, ref.mid, ref.season, ref.video, { at: Math.floor(pos) }));
  // `video:` из цепочки берёт метку плеера только из `data` (msx-platform §3.2).
  ctx.host.executeAction(chain(["cleanup", "player:eject", resolve]), { playerLabel: playLabel(item, ref) });
}

/**
 * Позиция плеера (Plan B §5.10). Нет её или 0 (плеер ещё грузит «Продолжить») — проверенная позиция или максимум
 * сессии этого `mid` (при «Продолжить» он засеян `resume:position`); сессии нет — недосмотренная позиция оверлея.
 */
async function playerPosition(ctx: AppContext, id: number, ref: EpRef): Promise<number | undefined> {
  const pos = await ctx.host.requestData("video").then((d) => positionFrom(d).position, () => undefined);
  if (pos !== undefined && pos > 0) return pos;
  const s = ctx.tracker.session();
  const o = ctx.overlay.get(id, ref.season, ref.video);
  const known = s?.mid === ref.mid ? s.lastPos || s.peak : o?.status === 0 ? o.time : undefined;
  return known || pos;
}

/** `subs:<id>:<mid>:<lang|lang.forced|off>:<c|p>`; в плеере — динамические свойства AVPlay (Plan B §5.10). */
async function chooseSubs(ctx: AppContext, args: string[]): Promise<void> {
  const [id, mid, value, w] = [int(args[0], 1), int(args[1], 1), args[2] ?? "", where(args[3])];
  if (id === undefined || mid === undefined || !SUBS_VALUE.test(value) || w === undefined) return badArgs(ctx, "subs", args);
  ctx.prefs.setTitle("subs", id, value);
  const choice = parseSubsValue(value);
  if (w === "c") return ctx.host.executeAction(BACK_RELOAD);
  if (choice === "off") return ctx.host.executeAction(chain(["back", playerMsg(`${SUBTITLE}:silent:true`)]));
  const sub = findTrack((await ctx.repo.links(mid, { cls: "fg" })).subtitles, choice);
  if (sub === undefined) {
    ctx.log.warn(TAG, "subs_not_found", { mid, value });
    return ctx.host.executeAction("back");
  }
  // После «Выключены» дорожка заглушена: новая ссылка сама её не включит.
  const url = withLoc(sub.url, ctx.prefs.get().loc);
  ctx.host.executeAction(chain(["back", playerMsg(`${SUBTITLE}:silent:false`), playerMsg(`${SUBTITLE}:url:${url}`)]));
}

/** `bm:<id>:<folder>:<add|remove|create>`; `create` — папка «MSX», когда папок нет (Plan B S10). */
async function bookmark(ctx: AppContext, args: string[]): Promise<void> {
  const [id, folder, op] = [int(args[0], 1), int(args[1], 0), args[2]];
  const ok = op === "create" || ((op === "add" || op === "remove") && folder !== undefined && folder > 0);
  if (id === undefined || folder === undefined || !ok) return badArgs(ctx, "bm", args);
  let target = folder;
  try {
    if (op === "create") target = (await ctx.api.bookmarkCreate(MSX_FOLDER)).id;
    if (target <= 0) throw new KpError("KP-BAD", "bad-folder");
    await (op === "remove" ? ctx.api.bookmarkRemove(id, target) : ctx.api.bookmarkAdd(id, target));
  } catch (e) {
    ctx.log.warn(TAG, "bookmark_failed", { id, folder, op, err: toKpError(e).code });
    ctx.host.executeAction(`info:${errorText(e).text}`);
    return;
  }
  ctx.repo.invalidateAfterBookmark(id, target);
  // Пометка «устаревшее» отдала бы прежний список (без новой папки) и прежние отметки: панель ждёт свежие.
  ctx.cache.delete(cacheKeys.bookmarks());
  await freshItem(ctx, id, "fg").catch((e: unknown) => ctx.log.debug(TAG, "item_refresh_failed", { id, err: toKpError(e).code }));
  // Спец. §6.3: ответы API приходят не сразу — перерисовка, только если под панелью всё ещё карточка этого тайтла.
  if (ctx.current.isCurrent(ids.item(id))) ctx.host.executeAction(chain(["reload:panel", "reload:content"]));
}

/** `mode:<id>:<auto|hls1|hls2>`; ручной режим отключает автоцепочку fallback (Р-28, Plan B §5.11). */
function chooseMode(ctx: AppContext, args: string[]): void {
  const [id, mode] = [int(args[0], 1), args[1]];
  if (id === undefined || (mode !== "auto" && mode !== "hls1" && mode !== "hls2")) return badArgs(ctx, "mode", args);
  ctx.prefs.setTitle("mode", id, mode === "auto" ? undefined : mode);
  ctx.host.executeAction(BACK_RELOAD);
}

/** `loc:<code|default>`: параметр `loc` всех ссылок потока и субтитров этого ТВ (Plan B §5.14). */
function chooseLoc(ctx: AppContext, args: string[]): void {
  const code = args[0] ?? "";
  if (!LOC_CODE.test(code)) return badArgs(ctx, "loc", args);
  ctx.prefs.update({ loc: code === "default" ? undefined : code });
  ctx.host.executeAction(BACK_RELOAD);
}
