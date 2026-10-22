import type { AppContext } from "../app/context.ts";
import type { BookmarkFolder } from "../api/models.ts";
import { cacheKeys } from "../cache/repo.ts";
import type { ListSource } from "../cache/repo.ts";
import { KpError, toKpError } from "../core/errors.ts";
import { chain, commitMsg, focusAction, panelAction, replaceContent } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { encodeListKey, ids, listFlag, msgs } from "../router/ids.ts";
import type { ListKey } from "../router/ids.ts";
import { errorText } from "./error.ts";
import { controlOptions } from "./list-head.ts";
import type { ListEntry } from "./list.ts";
import { choicePanel } from "./panels.ts";

// Действия над плиткой (спец. §11.4): опции красной кнопки на плитках «Истории», «Я смотрю» и папки закладок. Опции —
// в шаблоне сетки: MSX раскрывает в `template.options` поля плитки в фокусе (`{context:kid}`, `{context:kt}`, проверено
// в web MSX), поэтому они одни на все 96 плиток ответа. Выбор — `act:tile:<действие>:<id>…`; после ответа KinoPub тайтл
// убирается из списка в памяти, текущий экран заменяется своим флагом с фокусом на соседней плитке, связанные кэши
// помечаются устаревшими, внизу — короткое `info:`.

const TAG = "tile";
const T = {
  del: "Удалить из истории", clear: "Очистить всю историю", ask: "Очистить всю историю?", yes: "Очистить", no: "Отмена",
  unwatch: "Убрать из «Я смотрю»", unfold: "Убрать из папки", move: "Переместить в «",
  deleted: "Удалено из истории", clearing: "Очищаю историю…", cleared: "История очищена", partly: "Историю очистить не удалось",
  unwatched: "Убрано из «Я смотрю»", unfolded: "Убрано из папки", moved: "Перемещено в «",
};
const KID = "{context:kid}";
const HISTORY: ListKey = { src: "history" };
/** Страница истории и раундов «Очистить всю историю» — не больше этого (perpage ≤ 50, research kinopub-api §8.3). */
const CLEAR_PAGE = 50;
const CLEAR_ROUNDS = 100;

type Options = Pick<MsxContentItem, "options">;

/** Пункт опций: сначала закрыть опции, затем сообщение плагину. */
const act = (name: string, ...args: (string | number)[]): string => chain(["back", commitMsg(msgs.act(TAG, name, ...args))]);
const opts = (items: MsxContentItem[]): Options => ({ options: controlOptions("{context:kt}", items) });
const folderKey = (folder: number): ListKey => ({ src: "folder", folder });
const int = (s: string | undefined): number => (s !== undefined && /^[1-9]\d{0,14}$/.test(s) ? Number(s) : 0);
/** Название папки в `info:` цепочки: `|`, `[` и `]` MSX принял бы за разметку цепочки. */
const plain = (s: string): string => s.replace(/[|[\]]/g, " ");
const folders = (ctx: AppContext): BookmarkFolder[] => ctx.cache.peek<BookmarkFolder[]>(cacheKeys.bookmarks())?.value ?? [];

/** Опции плиток «Я смотрю»: сериал убирается `togglewatchlist`; у фильма их нет (`NO_OPTIONS`, спец. §11.4). */
export const WATCHING_OPTIONS: Options = opts([{ icon: "visibility-off", label: T.unwatch, action: act("unwatch", KID) }]);
/** Плитка без опций шаблона: MSX показывает свои системные опции, как на экране без опций (проверено в web MSX). */
export const NO_OPTIONS = { options: false } as unknown as Options;

/**
 * Опции плиток списка S5: у «Истории» — удалить тайтл и очистить всё (через подтверждение), у папки — убрать и
 * переместить в каждую другую папку из кэша списка папок (с него папку и открыли, V-31). У остальных списков опций нет.
 */
export function listTileOptions(ctx: AppContext, k: ListKey): Options | undefined {
  if (k.src === "history") {
    return opts([
      { icon: "delete", label: T.del, action: act("del", KID) },
      { icon: "delete-sweep", label: T.clear, action: chain(["back", panelAction(ctx.P, ids.panel(TAG, "clear"))]) },
    ]);
  }
  const f = k.src === "folder" ? k.folder ?? 0 : 0;
  if (f <= 0) return undefined;
  return opts([
    { icon: "delete", label: T.unfold, action: act("unfold", KID, f) },
    ...folders(ctx).filter((x) => x.id > 0 && x.id !== f).map((x) => ({ icon: "folder", label: `${T.move}${x.title}»`, action: act("move", KID, f, x.id) })),
  ]);
}

