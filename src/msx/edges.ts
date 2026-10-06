import { focusAction } from "./actions.ts";
import type { MsxContentItem, MsxContentPage } from "./types.ts";

// Края сеток без перехода по кругу (спец. §11, навигация). MSX на краю экрана переводит фокус по кругу: «вверх» с первого
// ряда — на последний ряд, «вниз» с последнего — на первый (KB, AGENTS.md «Navigation overflow»). Свойства JSON, которое
// это выключает, нет: `wrap` касается только входа в меню влево и вправо, а признак цикличности навигации в tvx-app
// 0.1.167 включён всегда. Поэтому над первым и под последним рядом стоят стражи — невидимые фокусируемые элементы на той
// же странице. Шаг за край MSX делает на стража (ближайший элемент в этом направлении), а его `selection.action`
// `focus:<id>` тут же возвращает фокус на плитку. Страж на той же странице, что и ряд, поэтому лента не прокручивается,
// а `offset` (на навигацию он не влияет, только на вид) кладёт его на плитку: для пользователя «вверх» на первом ряду
// ничего не делает.

/** Видимый прямоугольник цели стража в единицах сетки страницы (дробные — у плиток `decompress` в сжатом корне). */
export interface Box { id: string; x: number; y: number; w: number; h: number }

const fmt = (n: number): string => String(Math.round(n * 1000) / 1000);

/**
 * Вид стража: `cover` — прозрачный, совпадает с целью: рамка фокуса не сдвигается, фон по умолчанию не затемняет
 * полупрозрачную плитку (`msx-glass`) или кнопку; `band` — ряд под непрозрачным верхом постера, без фона (вставки сеток
 * постеров: ответ из 96 плиток легче на 22 байта на стража); `line` — нулевой высоты по верхнему краю цели, без фона
 * (клавиатура поиска перерисовывается на каждое нажатие).
 */
export type GuardLook = "cover" | "band" | "line";

/**
 * Страж в ряду `row` над или под `t`: колонки — как у цели (целые части; дробные остатки — в `offset`), поэтому шаг по
 * вертикали в её колонке попадает на него. Без `id` и `action`: на стража никто не ссылается, Enter в те доли
 * секунды, что фокус на нём, ничего не запускает.
 */
export function guard(t: Box, row: number, look: GuardLook = "cover"): MsxContentItem {
  const x = Math.round(t.x);
  const w = Math.max(1, Math.round(t.w));
  const h = look === "cover" ? t.h - 1 : look === "band" ? 0 : -1;
  const out: MsxContentItem = { layout: `${x},${row},${w},1`, offset: `${fmt(t.x - x)},${fmt(t.y - row)},${fmt(t.w - w)},${fmt(h)}` };
  if (look === "cover") out.color = "transparent";
  out.selection = { action: focusAction(t.id) };
  return out;
}

/**
 * Сетка шаблона: ширина и высота страницы MSX (12×6, со сжатием 16×8) и размер плитки. `scale` — единиц корня на
 * единицу шаблона: 4/3 у шаблона `decompress` (12×6) в сжатом корне (16×8), там свои элементы вставки — в сетке корня.
 * `poster` — у плиток непрозрачный постер сверху: стражи `band`.
 */
export interface Grid { width: number; height: number; w: number; h: number; scale?: number; poster?: boolean }

/** Плиток в ряду шаблона. */
export const perRow = (g: Grid): number => Math.max(1, Math.floor(g.width / g.w));

const END = "end";

/**
 * Края сетки: `top` — над первым рядом (`shift`: первый ряд плиток фокусируемый — вставка ставит его рядом ниже
 * стражей и поднимает обратно `template.offset`; `overlay`: первый ряд — подпись группы `space`, страж встаёт в её
 * ячейку, сетка не сдвигается), `bottom` — под последним рядом.
 */
export interface Edges { top?: "shift" | "overlay"; bottom?: boolean }

/**
 * Стражи сетки шаблона — страницы-вставки MSX (`inserts`, 0.1.156) с областью (`area`) для шаблонных элементов
 * крайних рядов: верхняя — `page:0`, нижняя — с разрывом `break: "context:end"` у первого элемента своих рядов.
 * Во вставке столько рядов, сколько помещается вместе с рядом стражей; высота страницы (`offset`) убирает этот ряд —
 * лента не сдвигается. Мало рядов — одна вставка с обоими краями. Возвращает вставки и элементы (копия той, что
 * получила разрыв); без элементов или краёв — без вставок.
 */
