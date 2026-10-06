import type { AppContext } from "../app/context.ts";
import type { LogoutReason } from "../auth/auth-service.ts";
import { KpError } from "../core/errors.ts";
import { replaceMenu, req } from "../msx/actions.ts";
import type { MsxMenuItem, MsxMenuRoot } from "../msx/types.ts";
import { encodeListKey, ids } from "../router/ids.ts";
import { errorText } from "./error.ts";

// Меню S3 (спец. §7.1, §11; Plan B §8.3 S3). Строится без сети и без ожидания (CNFR-03).

const HEADLINE = "KinoPub";
const EXTENSION = "{ico:msx-white:access-time} {now:time:hh:mm}";
const DICTIONARY = "http://msx.benzac.de/dic/ru.json";
const CATALOG_SORT = "-updated";
/** Флаг меню для `replace:menu:…` (Replace Action MSX 0.1.144). */
export const MENU_FLAG = "menu";

const T = {
  login: "Вход",
  home: "Главная",
  search: "Поиск",
  catalog: "Каталог",
  bookmarks: "Закладки",
  settings: "Просмотр и аккаунт",
  probe: "Диагностика",
  msxSettings: "Настройки MSX",
  bye: "Вы вышли из KinoPub",
};

/** Разделы каталога как в официальном приложении; «Мультфильмы» — жанр 23 (research kinopub-api §6.4). */
const SECTIONS: readonly { id: string; label: string; icon: string; type: string; genre?: string }[] = [
  { id: "movies", label: "Фильмы", icon: "movie", type: "movie" },
  { id: "serials", label: "Сериалы", icon: "tv", type: "serial" },
  { id: "cartoons", label: "Мультфильмы", icon: "child-care", type: "movie,serial", genre: "23" },
  { id: "docs", label: "Документальное", icon: "public", type: "documovie,docuserial" },
  { id: "tvshows", label: "ТВ-шоу", icon: "live-tv", type: "tvshow" },
  { id: "concerts", label: "Концерты", icon: "music-note", type: "concert" },
];

/**
 * Перерисовать меню после входа и выхода. Меню загружено из start parameter, а такое MSX по `reload:menu` не
 * перезапрашивает (найдено smoke-e2e в web MSX, этап 27); `replace:menu` перезапрашивает и при `cache: true`.
 */
export function refreshMenu(P: string): string {
  return replaceMenu(MENU_FLAG, P, ids.init());
}

/**
 * Выход и потеря сессии (V-39): гостевое меню и причина уведомлением; отказ refresh — текстом `KP-AUTH`. Меню MSX
 * перерисует, только если открыт корневой экран: на вложенном `replace:menu` не выполняется (X-3).
 */
export function loggedOutActions(P: string, reason: LogoutReason): string[] {
  const why = reason === "logout" ? T.bye : errorText(new KpError("KP-AUTH", reason)).text;
  return [refreshMenu(P), `info:${why}`];
}

export function buildMenu(ctx: AppContext): MsxMenuRoot {
  const item = (id: string, icon: string, label: string, dataId: string): MsxMenuItem =>
    ({ id, icon, label, data: req(ctx.P, dataId) });
  const probe = item("probe", "build", T.probe, ids.probe());
  const msxSettings: MsxMenuItem = { id: "msx_settings", type: "settings", label: T.msxSettings };

  const menu: MsxMenuItem[] = !ctx.auth.isLoggedIn()
    ? [item("login", "login", T.login, ids.login()), probe, msxSettings]
    : [
      item("home", "home", T.home, ids.home()),
      item("search", "search", T.search, ids.search()),
      { id: "sep_catalog", type: "separator", label: T.catalog },
      ...SECTIONS.map((s) => {
        const key = encodeListKey({ src: "catalog", type: s.type, sort: CATALOG_SORT, ...(s.genre !== undefined ? { genre: s.genre } : {}) });
        return item(s.id, s.icon, s.label, ids.list(key));
      }),
      { id: "sep_personal", type: "separator" },
      item("bookmarks", "bookmark", T.bookmarks, ids.bookmarks()),
      item("settings", "tune", T.settings, ids.settings()),
      probe,
      msxSettings,
    ];
  return { headline: HEADLINE, extension: EXTENSION, dictionary: DICTIONARY, flag: MENU_FLAG, cache: true, menu };
}
