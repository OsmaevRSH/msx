import type { AppContext } from "../app/context.ts";
import type { OrderStore } from "../config/menu.ts";
import { chain, commitMsg } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentPage, MsxContentRoot } from "../msx/types.ts";
import { msgs } from "../router/ids.ts";
import { SHELVES, homeStore, redrawHome } from "./home.ts";
import { menuStore, refreshMenu, sectionOf } from "./menu.ts";

// Список с порядком и видимостью (S12): «Пункты меню» — панель `panel:menu` (S3), «Секции главной» — `panel:home` (S4).
// Строка — название с отметкой (Enter показывает или скрывает), «▲», «▼» и «В начало». Выбор — сообщение
// `act:<список>:<op>:<id>`: настройка сохраняется, настроенное перерисовывается, панель — `reload:panel` с фокусом на той
// же кнопке той же строки: Enter на «▲» подряд поднимает строку на столько строк, сколько нажатий. Меню — `replace:menu`
// (экран настроек открыт из меню — корневой, MSX выполняет замену и под панелью, проверено в web MSX 0.1.167); главная —
// `replace:content`, если она текущая (панель открыта с неё красной кнопкой), иначе `reload:content` — экран настроек
// под панелью со сводкой строки (MSX перезапрашивает его, панель и фокус в ней остаются; проверено в web MSX 0.1.167),
// а главную MSX запросит заново при показе (`cache: false`).

export type OrderKey = "menu" | "home";

interface Spec {
  headline: string;
  /** Строка экрана настроек. */
  row: string;
  store: (ctx: AppContext) => OrderStore;
  label: (id: string) => string | undefined;
  /** Пояснение у закреплённой строки: её не скрыть. */
  locked?: string;
  /** Перерисовка настроенного перед `reload:panel`. */
  redraw: (ctx: AppContext) => string;
}

const SPECS: Record<OrderKey, Spec> = {
  menu: {
    headline: "Пункты меню", row: "Порядок и видимость пунктов меню", store: menuStore, label: (id) => sectionOf(id)?.label,
    locked: "«Настройки» всегда в меню", redraw: (ctx) => refreshMenu(ctx.P),
  },
  home: {
    headline: "Секции главной", row: "Порядок и видимость секций главной", store: homeStore,
    label: (id) => SHELVES.find((d) => d.id === id)?.title, redraw: redrawHome,
  },
};

const T = {
  hint: "OK — показать или скрыть, {ico:arrow-upward} {ico:arrow-downward} — переместить, {ico:vertical-align-top} — в начало",
  reset: "Сбросить по умолчанию",
  shown: "{ico:check-box}",
  hidden: "{ico:check-box-outline-blank}",
  lock: "{ico:lock}",
  dflt: "По умолчанию",
  own: "Свой порядок",
  of: "из",
};

type Op = "hide" | "up" | "down" | "top" | "reset";
/** Кнопка строки: префикс `id` элемента и значок; первая — само название. */
const BUTTONS: readonly [Op, string, string][] = [["up", "u", "arrow-upward"], ["down", "d", "arrow-downward"], ["top", "t", "vertical-align-top"]];
const RESET_ID = "m_reset";
/** Строк на странице панели (сетка 8×6). */
const ROWS = 6;

/** Кнопка, на которой был Enter: после `reload:panel` фокус возвращается на неё. */
const focusOf = new WeakMap<AppContext, string>();

export const orderRow = (key: OrderKey): string => SPECS[key].row;

/** Строка настроек: «По умолчанию», «Свой порядок» (ничего не скрыто) или «18 из 22» (видимых из всех). */
export function orderSummary(ctx: AppContext, key: OrderKey): string {
  const store = SPECS[key].store(ctx);
  const { order, hidden } = store.get();
  if (hidden.length > 0) return `${order.length - hidden.length} ${T.of} ${order.length}`;
  return order.join() === store.defaults.join() ? T.dflt : T.own;
}

