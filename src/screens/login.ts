import type { AppContext } from "../app/context.ts";
import type { MsxContentRoot } from "../msx/types.ts";
import { placeholderScreen } from "./error.ts";

// Заглушка этапа 16; вход по коду (S2) — этап 17.

export async function loginScreen(ctx: AppContext): Promise<MsxContentRoot> {
  return placeholderScreen(ctx, "Вход в KinoPub");
}

export async function onLoginAct(ctx: AppContext, name: string, args: string[]): Promise<void> {}
