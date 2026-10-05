import type { AppContext, SearchState } from "../app/context.ts";
import { KpError } from "../core/errors.ts";
import { commitMsg } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentPage } from "../msx/types.ts";
import { msgs } from "../router/ids.ts";
import type { SearchControl } from "../router/ids.ts";
import { errorText } from "./error.ts";

// Экранная клавиатура поиска S7 (спец. §3.4, §11 S7; паттерн RBTV `createSearchHeader`, своя реализация).
// Страница-заголовок перерисовывается на каждое нажатие (`reload:content`), поэтому в ней только кнопки
// без лишних полей. Порядок букв — алфавит (решение Р-13): RU 3 ряда по 11, EN 9/9/8; сетка 16×8 (`compress`).

export const LAYOUTS = { ru: "абвгдеёжзийклмнопрстуфхцчшщъыьэюя", en: "abcdefghijklmnopqrstuvwxyz" } as const;
export const DIGITS = "1234567890";
/** Все символы, которые может прислать клавиатура: буквы обеих раскладок и цифры. */
export const KEY_CHARS = LAYOUTS.ru + LAYOUTS.en + DIGITS;

/**
 * Состояние поиска и то, что знает только экран: общее число найденного из `pagination.totalItems` и сколько
 * результатов показано, если выдача обрезана (не больше 96 и 32 КБ, CNFR-16).
 */
export type SearchView = SearchState & { total?: number; shown?: number };

const ROW = { ru: 11, en: 9 } as const;
const FIRST_LETTER_ROW = 1;
const DIGIT_ROW = 4;
const CONTROL_X = 12;
const CONTROL_W = 4;

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
  lang: "{ico:language} RU/EN",
};

/**
 * Управляющие кнопки. `id` не зависит от раскладки: после «RU/EN» число букв меняется, а MSX после
 * `reload:content` возвращает фокус по `id` элемента (спец. §3.4). Клавиша Delete — «Стереть».
 */
const CONTROLS: { c: SearchControl; label: string; key?: string }[] = [
  { c: "back", label: T.back, key: "delete" },
  { c: "space", label: T.space },
  { c: "clear", label: T.clear },
  { c: "lang", label: T.lang },
];

function key(ch: string, x: number, y: number): MsxContentItem {
  return { type: "button", layout: `${x},${y},1,1`, label: ch, action: commitMsg(msgs.searchInput(ch)) };
}

function hint(s: SearchView): string {
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

/** Строка ввода: запрос с курсором и подсказка состояния (спец. §11 S7). */
export function inputLine(s: SearchView): string {
  return `{ico:search} ${s.query}_ {col:msx-white-soft}· ${hint(s)}`;
}

/** Страница-заголовок поиска: строка ввода, буквы текущей раскладки, цифры (клавиши пульта 0–9), управление. */
export function keyboardPage(ctx: AppContext, s: SearchView): MsxContentPage {
  const items: MsxContentItem[] = [{ type: "space", layout: "0,0,16,1", headline: inputLine(s) }];
  const row = ROW[s.lang];
  [...LAYOUTS[s.lang]].forEach((ch, n) => items.push(key(ch, n % row, FIRST_LETTER_ROW + Math.floor(n / row))));
  [...DIGITS].forEach((d, x) => items.push({ ...key(d, x, DIGIT_ROW), key: d }));
  CONTROLS.forEach(({ c, label, key: k }, n) => {
    const it: MsxContentItem = {
      id: `k_${c}`, type: "button", layout: `${CONTROL_X},${FIRST_LETTER_ROW + n},${CONTROL_W},1`, label,
      action: commitMsg(msgs.searchControl(c)),
    };
    if (k !== undefined) it.key = k;
    items.push(it);
  });
  return { items };
}
