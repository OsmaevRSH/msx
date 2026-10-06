import type { AppContext } from "../app/context.ts";
import type { LogoutReason } from "../auth/auth-service.ts";
import { MenuStore } from "../config/menu.ts";
import { KpError } from "../core/errors.ts";
import { chain, replaceMenu, req } from "../msx/actions.ts";
import type { MsxMenuItem, MsxMenuRoot } from "../msx/types.ts";
import { encodeListKey, ids } from "../router/ids.ts";
import type { ListKey } from "../router/ids.ts";
import { errorText } from "./error.ts";
import { UHD_QUALITY } from "./list-head.ts";

// Меню S3 (спец. §7.1, §11; Plan B §8.3 S3). Строится без сети и без ожидания (CNFR-03). Порядок и видимость пунктов —
// настройка «Пункты меню» (S12, `kp.cfg.menu`); «Просмотр и аккаунт» скрыть нельзя, «Настройки MSX» — всегда последние.

const HEADLINE = "KinoPub";
const EXTENSION = "{ico:msx-white:access-time} {now:time:hh:mm}";
const DICTIONARY = "http://msx.benzac.de/dic/ru.json";
const CATALOG_SORT = "-updated";
/** Флаг меню для `replace:menu:…` (Replace Action MSX 0.1.144). */
export const MENU_FLAG = "menu";

const T = {
  login: "Вход",
  settings: "Просмотр и аккаунт",
  probe: "Диагностика",
  msxSettings: "Настройки MSX",
  bye: "Вы вышли из KinoPub",
};

/**
 * Раздел меню: `id` — и пункта MSX, и записи в `kp.cfg.menu`; `g` — группа для разделителей. `dataId` — функция: ключи
 * списков считаются при построении меню, а не при загрузке модуля.
 */
export interface Section { id: string; icon: string; label: string; dataId: () => string; g: number }

/** Подписи разделителей групп: «Каталог» над типами, «Ещё» над разделами, добавленными в v1.11. */
const GROUPS = ["", "Каталог", "", "Ещё", ""];

const list = (k: ListKey) => (): string => ids.list(encodeListKey(k));
const cat = (type: string, genre?: string) => list({ src: "catalog", type, sort: CATALOG_SORT, ...(genre === undefined ? {} : { genre }) });
const s = (id: string, icon: string, label: string, dataId: () => string, g: number): Section => ({ id, icon, label, dataId, g });

/**
 * Все разделы в порядке по умолчанию: «Главная», «Я смотрю», «Поиск», «Новинки», затем прежние пункты, затем новые
 * разделы официальных клиентов (спец. §11 S3): «История», подборки, полки без типа, разделы-жанры конфига PWA (25, 101),
 * 3D, 4K (`quality=4`) и «Спорт» — каналы эфира `/v1/tv` (`sporttv` PWA, «Спорт» webOS).
 */
export const SECTIONS: readonly Section[] = [
  s("home", "home", "Главная", ids.home, 0),
  s("watching", "visibility", "Я смотрю", ids.watching, 0),
  s("search", "search", "Поиск", ids.search, 0),
  s("fresh", "new-releases", "Новинки", list({ src: "fresh" }), 0),
  s("movies", "movie", "Фильмы", cat("movie"), 1),
  s("serials", "tv", "Сериалы", cat("serial"), 1),
  s("cartoons", "child-care", "Мультфильмы", cat("movie,serial", "23"), 1),
  s("docs", "public", "Документальное", cat("documovie,docuserial"), 1),
  s("tvshows", "live-tv", "ТВ-шоу", cat("tvshow"), 1),
  s("concerts", "music-note", "Концерты", cat("concert"), 1),
  s("bookmarks", "bookmark", "Закладки", ids.bookmarks, 2),
  s("history", "history", "История", list({ src: "history" }), 2),
  s("collections", "collections-bookmark", "Подборки", list({ src: "collections" }), 3),
  s("popular", "trending-up", "Популярное", list({ src: "popular" }), 3),
  s("hot", "whatshot", "Горячее", list({ src: "hot" }), 3),
  s("anime", "animation", "Аниме", cat("movie,serial", "25"), 3),
  s("standup", "theater-comedy", "Стендап", cat("movie", "101"), 3),
  s("s3d", "3d-rotation", "3D", cat("3d"), 3),
  s("uhd", "4k", "4K", list({ src: "catalog", sort: CATALOG_SORT, quality: UHD_QUALITY }), 3),
  s("sport", "sports-soccer", "Спорт", ids.tv, 3),
  s("settings", "tune", T.settings, ids.settings, 4),
  s("probe", "build", T.probe, ids.probe, 4),
];

