import type { AppContext } from "../app/context.ts";
import { ProbeRunner } from "./runner.ts";
import { installTvChecks } from "./tv-checks.ts";

// Точка входа probe.js (этап 23b): «Диагностика», «Для разработчика», плитки и отчёт грузятся по первому обращению
// к маршруту пробника (src/probe/lazy.ts). Модули вне src/probe/ probe.js берёт у app.js (tools/build.mjs).

export { devScreen, onProbeAct, probeResolve, probeScreen } from "./screens.ts";

/** `ctx.probe` и подписка проверок уровня ТВ на трекер: плитки CDG-05…07, 11 запускаются уже после загрузки. */
export function install(ctx: AppContext): void {
  ctx.probe = new ProbeRunner(ctx);
  installTvChecks(ctx);
}
