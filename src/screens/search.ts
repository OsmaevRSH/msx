import type { AppContext } from "../app/context.ts";
import type { MsxContentRoot } from "../msx/types.ts";
import type { Msg } from "../router/ids.ts";
import { placeholderScreen } from "./error.ts";

// Заглушка этапа 16; поиск с клавиатурой (S7) — этап 25.

export async function searchScreen(ctx: AppContext): Promise<MsxContentRoot> {
  return placeholderScreen(ctx, "Поиск");
}

/** `search:input:*`, `search:control:*` и `extend:search` (спец. §3.4). */
export function onSearchInput(ctx: AppContext, m: Msg): void {}
