import type { AppContext } from "../app/context.ts";
import { chain, commitMsg } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentPage, MsxContentRoot } from "../msx/types.ts";
import { msgs } from "../router/ids.ts";
import { LOCKED, SECTIONS, menuStore, refreshMenu, sectionOf } from "./menu.ts";

// «Пункты меню» (S12): панель `panel:menu` поверх «Просмотр и аккаунт». Строка раздела — название с отметкой (Enter
// показывает или скрывает пункт), «▲», «▼» и «В начало». Выбор — сообщение `act:menu:<op>:<id>`: настройка сохраняется,
// меню перерисовывается `replace:menu` (экран настроек открыт из меню — корневой, MSX выполняет замену и под панелью,
// проверено в web MSX 0.1.167), панель — `reload:panel` с фокусом на той же кнопке того же раздела: Enter на «▲» подряд
// поднимает раздел на столько строк, сколько нажатий.

const T = {
  headline: "Пункты меню",
  hint: "OK — показать или скрыть, {ico:arrow-upward} {ico:arrow-downward} — переместить, {ico:vertical-align-top} — в начало",
  reset: "Сбросить по умолчанию",
  locked: "«Просмотр и аккаунт» всегда в меню",
  shown: "{ico:check-box}",
  hidden: "{ico:check-box-outline-blank}",
  lock: "{ico:lock}",
  dflt: "По умолчанию",
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

const act = (op: Op, id?: string): string => commitMsg(id === undefined ? msgs.act("menu", op) : msgs.act("menu", op, id));

/** Строка настроек: «По умолчанию» или «18 из 22» (видимых из всех). */
export function menuSummary(ctx: AppContext): string {
  const store = menuStore(ctx);
  const { order, hidden } = store.get();
  return order.join() === SECTIONS.map((x) => x.id).join() && hidden.length === 0 ? T.dflt : `${order.length - hidden.length} ${T.of} ${order.length}`;
}

/**
 * Строки — по 6 на страницу 8×6 с явными `layout` (у шаблонных элементов MSX берёт `layout` шаблона, а строке нужны
 * четыре кнопки разной ширины): название 5×1, «▲», «▼», «В начало» по 1×1. Панель MSX показывает страницу целиком и
 * листает их; первая строка — подсказка, последняя — «Сбросить по умолчанию».
 */
export function menuPanel(ctx: AppContext): MsxContentRoot {
  const { order, hidden } = menuStore(ctx).get();
  const want = focusOf.get(ctx) ?? `m_${order[0] ?? ""}`;
  focusOf.delete(ctx);
  const btn = (id: string, layout: string, o: MsxContentItem): MsxContentItem =>
    ({ id, type: "button", layout, ...o, ...(id === want ? { focus: true } : {}) });
  const rows: ((y: number) => MsxContentItem[])[] = [(y) => [{ type: "space", layout: `0,${y},8,1`, text: T.hint }]];
  for (const id of order) {
    const x = sectionOf(id);
    if (x === undefined) continue;
    const mark = id === LOCKED ? T.lock : hidden.includes(id) ? T.hidden : T.shown;
    rows.push((y) => [
      btn(`m_${id}`, `0,${y},5,1`, { label: `${mark} ${x.label}`, action: id === LOCKED ? `info:${T.locked}` : act("hide", id) }),
      ...BUTTONS.map(([op, p, icon], k) => btn(`${p}_${id}`, `${5 + k},${y},1,1`, { icon, action: act(op, id) })),
    ]);
  }
  rows.push((y) => [btn(RESET_ID, `0,${y},8,1`, { icon: "restore", label: T.reset, action: act("reset") })]);
  const pages: MsxContentPage[] = [];
  for (let i = 0; i < rows.length; i += ROWS) pages.push({ items: rows.slice(i, i + ROWS).flatMap((row, y) => row(y)) });
  return { type: "list", headline: T.headline, cache: false, reuse: false, pages };
}

/**
 * `act:menu:<hide|up|down|top>:<id>` и `act:menu:reset`: изменить и сохранить настройку (`MenuStore` хранит только
 * отличия), перерисовать меню и панель. Неизвестный раздел или действие — в журнал, без перерисовки.
 */
export function onMenuAct(ctx: AppContext, name: string, args: string[]): void {
  const store = menuStore(ctx);
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
    ctx.log.warn("menu", "bad_act", { name, args });
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
  ctx.host.executeAction(chain([refreshMenu(ctx.P), "reload:panel"]));
}
