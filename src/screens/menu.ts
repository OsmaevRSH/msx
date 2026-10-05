import type { AppContext } from "../app/context.ts";
import { req } from "../msx/actions.ts";
import type { MsxMenuRoot } from "../msx/types.ts";
import { ids } from "../router/ids.ts";

// Заглушка этапа 16; полное меню S3 — этап 17. Без сети и без ожидания (CNFR-03).

export function buildMenu(ctx: AppContext): MsxMenuRoot {
  return {
    headline: "KinoPub",
    menu: [
      { icon: "login", label: "Вход", data: req(ctx.P, ids.login()) },
      { icon: "build", label: "Диагностика", data: req(ctx.P, ids.probe()) },
    ],
  };
}