export function gridEdges(items: MsxContentItem[], g: Grid, edges: Edges): { items: MsxContentItem[]; inserts?: MsxContentPage[] } {
  const n = items.length;
  if (n === 0 || (edges.top === undefined && edges.bottom !== true)) return { items };
  const cols = perRow(g);
  const total = Math.ceil(n / cols);
  const k = g.scale ?? 1;
  const look: GuardLook = g.poster === true ? "band" : "cover";
  const shift = edges.top === "shift" ? 1 : 0;
  const bottom = edges.bottom === true ? 1 : 0;
  /** Сколько рядов помещается во вставку вместе с `guards` рядами стражей. */
  const fit = (guards: number): number => Math.max(1, Math.floor((g.height - guards) / g.h));
  const box = (i: number, row: number): Box => ({ id: String(items[i]?.id ?? ""), x: (i % cols) * g.w * k, y: row * g.h * k, w: g.w * k, h: g.h * k });
  const rowItems = (r: number): number[] => Array.from({ length: Math.min(cols, n - r * cols) }, (_, c) => r * cols + c);
  /** Область вставки — в сетке шаблона: у `decompress` MSX берёт её только у вставки с тем же `decompress`. */
  const page = (p: MsxContentPage): MsxContentPage => (k === 1 ? p : { ...p, decompress: true });
  /** Стражи над первым рядом: `shift` — над плитками, `overlay` — над первым фокусируемым элементом колонки. */
  const topGuards = (): MsxContentItem[] => {
    if (edges.top === "shift") return rowItems(0).map((i) => guard(box(i, 0), 0, look));
    const first = items.findIndex((it) => it.type !== "space" && it.enable !== false);
    return first < 0 ? [] : [guard(box(first, Math.floor(first / cols)), 0, look)];
  };
  /** Стражи под последним рядом одной вставки со всеми рядами (после ряда верхних стражей при `shift`). */
  const bottomGuards = (r: number): MsxContentItem[] => rowItems(r).map((i) => guard(box(i, r), Math.round((shift + (r + 1) * g.h) * k), look));
  const lift = (p: MsxContentPage): MsxContentPage => (shift === 1 ? { ...p, template: { offset: "0,-1,0,0" } } : p);
  const guardRows = shift + bottom;

  if (total <= fit(guardRows) && edges.top !== undefined && bottom === 1) {
    // Все ряды — в одной вставке со стражами сверху и снизу.
    const items2 = [...topGuards(), ...bottomGuards(total - 1)];
    return { items, inserts: [page(lift({ position: "page:0", area: `0,${shift},${g.width},${total * g.h}`, offset: `0,0,0,-${guardRows}`, items: items2 }))] };
  }
  const inserts: MsxContentPage[] = [];
  let topRows = 0;
  if (edges.top !== undefined) {
    topRows = Math.min(total, edges.top === "overlay" ? Math.floor(g.height / g.h) : fit(1));
    const area = `0,${shift},${g.width},${edges.top === "overlay" ? g.height : g.height - 1}`;
    const p: MsxContentPage = { position: "page:0", area, items: topGuards() };
    if (shift === 1) p.offset = "0,0,0,-1";
    inserts.push(page(lift(p)));
  }
  if (bottom === 0) return { items, inserts };
  // Хотя бы последний ряд — в нижней вставке, даже если верхняя вместила бы всё: разрыв закончит верхнюю раньше.
  const from = Math.max(Math.min(topRows, total - 1), total - fit(1));
  const rows = total - from;
  const out = items.slice();
  out[from * cols] = { ...items[from * cols], break: `context:${END}` };
  // Нижняя вставка без верхних стражей: её ряды считаются от нуля.
  const guards = rowItems(total - 1).map((i) => guard(box(i, rows - 1), Math.round(rows * g.h * k), look));
  inserts.push(page({ position: `context:${END}`, area: `0,0,${g.width},${rows * g.h}`, offset: "0,0,0,-1", items: guards }));
  return { items: out, inserts };
}
