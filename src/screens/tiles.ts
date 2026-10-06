import type { AppContext } from "../app/context.ts";
import type { ItemSummary, Posters } from "../api/models.ts";
import { fmtRating, ruTitle } from "../core/format.ts";
import { commitMsg, contentAction } from "../msx/actions.ts";
import type { Grid } from "../msx/edges.ts";
import type { MsxContentItem } from "../msx/types.ts";
import type { Prefs } from "../playback/prefs.ts";
import { ids, msgs } from "../router/ids.ts";

// Крупные плитки постеров — одни на главной S4, в списках S5 (и папках закладок S11) и в поиске S7 (спец. §11).
// Сетка 12×6 без `compress`, плитка 2×4: 6 плиток в ряд при 1080p. Тип `default` с обёрткой картинки (`imageHeight`):
// постер 264×396 px — ровно 2:3, как постеры KinoPub (`medium` 250×375), поэтому `cover` не обрезает и не растягивает.
// Под постером 156 px подписи: название белым в две строки (`titleHeader`, строки обрезаются с «…») и серым год
// и рейтинг КП (`titleFooter`). `imageBoundary` держит бейдж, тег, штамп и прогресс на постере — они не наезжают на
// название. Ряд — одна страница MSX высотой 4 (лента `list` складывает страницы по высоте содержимого), на экране —
// ряд и верх следующего. Полное название плитки в фокусе — в шапке (`selection.headline`, Р-36).

/** Сетка плиток: страница 12×6, плитка 2×4. */
export const GRID: Grid = { width: 12, height: 6, w: 2, h: 4, poster: true };
/** Та же сетка плиток внутри сжатого корня 16×8 (`decompress`): свои элементы вставок — в единицах корня. */
export const GRID_DECOMPRESSED: Grid = { ...GRID, scale: 16 / 12 };
/** Плиток в ряду. */
export const ROW = 6;
const LAYOUT = `0,0,${GRID.w},${GRID.h}`;
/** Высота постера в единицах: 2,75 × 144 px = 396 px при ширине 264 px (2:3). */
const POSTER_H = 2.75;
/** В сжатом корне (поиск: клавиатура 16×8) единица — 108 px: те же 396 px — это 3,67 (`decompress`). */
const POSTER_H_COMPRESSED = 3.67;
/** Знаков в строке названия, которые помещаются без «…» (ширина текста 216 px, проверено в web MSX 0.1.167). */
const LINE = 12;
const UHD = 2160;
const T = { uhd: "4K", white: "{col:msx-white}", br: "{br}" };

type PosterSize = Prefs["posterSize"];

/** Что плитка знает о тайтле: элемент списка, запись «Продолжить» или истории. */
export type TileSource = Pick<ItemSummary, "id" | "title" | "posters"> & Partial<Pick<ItemSummary, "year" | "kpRating" | "quality">>;

/** Вид плитки постера; у плиток шаблона — в `template`, у главной — в каждой плитке. */
export const TILE_STYLE: Readonly<MsxContentItem> = {
  color: "msx-glass", imageHeight: POSTER_H, imageFiller: "cover", imageBoundary: true, round: true,
  truncation: "titleHeader",
};