/** `panel:tile:clear` — подтверждение (как выход из KinoPub, V-34): фокус на «Отмена», «Очистить» закрывает панель. */
export function tilePanel(ctx: AppContext, args: string[]): MsxContentRoot {
  if (args.join(":") !== "clear") throw new KpError("KP-BAD", "bad panel tile");
  const p = choicePanel(ctx, T.ask, [{ label: T.yes, action: act("clear"), current: false }]);
  return { ...p, items: [...(p.items ?? []), { label: T.no, action: "back", focus: true }] };
}

/** `act:tile:<del|clear|unwatch|unfold|move>:<id>…`; ошибка KinoPub — её текст в `info:`, список не меняется. */
export async function onTileAct(ctx: AppContext, name: string, args: string[]): Promise<void> {
  const [id, from, to] = [int(args[0]), int(args[1]), int(args[2])];
  try {
    if (name === "clear") return await clearAll(ctx);
    if (name === "del" && id > 0) return await del(ctx, id);
    if (name === "unwatch" && id > 0) return await unwatch(ctx, id);
    if (name === "unfold" && id > 0 && from > 0) return await move(ctx, id, from, 0);
    if (name === "move" && id > 0 && from > 0 && to > 0 && to !== from) return await move(ctx, id, from, to);
    ctx.log.warn(TAG, "bad_args", { name, args });
  } catch (e) {
    ctx.log.warn(TAG, `${name}_failed`, { id, err: toKpError(e).code });
    ctx.host.executeAction(`info:${errorText(e).text}`);
  }
}

async function del(ctx: AppContext, id: number): Promise<void> {
  await ctx.api.historyClearItem(id);
  ctx.repo.invalidateAfterProgress(id);
  removed(ctx, HISTORY, id, T.deleted);
}

/**
 * «Я смотрю» в состояние `want` (CM-01, QA-PLAY-13): `togglewatchlist` — переключатель, его ответ — новое состояние.
 * Ответ не тот — состояние успело смениться на другом ТВ, ещё круг. Ответ потерян или непонятен (сеть, 5xx, KP-BAD) —
 * сначала список «Я смотрю»: там уже как надо — готово, иначе ещё круг. 429, вход и 404 — ответ получен, переключения не
 * было: сразу ошибка, без второго круга (QA-API-11). Не больше двух переключений.
 */
export async function setWatchlist(ctx: AppContext, id: number, want: boolean): Promise<void> {
  let last: unknown;
  for (let n = 0; n < 2; n++) {
    let on: boolean;
    try {
      on = (await ctx.api.toggleWatchlist(id, "fg")).watching;
      last = undefined;
    } catch (e) {
      if (!LOST.has(toKpError(e).code)) throw e;
      last = e;
      on = (await ctx.api.watchingSerials("fg", true)).some((w) => w.id === id);
    }
    if (on === want) return;
  }
  throw last ?? new KpError("KP-BAD", "watchlist");
}

/** Ответа на переключатель нет или он непонятен: переключение могло пройти — сверка списком. */
const LOST: ReadonlySet<string> = new Set(["KP-NET", "KP-5XX", "KP-BAD"]);

/** Сериал из «Я смотрю»: `setWatchlist` в «нет»; экран «Я смотрю» без плитки. */
async function unwatch(ctx: AppContext, id: number): Promise<void> {
  await setWatchlist(ctx, id, false);
  // Экран «Я смотрю» строится из кэша: без своей записи он перечитает список, остальное — устаревшее.
  ctx.cache.delete(cacheKeys.serials(true));
  ctx.cache.markStale(cacheKeys.serials());
  ctx.cache.markStale(cacheKeys.item(id));
  shown(ctx, "watching", "watching", ids.watching(), id, T.unwatched);
}

