import type { AppContext } from "../app/context.ts";
import type { ItemSummary } from "../api/models.ts";
import { fmtRating, ruTitle } from "../core/format.ts";
import { commitMsg, contentAction } from "../msx/actions.ts";
import type { MsxContentItem } from "../msx/types.ts";
import type { Prefs } from "../playback/prefs.ts";
import { ids, msgs } from "../router/ids.ts";

// Плитки постеров для сеток (Plan B §8.3 S5, §8.1): общее — в `template`, в элементе только данные тайтла.
// Прогресс на сетках каталога, поиска и похожих не показывается — без N+1 запросов данных нет (Plan B §8.4).
// Название — в две строки под постером, год и рейтинг КП — `stamp` на постере (V-10): `separate` выводит только
// `title` и `titleFooter`, а одна строка вмещает ~12 знаков. Полное название плитки в фокусе MSX пишет в шапке рядом
// с заголовком экрана: `template.selection.headline` — первая строка `title` и её продолжение `ktail` (Р-36).

const UHD = 2160;
/** Знаков в строке подписи плитки шириной 2 колонки (16×8), которые MSX выводит без «…» (визуальная проверка V-10). */
const LINE = 12;
const T = { uhd: "4K", white: "{col:msx-white}" };

type PosterSize = Prefs["posterSize"];

/** Первая строка названия и её продолжение: до последней границы слова в пределах строки (`LINE`). */
function split(name: string): [string, string] {
  if (name.length <= LINE) return [name, ""];
  const cut = name.lastIndexOf(" ", LINE);
  const at = cut > 0 ? cut : name.indexOf(" ");
  return at <= 0 ? [name, ""] : [name.slice(0, at), name.slice(at + 1).trim()];
}

/**
 * Название в две строки: `title` — первая строка, продолжение — белым `titleFooter` (серый цвет подписи MSX
 * читается как год). Что не влезло во вторую строку, MSX обрезает с «…».
 */
export function titleLines(name: string): { title: string; titleFooter?: string } {
  return lines(...split(name));
}

const lines = (title: string, tail: string): { title: string; titleFooter?: string } =>
  tail === "" ? { title } : { title, titleFooter: `${T.white}${tail}` };

/** «2001 · 7,9» для `stamp`: «КП» не помещается — MSX режет `stamp` после ~10 знаков. */
function yearRating(it: ItemSummary): string {
  return [it.year !== undefined ? String(it.year) : "", fmtRating(it.kpRating)].filter((s) => s !== "").join(" · ");
}

function tile(ctx: AppContext, it: ItemSummary, size: PosterSize): MsxContentItem {
  const [title, tail] = split(ruTitle(it.title));
  const out: MsxContentItem = { id: `i${it.id}`, kid: String(it.id), ktail: tail, ...lines(title, tail) };
  const stamp = yearRating(it);
  if (stamp !== "") out.stamp = stamp;
  out.image = it.posters[size] || it.posters.medium;
  if (it.quality >= UHD) out.badge = T.uhd;
  out.action = contentAction(ctx.P, ids.item(it.id));
  return out;
}

/**
 * `kid` — id тайтла строкой для `{context:kid}`, `ktail` — продолжение названия после первой строки (или пустая
 * строка) для `{context:ktail}`: нестроковое поле MSX подставляет пустой строкой (CD-10, Р-36).
 */
export function posterTile(ctx: AppContext, it: ItemSummary): MsxContentItem {
  return tile(ctx, it, ctx.prefs.get().posterSize);
}

/** Плитки сетки: настройки читаются один раз на экран, а не на каждую плитку. */
export function posterTiles(ctx: AppContext, items: readonly ItemSummary[]): MsxContentItem[] {
  const size = ctx.prefs.get().posterSize;
  return items.map((it) => tile(ctx, it, size));
}

/**
 * Шаблон сетки постеров. `selection` — полное название в шапке (V-10) и префетч карточки по фокусу сообщением
 * в плагин (спец. §8.3, CD-10); `{context:…}` в `template.selection` MSX раскрывает полем элемента (msx-platform §2.1,
 * проверено в web MSX 0.1.167). `enumerate: false` убирает счётчик MSX «(57/96)»: он считает плитки окна (V-11).
 */
export function gridTemplate(ctx: AppContext, layout: string): MsxContentItem {
  const selection: NonNullable<MsxContentItem["selection"]> = { headline: "{context:title} {context:ktail}" };
  if (ctx.flags.get().focusPrefetch === "on") selection.action = commitMsg(msgs.pf("{context:kid}"));
  return { type: "separate", layout, color: "msx-glass", imageFiller: "cover", round: true, enumerate: false, selection };
}