/** Пункт, который нельзя скрыть: без него не вернуть скрытое. */
export const LOCKED = "settings";

export const sectionOf = (id: string): Section | undefined => SECTIONS.find((x) => x.id === id);

/** Настройка «Пункты меню» поверх `kp.cfg.menu`. */
export function menuStore(ctx: AppContext): MenuStore {
  return new MenuStore(ctx.store, SECTIONS.map((x) => x.id), [LOCKED]);
}

/**
 * Перерисовать меню после входа и выхода. Меню загружено из start parameter, а такое MSX по `reload:menu` не
 * перезапрашивает (найдено smoke-e2e в web MSX, этап 27); `replace:menu` перезапрашивает и при `cache: true`.
 */
export function refreshMenu(P: string): string {
  return replaceMenu(MENU_FLAG, P, ids.init());
}

/**
 * Меню после входа и выхода с любого экрана (X-3). `replace:menu` MSX выполняет только на корневом экране, поэтому
 * сначала `home` (закрыть вложенные экраны, панель, плеер), а замену — после анимации: без `lazy:` MSX с анимациями её
 * пропускает. На корневом экране `home` открывает системное «Меню» MSX, и оно перехватывало пульт — `cleanup` его
 * закрывает (найдено e2e при интеграции UX). Проверено в web MSX 0.1.167: корень, вложенные экраны, панель, плеер.
 */
export function toMenu(P: string, toast: string): string {
  return chain(["home", "cleanup", `lazy:${refreshMenu(P)}`, `info:${toast}`]);
}

/** Выход и потеря сессии (V-39): гостевое меню и причина уведомлением; отказ refresh — текстом `KP-AUTH`. */
export function loggedOutAction(P: string, reason: LogoutReason): string {
  return toMenu(P, reason === "logout" ? T.bye : errorText(new KpError("KP-AUTH", reason)).text);
}

/**
 * Видимые разделы в порядке пользователя. Между группами — разделитель; подпись группы — только у первого её
 * разделителя: в своём порядке пользователя группы могут встречаться несколько раз.
 */
function sections(ctx: AppContext): MsxMenuItem[] {
  const { order, hidden } = menuStore(ctx).get();
  const out: MsxMenuItem[] = [];
  const used = new Set<string>();
  let g: number | undefined;
  for (const id of order) {
    const x = sectionOf(id);
    if (x === undefined || hidden.includes(id)) continue;
    if (g !== undefined && x.g !== g) {
      const label = GROUPS[x.g] ?? "";
      out.push(label === "" || used.has(label) ? { id: `sep_${id}`, type: "separator" } : { id: `sep_${id}`, type: "separator", label });
      used.add(label);
    }
    g = x.g;
    out.push({ id, icon: x.icon, label: x.label, data: req(ctx.P, x.dataId()) });
  }
  return out;
}

export function buildMenu(ctx: AppContext): MsxMenuRoot {
  const msxSettings: MsxMenuItem = { id: "msx_settings", type: "settings", label: T.msxSettings };
  const menu: MsxMenuItem[] = !ctx.auth.isLoggedIn()
    ? [{ id: "login", icon: "login", label: T.login, data: req(ctx.P, ids.login()) }, { id: "probe", icon: "build", label: T.probe, data: req(ctx.P, ids.probe()) }, msxSettings]
    : [...sections(ctx), msxSettings];
  return { headline: HEADLINE, extension: EXTENSION, dictionary: DICTIONARY, flag: MENU_FLAG, cache: true, menu };
}
