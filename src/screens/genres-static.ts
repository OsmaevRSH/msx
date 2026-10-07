import type { AppContext } from "../app/context.ts";
import type { Genre } from "../api/models.ts";
import { toKpError } from "../core/errors.ts";

// Запасной справочник жанров для панели S6, если `/v1/genres` недоступен (Plan B S6). Источник — официальный
// конфиг PWA (research kinopub-api §6.4). Полный список там есть только у фильмов; сериалы и 3D в KinoPub
// используют те же жанры, а у документального, ТВ-шоу и концертов свои — их списков в источнике нет.

export const STATIC_MOVIE_GENRES: readonly Genre[] = Object.freeze([
  [25, "Аниме"], [3, "Биография"], [2, "Боевик"], [14, "Вестерн"], [116, "Водевиль"], [15, "Военный"], [13, "Детектив"],
  [24, "Документальный"], [107, "Дорама"], [9, "Драма"], [18, "Исторический"], [1, "Комедия"], [26, "Короткометражка"],
  [17, "Криминал"], [10, "Мелодрама"], [11, "Мистика"], [19, "Музыкальный"], [23, "Мультфильм"], [105, "Нуар"],
  [8, "Приключения"], [6, "Семейный"], [27, "Спектакль"], [20, "Спорт"], [101, "Стендап"], [7, "Триллер"], [12, "Ужасы"],
  [4, "Фантастика"], [5, "Фэнтези"], [128, "Эксклюзив"], [21, "Эротика"],
].map(([id, title]) => Object.freeze({ id: id as number, title: title as string })));

/** Типы, у которых жанры — как у фильмов; пустой тип — весь каталог. 3D меню пишет `3d` (как PWA и Kodi). */
const MOVIE_LIKE: ReadonlySet<string> = new Set(["", "movie", "serial", "3d"]);

/** Встроенные жанры для типа ключа списка (первый из `a,b`); для остальных типов — пусто. */
export function staticGenres(type: string): Genre[] {
  const first = (type.split(",")[0] ?? "").toLowerCase();
  return MOVIE_LIKE.has(first) ? STATIC_MOVIE_GENRES.map((g) => ({ ...g })) : [];
}

/** Plan B S6: справочник KinoPub (кэш 24 ч), при недоступности или пустом ответе — встроенный список. */
export async function genresOrStatic(ctx: AppContext, type: string): Promise<Genre[]> {
  try {
    const list = (await ctx.repo.genres(type)).value;
    return list.length > 0 ? list : staticGenres(type);
  } catch (e) {
    const fallback = staticGenres(type);
    ctx.log.info("panels", "genres_static", { type, err: toKpError(e).code, n: fallback.length });
    if (fallback.length === 0) throw e;
    return fallback;
  }
}