/**
 * Строки — по 6 на страницу 8×6 с явными `layout` (у шаблонных элементов MSX берёт `layout` шаблона, а строке нужны
 * четыре кнопки разной ширины): название 5×1, «▲», «▼», «В начало» по 1×1. Панель MSX показывает страницу целиком и
 * листает их; первая строка — подсказка, последняя — «Сбросить по умолчанию».
 */
export function orderPanel(ctx: AppContext, key: OrderKey): MsxContentRoot {
  const spec = SPECS[key];
  const store = spec.store(ctx);
  const { order, hidden } = store.get();
  const want = focusOf.get(ctx) ?? `m_${order[0] ?? ""}`;
  focusOf.delete(ctx);
  const act = (op: Op, id?: string): string => commitMsg(id === undefined ? msgs.act(key, op) : msgs.act(key, op, id));
  const btn = (id: string, layout: string, o: MsxContentItem): MsxContentItem =>
    ({ id, type: "button", layout, ...o, ...(id === want ? { focus: true } : {}) });
  const rows: ((y: number) => MsxContentItem[])[] = [(y) => [{ type: "space", layout: `0,${y},8,1`, text: T.hint }]];
  for (const id of order) {
    const label = spec.label(id);
    if (label === undefined) continue;
    const free = store.canHide(id);
    const mark = !free ? T.lock : hidden.includes(id) ? T.hidden : T.shown;
    rows.push((y) => [
      btn(`m_${id}`, `0,${y},5,1`, { label: `${mark} ${label}`, action: free ? act("hide", id) : `info:${spec.locked ?? ""}` }),
      ...BUTTONS.map(([op, p, icon], k) => btn(`${p}_${id}`, `${5 + k},${y},1,1`, { icon, action: act(op, id) })),
    ]);
  }
  rows.push((y) => [btn(RESET_ID, `0,${y},8,1`, { icon: "restore", label: T.reset, action: act("reset") })]);
  const pages: MsxContentPage[] = [];
  for (let i = 0; i < rows.length; i += ROWS) pages.push({ items: rows.slice(i, i + ROWS).flatMap((row, y) => row(y)) });
  return { type: "list", headline: spec.headline, cache: false, reuse: false, pages };
}

/**
 * `act:<список>:<hide|up|down|top>:<id>` и `act:<список>:reset`: изменить и сохранить настройку (`OrderStore` хранит
 * только отличия), перерисовать настроенное и панель. Неизвестная строка или действие — в журнал, без перерисовки.
 */
export function onOrderAct(ctx: AppContext, key: OrderKey, name: string, args: string[]): void {
  const spec = SPECS[key];
  const store = spec.store(ctx);
  const cfg = store.get();
  const id = args[0] ?? "";
  const i = cfg.order.indexOf(id);
  const move = (to: number): void => {
    cfg.order.splice(i, 1);
    cfg.order.splice(Math.max(0, Math.min(cfg.order.length, to)), 0, id);
  };
  if (name === "reset") {
    store.reset();
    focusOf.set(ctx, RESET_ID);
  } else if (i < 0 || !(["hide", "up", "down", "top"] as string[]).includes(name)) {
    ctx.log.warn(key, "bad_act", { name, args });
    return;
  } else {
    if (name === "hide") {
      if (!store.canHide(id)) return;
      cfg.hidden = cfg.hidden.includes(id) ? cfg.hidden.filter((h) => h !== id) : [...cfg.hidden, id];
    } else {
      move(name === "up" ? i - 1 : name === "down" ? i + 1 : 0);
    }
    store.set(cfg);
    const p = name === "hide" ? "m" : BUTTONS.find((b) => b[0] === name)?.[1];
    focusOf.set(ctx, `${p}_${id}`);
  }
  ctx.host.executeAction(chain([spec.redraw(ctx), "reload:panel"]));
}
