import type { AppContext } from "../app/context.ts";
import type { ItemSummary } from "../api/models.ts";
import { ruTitle } from "../core/format.ts";
import { commitMsg, contentAction } from "../msx/actions.ts";
import type { MsxContentItem } from "../msx/types.ts";
import type { Prefs } from "../playback/prefs.ts";
import { ids, msgs } from "../router/ids.ts";

// Плитки постеров для сеток (Plan B §8.3 S5, §8.1): общее — в `template`, в элементе только данные тайтла.
// Прогресс на сетках каталога, поиска и похожих не показывается — без N+1 запросов данных нет (Plan B §8.4).

const UHD = 2160;
const T = { kp: "КП", uhd: "4K" };

type PosterSize = Prefs["posterSize"];

/** 7.912 → "7,9"; 0 и отсутствие — пусто. */
function rating(r: number | undefined): string | undefined {
  return r !== undefined && r > 0 ? r.toFixed(1).replace(".", ",") : undefined;
}

function tile(ctx: AppContext, it: ItemSummary, size: PosterSize): MsxContentItem {
  const out: MsxContentItem = { id: `i${it.id}`, kid: it.id, title: ruTitle(it.title) };
  const kp = rating(it.kpRating);
  const footer = [it.year !== undefined ? String(it.year) : undefined, kp !== undefined ? `${T.kp} ${kp}` : undefined]
    .filter((s): s is string => s !== undefined)
    .join(" · ");
  if (footer !== "") out.titleFooter = footer;
  out.image = it.posters[size] || it.posters.medium;
  if (it.quality >= UHD) out.badge = T.uhd;
  out.action = contentAction(ctx.P, ids.item(it.id));
  return out;
}

/** `kid` — числовой id тайтла для `{context:kid}` в `selection` шаблона (CD-10). */
export function posterTile(ctx: AppContext, it: ItemSummary): MsxContentItem {
  return tile(ctx, it, ctx.prefs.get().posterSize);
}

/** Плитки сетки: настройки читаются один раз на экран, а не на каждую плитку. */
export function posterTiles(ctx: AppContext, items: readonly ItemSummary[]): MsxContentItem[] {
  const size = ctx.prefs.get().posterSize;
  return items.map((it) => tile(ctx, it, size));
}

/**
 * Шаблон сетки постеров. `selection` — префетч карточки по фокусу сообщением в плагин (спец. §8.3, CD-10);
 * `{context:kid}` в `template.selection` MSX раскрывает полем `kid` элемента (msx-platform §2.1).
 */
export function gridTemplate(ctx: AppContext, layout: string): MsxContentItem {
  const tpl: MsxContentItem = { type: "separate", layout, color: "msx-glass", imageFiller: "cover", round: true };
  if (ctx.flags.get().focusPrefetch === "on") tpl.selection = { action: commitMsg(msgs.pf("{context:kid}")) };
  return tpl;
}
