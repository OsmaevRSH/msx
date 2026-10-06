import type { AppContext } from "../app/context.ts";
import { toKpError } from "../core/errors.ts";
import { contentAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { encodeListKey, ids } from "../router/ids.ts";
import { errorScreen } from "./error.ts";

// S11 (Plan B S11): плитки папок 4×2 в сетке 16×8; папка открывается списком S5 (`list.ts`: порции, окно, догрузка).
// Убрать фильм из папки — панель закладок карточки (S10); после неё `Repo` сбрасывает кэш папок.
// Значок закладки — в `headline` плитки: `icon` шаблона MSX рисует поверх названия (V-30).

const T = {
  headline: "Закладки",
  pcs: "шт.",
  offline: "нет связи",
  folder: "{ico:bookmark}",
  empty: "Здесь появятся папки с закладками. Добавьте фильм кнопкой ☆ на карточке",
  find: "{ico:search} Найти фильм",
};

export async function bookmarksScreen(ctx: AppContext): Promise<MsxContentRoot> {
  let got;
  try {
    got = await ctx.repo.bookmarkFolders();
  } catch (e) {
    ctx.log.warn("bookmarks", "failed", { err: toKpError(e).code });
    return errorScreen(ctx, e, ids.bookmarks());
  }
  const root: MsxContentRoot = { type: "list", compress: true, cache: false, reuse: false, headline: T.headline };
  if (got.offline !== undefined) root.extension = `{ico:msx-yellow:history} ${T.offline}`;
  const items = got.value.filter((f) => f.id > 0).map((f): MsxContentItem => ({
    headline: `${T.folder} ${f.title}`, text: `${f.count} ${T.pcs}`,
    action: contentAction(ctx.P, ids.list(encodeListKey({ src: "folder", folder: f.id }))),
  }));
  if (items.length > 0) {
    // Счётчик MSX «(1/1)» ничего не добавляет к плиткам папок (V-11).
    root.template = { layout: "0,0,4,2", color: "msx-glass", enumerate: false };
    root.items = items;
    return root;
  }
  // V-32: элементы корня MSX раскладывает по `template.layout` (кнопка растягивалась на 16×2) — страница со своими
  // `layout`. На экране из меню «Назад» бесполезна: вместо неё — поиск.
  root.pages = [{
    items: [
      { type: "space", layout: "0,0,16,2", text: T.empty },
      { type: "button", layout: "0,2,4,1", label: T.find, action: contentAction(ctx.P, ids.search()) },
    ],
  }];
  return root;
}
