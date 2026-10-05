import type { AppContext } from "../app/context.ts";
import type { MsxContentRoot } from "../msx/types.ts";
import { placeholderScreen } from "./error.ts";

// Заглушка этапа 16; панели (S6, S10) — этап 26.

export async function panelScreen(ctx: AppContext, type: string, args: string[]): Promise<MsxContentRoot> {
  return placeholderScreen(ctx, "Панель");
}

/** `act:panel:<name>:<args…>`: озвучка, качество, субтитры, закладки, режим, CDN. */
export async function onPanelAct(ctx: AppContext, name: string, args: string[]): Promise<void> {}

export function choicePanel(ctx: AppContext, title: string, rows: { label: string; action: string; current: boolean }[]): MsxContentRoot {
  return placeholderScreen(ctx, title);
}
