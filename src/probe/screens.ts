import type { AppContext } from "../app/context.ts";
import type { MsxContentRoot, MsxResolveResponse } from "../msx/types.ts";
import type { Route } from "../router/ids.ts";
import { placeholderScreen } from "../screens/error.ts";

// Заглушка этапа 16; экраны пробника, отчёт и «Для разработчика» (спец. §13, §16.2, §16.6) — этап 23.

export async function probeScreen(ctx: AppContext, page?: string): Promise<MsxContentRoot> {
  return placeholderScreen(ctx, "Диагностика");
}

export async function devScreen(ctx: AppContext): Promise<MsxContentRoot> {
  return placeholderScreen(ctx, "Для разработчика");
}

/** `act:probe:<name>:<args…>`. */
export async function onProbeAct(ctx: AppContext, name: string, args: string[]): Promise<void> {}

export async function probeResolve(ctx: AppContext, r: Route & { k: "probePlay" }): Promise<MsxResolveResponse> {
  return { error: "Не реализовано" };
}
