import type { AppContext } from "../app/context.ts";
import { FLAG_CHOICES } from "../config/flags.ts";
import type { Flags } from "../config/flags.ts";
import { chain, commitMsg, panelAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { ids, msgs } from "../router/ids.ts";

// «Диагностика → Для разработчика» (спец. §16.6): переключатели развилок Phase 0 меняются на ТВ без нового деплоя
// и хранятся в `kp.cfg.flags`. Панель вариантов — своя разметка через маршрут пробника (`probe:flag:<имя>`).

const TAG = "probe";
const FLAG_PAGE = "flag:";

const T = {
  headline: "Для разработчика",
  hint: "Переключатели развилок Phase 0 (спец. §16.6). Изменённые — жёлтым; хранятся на ТВ до сброса",
  reset: "Сбросить все",
  resetDone: "Переключатели сброшены",
  unknown: "Неизвестный переключатель",
  close: "Закрыть",
  main: "основной",
  fallback: "резервный",
};

const ROWS: readonly { key: keyof Flags; label: string }[] = [
  { key: "streamMode", label: "Режим потока (CDG-05)" },
  { key: "playerPropsIn", label: "Свойства плеера (CDG-06)" },
  { key: "heartbeat", label: "Снимки позиции (CDG-07)" },
  { key: "events", label: "Источник событий (CDG-07)" },
  { key: "autonext", label: "Автопереход (CDG-11)" },
  { key: "restart", label: "Смена озвучки в плеере" },
  { key: "focusPrefetch", label: "Префетч по фокусу (CDG-12)" },
  { key: "gridPreload", label: "Предзагрузка страницы сеток" },
  { key: "postBody", label: "POST-тела (CDG-03)" },
  { key: "apiBase", label: "Хост API" },
  { key: "apiFallbackBase", label: "Резервный хост API" },
];

const rowOf = (name: string): (typeof ROWS)[number] | undefined => ROWS.find((r) => r.key === name);

/** Допустимые значения: перечислимые — из `FLAG_CHOICES`, хосты API — два адреса сборки (решение Р-14). */
export function flagChoices(ctx: AppContext, key: keyof Flags): string[] {
  const c = FLAG_CHOICES[key];
  if (c !== undefined) return c.map(String);
  return [...new Set([ctx.build.apiBase, ctx.build.apiFallbackBase])];
}

function show(ctx: AppContext, key: keyof Flags, v: string): string {
  if (key !== "apiBase" && key !== "apiFallbackBase") return v;
  const host = v.replace(/^[a-z]+:\/\//i, "");
  if (v === ctx.build.apiBase) return `${host} (${T.main})`;
  return v === ctx.build.apiFallbackBase ? `${host} (${T.fallback})` : host;
}

export async function devScreen(ctx: AppContext): Promise<MsxContentRoot> {
  const flags = ctx.flags.get();
  const changed = ctx.flags.overrides();
  const items: MsxContentItem[] = [{ type: "space", layout: "0,0,12,1", text: T.hint }];
  for (const r of ROWS) {
    const v = show(ctx, r.key, String(flags[r.key]));
    items.push({
      id: `f_${r.key}`, type: "control", layout: "0,0,12,1", label: `${r.label} · ${r.key}`,
      extensionLabel: changed[r.key] === undefined ? v : `{txt:msx-yellow:${v}}`,
      action: panelAction(ctx.P, ids.probe(`${FLAG_PAGE}${r.key}`)),
    });
  }
  items.push({ id: "f_reset", type: "button", layout: "0,0,4,1", label: T.reset, action: commitMsg(msgs.act("probe", "flagsReset")) });
  // Без `template` MSX не показывает `items` корня («Содержимое недоступно»).
  return { type: "list", flag: "dev", cache: false, reuse: false, headline: T.headline, template: { type: "control", layout: "0,0,12,1" }, items };
}

/** Панель `probe:flag:<имя>`: выбор значения шлёт `act:probe:flag:<имя>:<значение>` и закрывает панель. */
export function flagPanel(ctx: AppContext, name: string): MsxContentRoot {
  const row = rowOf(name);
  // Панель — тоже корень: без `template` MSX не показывает её `items` («Содержимое недоступно»).
  const panel = (headline: string, items: MsxContentItem[]): MsxContentRoot =>
    ({ type: "list", cache: false, reuse: false, headline, template: { type: "control", layout: "0,0,8,1" }, items });
  if (row === undefined) {
    return panel(T.unknown, [{ id: "v_close", type: "button", layout: "0,0,8,1", label: T.close, action: "back" }]);
  }
  const cur = String(ctx.flags.get()[row.key]);
  return panel(row.label, flagChoices(ctx, row.key).map((v, i) => {
    const item: MsxContentItem = {
      id: `v${i}`, type: "control", layout: "0,0,8,1", label: show(ctx, row.key, v),
      action: chain([commitMsg(msgs.act("probe", "flag", row.key, v)), "back"]),
    };
    if (v === cur) {
      item.extensionIcon = "check";
      item.focus = true;
    }
    return item;
  }));
}

/** `flag:<имя>:<значение>` (значение хоста API само содержит «:») и `flagsReset` → `reload:content`. */
export function onFlagAct(ctx: AppContext, name: string, args: string[]): void {
  if (name === "flagsReset") {
    ctx.flags.reset();
    ctx.log.info(TAG, "flags reset");
    ctx.host.executeAction(chain([`info:${T.resetDone}`, "reload:content"]));
    return;
  }
  const row = rowOf(args[0] ?? "");
  const value = args.slice(1).join(":");
  if (row === undefined || !flagChoices(ctx, row.key).includes(value)) {
    ctx.log.warn(TAG, "bad_flag", { name: args[0], value });
    return;
  }
  ctx.flags.set(row.key, value as never);
  ctx.log.info(TAG, "flag set", { name: row.key, value });
  // Выбор сделан в панели поверх экрана «Для разработчика»: перерисовывается он, если всё ещё текущий (§6.3).
  if (ctx.current.isCurrent(ids.dev())) ctx.host.executeAction("reload:content");
}
