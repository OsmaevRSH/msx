import type { AppContext } from "../app/context.ts";
import { fmtCount } from "../core/format.ts";
import { chain, panelAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { ids } from "../router/ids.ts";
import type { ListKey } from "../router/ids.ts";

// Шапка списка S5: заголовок, `extension` и опции красной кнопки (Plan B S6). Экран, открытый из меню, MSX подписывает
// пунктом меню вместо `headline`, а `extension` не трогает: сортировка, жанр и число найденного — там (V-09, V-11).

export const DEFAULT_SORT = "-updated";
/** «Мультфильмы» в меню — жанр 23 (research kinopub-api §6.4). */
export const CARTOONS_GENRE = "23";

const T = {
  catalog: "Каталог",
  cartoons: "Мультфильмы",
  bookmarks: "Закладки",
  similar: "Похожие",
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
};

type Shelf = "fresh" | "popular" | "hot";
const SHELF_TITLES: Readonly<Record<Shelf, string>> = { fresh: "Новинки", popular: "Популярное", hot: "Горячее" };
/** Полки главной (V-08): список «Ещё →» называется так же, как полка. */
const SHELF_NAMES: Readonly<Record<Shelf, Readonly<Record<string, string>>>> = {
  fresh: { movie: "Новые фильмы", serial: "Новые сериалы" },
  popular: { movie: "Популярные фильмы", serial: "Популярные сериалы" },
  hot: { movie: "Горячее: фильмы", serial: "Горячее: сериалы" },
};

type Forms = readonly [string, string, string];
const FILMS: Forms = ["фильм", "фильма", "фильмов"];
const SERIALS: Forms = ["сериал", "сериала", "сериалов"];
const PCS: Forms = ["шт.", "шт.", "шт."];
/** Чего «1 234» в `extension`; смешанные разделы и папки — «шт.», как у плиток папок. */
const NOUNS: Readonly<Record<string, Forms>> = {
  movie: FILMS, documovie: FILMS, "3D": FILMS, serial: SERIALS, docuserial: SERIALS,
  concert: ["концерт", "концерта", "концертов"], tvshow: ["шоу", "шоу", "шоу"],
};

const section = (k: ListKey): string =>
  k.genre === CARTOONS_GENRE ? T.cartoons : TYPE_TITLES[k.type ?? ""] ?? T.catalog;

const sortOf = (k: ListKey): { id: string; title: string } | undefined => SORTS.find((s) => s.id === (k.sort || DEFAULT_SORT));

/** Полка главной и её список «Ещё →»: «Новые фильмы», «Горячее: сериалы»; другие типы — «Новинки · Концерты». */
export function shelfTitle(src: Shelf, type?: string): string {
  return SHELF_NAMES[src][type ?? ""] ?? `${SHELF_TITLES[src]} · ${section({ src, type })}`;
}

/** «Фильмы · Обновлённые», «Новые фильмы», «Закладки», «Похожие». Название жанра и папки добавляет экран. */
export function listTitle(k: ListKey): string {
  switch (k.src) {
    case "catalog": {
      const sort = sortOf(k);
      return sort === undefined ? section(k) : `${section(k)} · ${sort.title}`;
    }
    case "fresh":
    case "popular":
    case "hot":
      return shelfTitle(k.src, k.type);
    case "folder":
      return T.bookmarks;
    case "similar":
      return T.similar;
  }
}

const filtered = (k: ListKey): boolean => k.src !== "folder" && k.src !== "similar";

/** Выбранный жанр: название из справочника, «Мультфильмы» у раздела; без жанра — `undefined`. */
function genreOf(k: ListKey, genre: string | undefined): string | undefined {
  if (!k.genre) return undefined;
  return k.genre === CARTOONS_GENRE ? T.cartoons : genre ?? T.genre;
}

/** Что шапка знает о списке: название жанра, всего найдено (`pagination`) и ответ из кэша без сети. */
export interface ListHead { genre?: string; total?: number; offline?: boolean }

/** «{■} Рейтинг КП · Драма · 1 234 фильма», «{■} Все жанры · 48 фильмов», «2 шт.» у папки. */
export function listExtension(k: ListKey, h: ListHead): string | undefined {
  const parts: string[] = [];
  if (k.src === "catalog") parts.push(sortOf(k)?.title ?? "");
  const genre = genreOf(k, h.genre);
  if (genre !== undefined) parts.push(genre);
  else if (filtered(k) && k.src !== "catalog") parts.push(T.allGenresHead);
  // У «Похожих» одна порция без настоящей `pagination` — число там ничего не говорит.
  if (h.total !== undefined && h.total > 0 && k.src !== "similar") parts.push(fmtCount(h.total, NOUNS[k.type ?? ""] ?? PCS));
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
  if (k.src === "catalog") items.push({ id: "o_sort", icon: "sort", label: `${T.sort}: ${sortOf(k)?.title ?? ""}`, action: open("sort") });
  items.push({ id: "o_genre", icon: "category", label: `${T.genre}: ${genreOf(k, genre) ?? T.allGenres}`, action: open("genre") });
  return { headline: k.src === "catalog" ? T.sortGenre : T.genre, template: { type: "control", layout: "0,0,8,1" }, items };
}
