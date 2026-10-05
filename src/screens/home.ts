import type { AppContext } from "../app/context.ts";
import type { MsxContentRoot } from "../msx/types.ts";
import { placeholderScreen } from "./error.ts";

// Заглушка этапа 16; главная (S4) — этап 30.

export async function homeScreen(ctx: AppContext): Promise<MsxContentRoot> {
  return placeholderScreen(ctx, "Главная");
}

/** Фоновый прогрев полок главной после `ready` (спец. §6.1). */
export function warmHome(ctx: AppContext): void {}
