import type { AppContext, SearchState } from "../app/context.ts";
import type { ItemSummary } from "../api/models.ts";
import { KpError } from "../core/errors.ts";
import { ruTitle } from "../core/format.ts";
import { commitMsg, contentAction } from "../msx/actions.ts";
import { guard } from "../msx/edges.ts";
import type { MsxContentItem, MsxContentPage } from "../msx/types.ts";
import { ids, msgs } from "../router/ids.ts";
import type { SearchControl } from "../router/ids.ts";
import { errorText } from "./error.ts";
import { RECENT_MAX, recentQueries } from "./recent.ts";

// Экранная клавиатура поиска S7 (спец. §3.4, §11 S7; паттерн RBTV `createSearchHeader`, своя реализация).
// Страница-заголовок перерисовывается на каждое нажатие (`reload:content`), поэтому она лёгкая (≤ 8 КБ без сетки): тип
// кнопки — в шаблоне страницы, у клавиш только место, буква и действие. Порядок букв — алфавит (решение Р-13): RU
// 3 ряда по 11, EN 9/9/8; сетка 16×8 (`compress`). Над буквами — поле запроса (`space` с цветом: MSX рисует фон, фокус
// не заходит), под цифрами — ряд управления. Справа от букв — колонка: подсказки (первые тайтлы ответа поиска) или, пока
// поле пустое, недавние запросы; над ней — подсказка состояния (V-28). Над верхним рядом и под нижним (если результатов
// нет) — стражи `msx/edges.ts`: «вверх» и «вниз» на краю не переносят фокус по кругу.

export const LAYOUTS = { ru: "абвгдеёжзийклмнопрстуфхцчшщъыьэюя", en: "abcdefghijklmnopqrstuvwxyz" } as const;
export const DIGITS = "1234567890";
/** Все символы, которые может прислать клавиатура: буквы обеих раскладок и цифры. */
export const KEY_CHARS = LAYOUTS.ru + LAYOUTS.en + DIGITS;

/**
 * Состояние поиска и то, что знает только экран: общее число найденного из `pagination.totalItems`, сколько результатов
 * показано, если выдача обрезана (не больше 96 и 32 КБ, CNFR-16), подсказки колонки и `recent` — запрос взят из
 * недавних и ещё ищется: до ответа колонка остаётся списком недавних, и фокус пульта не теряет строку.
 */
export type SearchView = SearchState & { total?: number; shown?: number; hints?: readonly ItemSummary[]; recent?: boolean };

const ROW = { ru: 11, en: 9 } as const;
const FIRST_LETTER_ROW = 1;
const DIGIT_ROW = 4;
const CONTROL_ROW = 5;
/** Колонка справа от букв: ряды 1–6 (ряд 7 — для стража под ней; ряд 8 MSX в сетке 16×8 не принимает). */
const COL_X = 11;
const COL_W = 5;
/** Название в строке подсказки: видно ~21 знак, дальше MSX обрезает «…»; лишнее не везётся в каждом нажатии. */
const TITLE_MAX = 30;
/** Значок типа — как у разделов меню (`menu.ts`); год — серым перед названием: его не съедает обрезка. */
const KIND_ICONS: Readonly<Record<string, string>> = {
  serial: "tv", docuserial: "public", documovie: "public", tvshow: "live-tv", concert: "music-note", "3D": "3d-rotation",
};

const T = {
  idle: "Наберите название",
  short: "Минимум 2 символа",
  loading: "Ищу…",
  empty: "Ничего не найдено",
  found: "Найдено: ",
  shown: "показаны первые",
  refine: "уточните запрос",
  back: "{ico:backspace} Стереть",
  space: "{ico:space-bar} Пробел",
  clear: "{ico:clear} Очистить",
  lang: "{ico:language} Раскладка: ",
  below: "{ico:arrow-downward} Результаты ниже",
  /** Под недавними: красная кнопка — «Очистить историю» (опции экрана, как у списков S5). */
  forget: "{ico:msx-red:stop} Очистить историю",
};

/**
 * Ряд управления под цифрами: место и ширина в клетках 16×8. `id` не зависит от раскладки: после «RU/EN» число букв
 * меняется, а MSX после `reload:content` возвращает фокус по `id` элемента (спец. §3.4). Клавиша Delete — «Стереть».
 */
const CONTROLS: { c: SearchControl; x: number; w: number; label: (s: SearchView) => string; key?: string }[] = [
  { c: "back", x: 0, w: 3, label: () => T.back, key: "delete" },
  { c: "space", x: 3, w: 2, label: () => T.space },
  { c: "clear", x: 5, w: 3, label: () => T.clear },
  // V-29: «RU/EN» не говорил, какая раскладка сейчас.
  { c: "lang", x: 8, w: 3, label: (s) => `${T.lang}${s.lang.toUpperCase()}` },
];

/** Клавиша; у верхнего ряда — `id` по месту (`k<x>_<y>`): на неё возвращает страж, при смене раскладки место то же. */
function key(ch: string, x: number, y: number, edge = false): MsxContentItem {
  const it: MsxContentItem = { layout: `${x},${y},1,1`, label: ch, action: commitMsg(msgs.searchInput(ch)) };
  return edge ? { id: `k${x}_${y}`, ...it } : it;
}

