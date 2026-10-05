import type { AppContext } from "../app/context.ts";
import type { MsxContentRoot } from "../msx/types.ts";
import { placeholderScreen } from "./error.ts";

// Заглушка этапа 16; настройки (S12) — этап 31.

export async function settingsScreen(ctx: AppContext): Promise<MsxContentRoot> {
  return placeholderScreen(ctx, "Настройки KinoPub");
}

/** Панель `panel:setting:<key>` (её вызывает `panelScreen`). */
export async function settingPanel(ctx: AppContext, key: string): Promise<MsxContentRoot> {
  return placeholderScreen(ctx, "Настройка");
}

/** `act:set:<key>:<value>`. */
export async function onSettingsAct(ctx: AppContext, name: string, args: string[]): Promise<void> {}
