import type { AppContext } from "../app/context.ts";
import type { MsxContentRoot } from "../msx/types.ts";
import { placeholderScreen } from "./error.ts";

// Заглушка этапа 16; карточка (S8) — этап 22.

export async function itemScreen(ctx: AppContext, id: number): Promise<MsxContentRoot> {
  return placeholderScreen(ctx, "Карточка");
}

/** `act:item:<name>:<args…>`: `watched`, `refresh`. */
export async function onItemAct(ctx: AppContext, name: string, args: string[]): Promise<void> {}
