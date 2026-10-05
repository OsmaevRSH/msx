import type { AppContext } from "../app/context.ts";
import type { MsxContentRoot } from "../msx/types.ts";
import { placeholderScreen } from "./error.ts";

// Заглушка этапа 16; закладки (S11) — этап 31.

export async function bookmarksScreen(ctx: AppContext): Promise<MsxContentRoot> {
  return placeholderScreen(ctx, "Закладки");
}
