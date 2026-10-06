import type { AppContext } from "../app/context.ts";
import { fmtCount } from "../core/format.ts";
import { chain, panelAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { ids } from "../router/ids.ts";
import type { ListKey } from "../router/ids.ts";

// Шапка списка S5: заголовок, `extension` и опции красной кнопки (Plan B S6). Экран, открытый из меню, MSX подписывает
// пунктом меню вместо `headline`, а `extension` не трогает: сортировка, жанр и число найденного — там (V-09, V-11).

export const DEFAULT_SORT = "-updated";
/** Подборки — по умолчанию новые, как «Последние» у Kodi и «Новые» у других клиентов (research kinopub-api §6.1). */
export const COLLECTION_SORT = "-created";
/**
 * Разделы меню, заданные жанром (research kinopub-api §6.4, конфиг PWA): «Мультфильмы» — 23, «Аниме» — 25, «Стендап» —
 * 101. Список с таким жанром называется разделом, название жанра не запрашивается.
 */
export const SECTION_GENRES: Readonly<Record<string, string>> = { 23: "Мультфильмы", 25: "Аниме", 101: "Стендап" };
/** «4K» в меню — каталог с качеством «не ниже 4K» (`quality=4`, research kinopub-api §6.1). */
export const UHD_QUALITY = "4";

const T = {
  catalog: "Каталог",
  uhd: "4K",
  bookmarks: "Закладки",
  similar: "Похожие",
  history: "История",
  collections: "Подборки",
  collection: "Подборка",
  sortGenre: "Сортировка и жанр",
  sort: "Сортировка",
  genre: "Жанр",
  allGenres: "все жанры",
  allGenresHead: "Все жанры",
  options: "{ico:msx-red:stop}",
  offline: "{ico:msx-yellow:history} нет связи",
};

export const SORTS: { id: string; title: string }[] = [
  { id: "-updated", title: "Обновлённые" },
  { id: "-created", title: "Новые на сайте" },
  { id: "-kinopoisk_rating", title: "Рейтинг КП" },
  { id: "-imdb_rating", title: "IMDb" },
  { id: "-views", title: "Популярные" },
  { id: "-year", title: "Год" },
];
/** Сортировки подборок — как вкладки Kodi: «Последние», «Горячие» (`watchers`), «Популярные» (`views`). */
export const COLLECTION_SORTS: { id: string; title: string }[] = [
  { id: COLLECTION_SORT, title: "Новые" },
  { id: "-watchers", title: "Горячие" },
  { id: "-views", title: "Популярные" },
];

const TYPE_TITLES: Readonly<Record<string, string>> = {
  movie: "Фильмы",
  serial: "Сериалы",
  "movie,serial": "Фильмы и сериалы",
  "documovie,docuserial": "Документальное",
  documovie: "Документальные фильмы",
  docuserial: "Документальные сериалы",
  tvshow: "ТВ-шоу",
  concert: "Концерты",
  "3D": "3D",
  "3d": "3D",
};

type Shelf = "fresh" | "popular" | "hot";
const SHELF_TITLES: Readonly<Record<Shelf, string>> = { fresh: "Новинки", popular: "Популярное", hot: "Горячее" };
/** Полки главной (V-08): список «Показать все» называется так же, как полка. */
const SHELF_NAMES: Readonly<Record<Shelf, Readonly<Record<string, string>>>> = {
  fresh: { movie: "Новые фильмы", serial: "Новые сериалы" },
  popular: { movie: "Популярные фильмы", serial: "Популярные сериалы" },
  hot: { movie: "Горячее: фильмы", serial: "Горячее: сериалы" },
};

type Forms = readonly [string, string, string];
export const FILMS: Forms = ["фильм", "фильма", "фильмов"];
export const SERIALS: Forms = ["сериал", "сериала", "сериалов"];
const PCS: Forms = ["шт.", "шт.", "шт."];
/** Чего «1 234» в `extension`; смешанные разделы и папки — «шт.», как у плиток папок. */
const NOUNS: Readonly<Record<string, Forms>> = {
  movie: FILMS, documovie: FILMS, "3D": FILMS, "3d": FILMS, serial: SERIALS, docuserial: SERIALS,
  concert: ["концерт", "концерта", "концертов"], tvshow: ["шоу", "шоу", "шоу"],
};
const COLLECTIONS: Forms = ["подборка", "подборки", "подборок"];

/** Раздел меню, заданный жанром (`SECTION_GENRES`); иначе `undefined`. */
export const sectionGenre = (genre: string | undefined): string | undefined =>
  genre !== undefined && Object.prototype.hasOwnProperty.call(SECTION_GENRES, genre) ? SECTION_GENRES[genre] : undefined;

const section = (k: ListKey): string =>
  sectionGenre(k.genre) ?? (k.quality === UHD_QUALITY ? T.uhd : TYPE_TITLES[k.type ?? ""] ?? T.catalog);

const sortsOf = (k: ListKey): { id: string; title: string }[] => (k.src === "collections" ? COLLECTION_SORTS : SORTS);
const sortOf = (k: ListKey): { id: string; title: string } | undefined =>
  sortsOf(k).find((s) => s.id === (k.sort || (k.src === "collections" ? COLLECTION_SORT : DEFAULT_SORT)));

/**
 * Полка главной и её список «Показать все»: «Новые фильмы», «Горячее: сериалы»; другие типы — «Новинки · Концерты»;
 * без типа — пункт меню: «Новинки», «Популярное», «Горячее».
 */
export function shelfTitle(src: Shelf, type?: string): string {
  if (!type) return SHELF_TITLES[src];
  return SHELF_NAMES[src][type] ?? `${SHELF_TITLES[src]} · ${section({ src, type })}`;
}

/**
 * «Фильмы · Обновлённые», «Новые фильмы», «Закладки», «Похожие», «Подборки · Новые». Название жанра, папки и подборки
 * добавляет экран.
 */
export function listTitle(k: ListKey): string {
  switch (k.src) {
    case "catalog":
    case "collections": {
      const sort = sortOf(k);
      const head = k.src === "catalog" ? section(k) : T.collections;
      return sort === undefined ? head : `${head} · ${sort.title}`;
    }
    case "fresh":
    case "popular":
    case "hot":
      return shelfTitle(k.src, k.type);
    case "folder":
      return T.bookmarks;
    case "similar":
      return T.similar;
    case "history":
      return T.history;
    case "collection":
      return T.collection;
  }
}

/** Красная кнопка: у каталога — сортировка и жанр, у полок — жанр, у подборок — сортировка; у остальных её нет. */
const filtered = (k: ListKey): boolean => ["catalog", "fresh", "popular", "hot", "collections"].includes(k.src);
const sorted = (k: ListKey): boolean => k.src === "catalog" || k.src === "collections";

/** Выбранный жанр: название из справочника, раздел меню у его жанра («Мультфильмы»); без жанра — `undefined`. */
function genreOf(k: ListKey, genre: string | undefined): string | undefined {
  if (!k.genre) return undefined;
  return sectionGenre(k.genre) ?? genre ?? T.genre;
}

/** Что шапка знает о списке: название жанра, всего найдено (`pagination`) и ответ из кэша без сети. */
export interface ListHead { genre?: string; total?: number; offline?: boolean }

/** «{■} Рейтинг КП · Драма · 1 234 фильма», «{■} Все жанры · 48 фильмов», «2 шт.» у папки. */
export function listExtension(k: ListKey, h: ListHead): string | undefined {
  const parts: string[] = [];
  if (sorted(k)) parts.push(sortOf(k)?.title ?? "");
  const genre = genreOf(k, h.genre);
  if (genre !== undefined) parts.push(genre);
  else if (filtered(k) && !sorted(k)) parts.push(T.allGenresHead);
  // У «Похожих» одна порция без настоящей `pagination`, а в «Истории» `total_items` считает просмотры серий, а не тайтлы.
  if (h.total !== undefined && h.total > 0 && k.src !== "similar" && k.src !== "history") {
    parts.push(fmtCount(h.total, k.src === "collections" ? COLLECTIONS : NOUNS[k.type ?? ""] ?? PCS));
  }
  const text = parts.filter((s) => s !== "").join(" · ");
  const out = [filtered(k) ? `${T.options} ${text}` : text, h.offline === true ? T.offline : ""].filter((s) => s !== "");
  return out.length > 0 ? out.join("  ") : undefined;
}

/**
 * Красная кнопка (Plan B S6, V-12): в пунктах — текущие значения; пункт сначала закрывает опции (`back`), а выбор в
 * панели сортировки или жанра закрывает и её — после выбора над списком не остаётся панелей. У полок KinoPub нет
 * параметра сортировки — только жанр.
 */
export function filterOptions(ctx: AppContext, key: string, k: ListKey, genre: string | undefined): MsxContentRoot | undefined {
  if (!filtered(k)) return undefined;
  const items: MsxContentItem[] = [];
  const open = (type: string): string => chain(["back", panelAction(ctx.P, ids.panel(type, key))]);
  if (sorted(k)) items.push({ id: "o_sort", icon: "sort", label: `${T.sort}: ${sortOf(k)?.title ?? ""}`, action: open("sort") });
  if (k.src !== "collections") items.push({ id: "o_genre", icon: "category", label: `${T.genre}: ${genreOf(k, genre) ?? T.allGenres}`, action: open("genre") });
  const headline = k.src === "catalog" ? T.sortGenre : k.src === "collections" ? T.sort : T.genre;
  return { headline, template: { type: "control", layout: "0,0,8,1" }, items };
}

/** Сортировки панели S6 для ключа списка и текущая. */
export function sortChoices(k: ListKey): { sorts: { id: string; title: string }[]; cur: string | undefined } {
  return { sorts: sortsOf(k), cur: sortOf(k)?.id };
}
