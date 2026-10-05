import type { AppContext } from "../app/context.ts";
import type { MsxContentRoot } from "../msx/types.ts";
import { placeholderScreen } from "./error.ts";

// Заглушка этапа 16; серии (S9) — этап 22.

export async function seasonScreen(ctx: AppContext, id: number, n: number): Promise<MsxContentRoot> {
  return placeholderScreen(ctx, "Серии");
}
