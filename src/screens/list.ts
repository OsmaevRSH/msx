import type { AppContext } from "../app/context.ts";
import type { MsxContentRoot } from "../msx/types.ts";
import { placeholderScreen } from "./error.ts";

// Заглушка этапа 16; список с пагинацией (S5) — этап 21.

export async function listScreen(ctx: AppContext, key: string): Promise<MsxContentRoot> {
  return placeholderScreen(ctx, "Список");
}

/** Сообщение `extend:<ключ>` от live-элемента списка (спец. §3.4). */
export async function onExtend(ctx: AppContext, key: string): Promise<void> {}