/** Хосты разработки: mock и стенды отдают картинки по http, их схему не трогаем. */
const DEV_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|[^/:]+\.localhost|[^/:]+\.test)(?::\d+)?$/i;
const ABSOLUTE = /^(?:(https?):)?\/\/([^/?#\s]+)([^?#\s]*)/i;

/**
 * Адрес постера — один и тот же на всех экранах (главная, «Продолжить», список, поиск, закладки), чтобы ТВ брал картинку
 * из HTTP-кэша, а не скачивал заново: размер из настройки «Размер постеров» (по умолчанию `medium` 250×375 — плитке
 * 264×396 px нужен он: `small` мылит, `big` 500×750 вчетверо тяжелее для декодера ТВ). Адрес нормализуется: схема
 * `https` (кроме хостов разработки), без query и `#` — одна картинка не кэшируется под разными адресами.
 */
export function posterUrl(p: Posters, size: PosterSize): string {
  const raw = (p[size] || p.medium || "").trim();
  const m = ABSOLUTE.exec(raw);
  if (m === null) return raw;
  const host = m[2] as string;
  const scheme = m[1]?.toLowerCase() === "http" && DEV_HOST.test(host) ? "http" : "https";
  return `${scheme}://${host}${m[3] ?? ""}`;
}

/** Первая строка названия и её продолжение: до последней границы слова в пределах строки (`LINE`). */
function split(name: string): [string, string] {
  if (name.length <= LINE) return [name, ""];
  const cut = name.lastIndexOf(" ", LINE);
  const at = cut > 0 ? cut : name.indexOf(" ");
  return at <= 0 ? [name, ""] : [name.slice(0, at), name.slice(at + 1).trim()];
}

/**
 * Название белым в две строки для `titleHeader`: всегда две, чтобы названия в ряду начинались на одной высоте (пустая
 * вторая — пробел). Строку, что не влезла, MSX обрезает с «…» (`truncation`).
 */
export function titleLines(name: string): string {
  const [first, rest] = split(name);
  return `${T.white}${first}${T.br}${rest === "" ? " " : rest}`;
}

/**
 * «2001 · 7,9» (год и рейтинг КП) — серая строка под названием; пустые части пропускаются. Без «КП»: строка есть у
 * каждой из 96 плиток окна, а ответ ограничен 32 КБ.
 */
export function yearRating(year: number | undefined, rating: number | undefined): string {
  return [year !== undefined && year > 0 ? String(year) : "", fmtRating(rating)].filter((s) => s !== "").join(" · ");
}

/** Данные плитки тайтла, общие для шаблона и главной: подписи, постер, 4K, переход на карточку. */
function titleData(ctx: AppContext, it: TileSource, size: PosterSize): MsxContentItem {
  const out: MsxContentItem = { titleHeader: titleLines(ruTitle(it.title)) };
  const meta = yearRating(it.year, it.kpRating);
  if (meta !== "") out.titleFooter = meta;
  out.image = posterUrl(it.posters, size);
  if ((it.quality ?? 0) >= UHD) out.badge = T.uhd;
  out.action = contentAction(ctx.P, ids.item(it.id));
  return out;
}

/**
 * Плитки сетки шаблона; настройки читаются один раз на экран. `kid` — id тайтла строкой для `{context:kid}`, `kt` —
 * полное название для шапки `{context:kt}`: нестроковое поле MSX подставляет пустой строкой (CD-10, Р-36). Имена полей
 * короткие: их 96 в каждом ответе списка, а предел — 32 КБ.
 */
export function posterTiles(ctx: AppContext, items: readonly ItemSummary[]): MsxContentItem[] {
  const size = ctx.prefs.get().posterSize;
  return items.map((it) => ({ id: `i${it.id}`, kid: String(it.id), kt: ruTitle(it.title), ...titleData(ctx, it, size) }));
}

/** Одна плитка шаблона. */
export function posterTile(ctx: AppContext, it: ItemSummary): MsxContentItem {
  return posterTiles(ctx, [it])[0] as MsxContentItem;
}

/**
 * Шаблон сетки постеров. `selection` — полное название в шапке и префетч карточки по фокусу сообщением в плагин
 * (спец. §8.3, CD-10); `{context:…}` в `template.selection` MSX раскрывает полем элемента (msx-platform §2.1).
 * `enumerate: false` убирает счётчик MSX «(57/96)»: он считает плитки окна (V-11). `compressed` — корень сжат (16×8):
 * плитки остаются в сетке 12×6 и с полным шрифтом (`decompress`, `compress: false`), высота постера — в единицах 108 px.
 */
export function gridTemplate(ctx: AppContext, compressed = false): MsxContentItem {
  const selection: NonNullable<MsxContentItem["selection"]> = { headline: "{context:kt}" };
  if (ctx.flags.get().focusPrefetch === "on") selection.action = commitMsg(msgs.pf("{context:kid}"));
  const t: MsxContentItem = { ...TILE_STYLE, layout: LAYOUT, enumerate: false, selection };
  return compressed ? { ...t, imageHeight: POSTER_H_COMPRESSED, decompress: true, compress: false } : t;
}

/**
 * Плитка тайтла с полным видом — для страниц главной, где шаблон корня не действует: стиль, данные, полное название в
 * шапке и префетч по фокусу (в `pages` нет `{context:…}`, поэтому id — явно).
 */
export function shelfTile(ctx: AppContext, it: TileSource, size: PosterSize): MsxContentItem {
  const selection: NonNullable<MsxContentItem["selection"]> = { headline: ruTitle(it.title) };
  if (ctx.flags.get().focusPrefetch === "on") selection.action = commitMsg(msgs.pf(it.id));
  return { ...TILE_STYLE, ...titleData(ctx, it, size), selection };
}

/**
 * `preload: "next"` корня сетки (переключатель `gridPreload`): MSX заранее строит следующую страницу ленты, и постеры
 * при листании появляются за ~0,3 с вместо ~1 с (`vibe/image-cache-research.md`, R3). Цена — ряд картинок наперёд.
 */
export function gridPreload(ctx: AppContext): { preload?: "next" } {
  return ctx.flags.get().gridPreload === "next" ? { preload: "next" } : {};
}

/**
 * Плитка того же размера без постера (папка закладок, «Показать все»): крупный значок на месте постера, подпись — как у
 * тайтлов. Без `imageHeight`: значок встаёт по центру плитки.
 */
export function iconTile(icon: string, name: string, footer: string | undefined, action: string): MsxContentItem {
  const out: MsxContentItem = {
    type: "default", color: "msx-glass", round: true, truncation: "titleHeader|titleFooter", icon, iconSize: "large", titleHeader: titleLines(name),
  };
  if (footer !== undefined && footer !== "") out.titleFooter = footer;
  out.action = action;
  return out;
}