/** Убрать из папки (`to` = 0) или переместить: сначала `add` в другую папку, затем `remove-item` — тайтл не теряется. */
async function move(ctx: AppContext, id: number, from: number, to: number): Promise<void> {
  if (to > 0) {
    await ctx.api.bookmarkAdd(id, to);
    ctx.repo.invalidateAfterBookmark(id, to);
    forget(ctx, folderKey(to));
  }
  await ctx.api.bookmarkRemove(id, from);
  ctx.repo.invalidateAfterBookmark(id, from);
  const title = folders(ctx).find((f) => f.id === to)?.title;
  removed(ctx, folderKey(from), id, title === undefined ? T.unfolded : `${T.moved}${plain(title)}»`);
}

/**
 * «Очистить всю историю»: отдельного запроса у API нет (research kinopub-api §8.3: HipsterCat, aqualhume, Apple, webOS,
 * проба simkl-sync), поэтому — первая страница истории и `clear-for-item` каждого её тайтла, пока история не опустеет.
 * Запросы по одному через общий лимитер; тайтл, который уже чистили, второй раз не чистится — если KinoPub его оставил,
 * остановка с сообщением.
 */
async function clearAll(ctx: AppContext): Promise<void> {
  ctx.host.executeAction(`info:${T.clearing}`);
  const seen = new Set<number>();
  let left = 0;
  try {
    for (let n = 0; n < CLEAR_ROUNDS; n++) {
      const page = await ctx.api.history(1, CLEAR_PAGE);
      const fresh = [...new Set(page.map((e) => e.item.id))].filter((x) => !seen.has(x));
      left = page.length;
      if (fresh.length === 0) break;
      for (const x of fresh) {
        await ctx.api.historyClearItem(x);
        seen.add(x);
      }
    }
  } finally {
    for (const x of seen) ctx.repo.invalidateAfterProgress(x);
    forget(ctx, HISTORY);
  }
  shown(ctx, encodeListKey(HISTORY), listFlag(encodeListKey(HISTORY)), ids.list(encodeListKey(HISTORY)), 0, left > 0 ? T.partly : T.cleared);
}

/** Список больше не верен: из памяти — прочь, первая порция кэша не отдаётся (её перечитает следующий показ). */
function forget(ctx: AppContext, k: ListKey): void {
  ctx.state.lists.delete(encodeListKey(k));
  ctx.cache.delete(cacheKeys.list(source(k), 1));
}

const source = (k: ListKey): ListSource => (k.src === "folder" ? { kind: "folder", folder: k.folder ?? 0 } : { kind: "history" });

/**
 * Тайтл ушёл из списка S5: первая порция кэша не отдаётся (список, вытесненный из памяти, перечитается), в памяти —
 * без него, окно короче на плитку.
 */
function removed(ctx: AppContext, k: ListKey, id: number, text: string): void {
  const key = encodeListKey(k);
  ctx.cache.delete(cacheKeys.list(source(k), 1));
  shown(ctx, key, listFlag(key), ids.list(key), id, text);
}

/** Тайтл убран из списка `key` в памяти; текущий экран заменяется с фокусом на соседней плитке; `info:` — всегда. */
function shown(ctx: AppContext, key: string, flag: string, dataId: string, id: number, text: string): void {
  const st = ctx.state.lists.get(key) as ListEntry | undefined;
  const out: string[] = [];
  const i = st?.items.findIndex((it) => it.id === id) ?? -1;
  if (st !== undefined && i >= 0) {
    st.items.splice(i, 1);
    st.tiles?.splice(i, 1);
    if (st.to !== undefined && i < st.to) st.to -= 1;
    if (st.total !== undefined && st.total > 0) st.total -= 1;
    // Сосед — следующая плитка окна, у последней — предыдущая: плитки за окном в прежнем экране нет.
    const next = (i < (st.to ?? Infinity) ? st.items[i] : undefined) ?? st.items[i - 1];
    if (next !== undefined) out.push(focusAction(`i${next.id}`));
  }
  // Спец. §6.3: замена — только текущего экрана. Фокус ставится до замены, на соседа в прежнем экране: MSX держит фокус по `id`.
  const cur = ctx.current.isCurrent(dataId);
  ctx.host.executeAction(chain([...(cur ? [...out, replaceContent(flag, ctx.P, dataId)] : []), `info:${text}`]));
}
