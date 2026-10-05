import type { AppContext } from "../app/context.ts";
import type { ItemSummary } from "../api/models.ts";
import { contentAction } from "../msx/actions.ts";
import type { MsxContentItem } from "../msx/types.ts";
import { ids } from "../router/ids.ts";

// Заглушка этапа 16; плитки постеров — этап 21.

export function posterTile(ctx: AppContext, it: ItemSummary): MsxContentItem {
  return { id: `i${it.id}`, title: it.title, image: it.posters.medium, action: contentAction(ctx.P, ids.item(it.id)) };
}

export function gridTemplate(ctx: AppContext, layout: string): MsxContentItem {
  return { type: "separate", layout };
}
