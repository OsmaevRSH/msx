import type { AppContext } from "../app/context.ts";

// Заглушка этапа 16; префетч карточки по фокусу (спец. §8.3, CD-10) — этап 24.

/** Сообщение `pf:<id>` из `selection.action` плитки. */
export function onFocus(ctx: AppContext, id: number): void {}