/** Стражи над элементами `items` с `id` в ряду `row` (ряд выше) или под ними (ряд ниже). */
function guards(items: MsxContentItem[], row: number, dir: -1 | 1): MsxContentItem[] {
  return items.filter((i) => i.id !== undefined && Number((i.layout ?? "").split(",")[1]) === row).map((i) => {
    const [x = 0, y = 0, w = 1, h = 1] = (i.layout ?? "").split(",").map(Number);
    return guard({ id: i.id as string, x, y, w, h }, row + dir, "line");
  });
}

function hint(s: SearchView): string {
  // V-29: пустое поле (и после «Очистить») всегда просит набрать название.
  if (s.query.trim() === "") return T.idle;
  switch (s.status) {
    case "idle": return T.idle;
    case "short": return T.short;
    case "loading": return T.loading;
    case "empty": return T.empty;
    case "ready": {
      const found = `${T.found}${s.total ?? s.items.length}`;
      return s.shown === undefined ? found : `${found}, ${T.shown} ${s.shown} — ${T.refine}`;
    }
    case "error": {
      const { code, text } = errorText(new KpError(s.error ?? "KP-BAD", "search"));
      return `${text} (${code})`;
    }
  }
}

/** Недавние запросы, если колонка показывает их: подсказок нет, а поле пустое (или запрос из недавних ещё ищется). */
export function recentShown(ctx: AppContext, s: SearchView): string[] {
  if ((s.hints?.length ?? 0) > 0 || (s.query.trim() !== "" && s.recent !== true)) return [];
  return recentQueries(ctx.store);
}

/** «2001 Властелин колец…»: год серым впереди, название по-русски, не длиннее `TITLE_MAX`. */
function hintLabel(it: ItemSummary): string {
  const name = ruTitle(it.title);
  const title = name.length > TITLE_MAX ? `${name.slice(0, TITLE_MAX - 1).trimEnd()}…` : name;
  return it.year !== undefined && it.year > 0 ? `{txt:msx-white-soft:${it.year}} ${title}` : title;
}

/**
 * Колонка справа: строки `control` (значок, подпись слева) с `id` по месту — `s<n>`. Подсказка открывает карточку
 * тайтла, недавний запрос подставляется в поле (по номеру строки). Смена содержимого на тех же местах не сбивает фокус.
 */
function column(ctx: AppContext, s: SearchView): MsxContentItem[] {
  const row = (n: number, it: MsxContentItem): MsxContentItem =>
    ({ id: `s${n}`, type: "control", layout: `${COL_X},${FIRST_LETTER_ROW + n},${COL_W},1`, ...it });
  const hints = (s.hints ?? []).slice(0, RECENT_MAX);
  if (hints.length > 0) {
    return hints.map((it, n) => row(n, { icon: KIND_ICONS[it.type] ?? "movie", label: hintLabel(it), action: contentAction(ctx.P, ids.item(it.id)) }));
  }
  return recentShown(ctx, s).map((q, n) => row(n, { icon: "history", label: q, action: commitMsg(msgs.searchRecent(n)) }));
}

/**
 * Страница-заголовок поиска: поле запроса с курсором, подсказка состояния над колонкой (спец. §11 S7), буквы текущей
 * раскладки, цифры (клавиши пульта 0–9), ряд управления и колонка подсказок или недавних запросов. Есть результаты —
 * страница занимает все 8 рядов, и они начинаются со следующей: иначе первый ряд постеров уходит под подвал MSX (V-25).
 */
export function keyboardPage(ctx: AppContext, s: SearchView): MsxContentPage {
  const items: MsxContentItem[] = [
    { type: "space", layout: `0,0,${COL_X},1`, color: "msx-glass", headline: `{ico:search} ${s.query}_` },
    { type: "space", layout: `${COL_X},0,${COL_W},1`, text: hint(s) },
  ];
  const row = ROW[s.lang];
  [...LAYOUTS[s.lang]].forEach((ch, n) => items.push(key(ch, n % row, FIRST_LETTER_ROW + Math.floor(n / row), n < row)));
  [...DIGITS].forEach((d, x) => items.push({ ...key(d, x, DIGIT_ROW), key: d }));
  const controls = CONTROLS.map(({ c, x, w, label, key: k }): MsxContentItem => {
    const it: MsxContentItem = { id: `k_${c}`, layout: `${x},${CONTROL_ROW},${w},1`, label: label(s), action: commitMsg(msgs.searchControl(c)) };
    if (k !== undefined) it.key = k;
    return it;
  });
  const col = column(ctx, s);
  const last = FIRST_LETTER_ROW + col.length - 1;
  items.push(...controls, ...col);
  if (col.length > 0 && recentShown(ctx, s).length > 0) items.push({ type: "space", layout: `${COL_X},${last + 1},${COL_W},1`, text: T.forget });
  // Стражи — после клавиш и колонки: номера клавиш (по ним MSX держит фокус после перерисовки) не зависят от стражей,
  // фокус при открытии — на первой букве, а в ячейке 0,0 MSX регистрирует последний элемент (поле не фокусируется).
  // Тип кнопки из шаблона страницы стражам не мешает: они нулевой высоты (проверено в web MSX 0.1.167).
  items.push(...guards(items, FIRST_LETTER_ROW, -1));
  // С результатами «вниз» с нижнего ряда (управление, последняя строка колонки) ведёт к ним.
  if (s.items.length > 0) items.push({ type: "space", layout: "0,7,16,1", text: T.below });
  else items.push(...guards(controls, CONTROL_ROW, 1), ...guards(col.slice(-1), last, 1));
  return { template: { type: "button" }, items };
}
