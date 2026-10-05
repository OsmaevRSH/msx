import type { AppContext } from "../app/context.ts";
import { toKpError } from "../core/errors.ts";
import type { KpErrorCode } from "../core/errors.ts";
import type { MsxContentRoot } from "../msx/types.ts";

// Заглушка этапа 16; тексты ошибок и экран S14 — этап 17.

export function errorText(err: unknown): { code: KpErrorCode; text: string } {
  const code = toKpError(err).code;
  return { code, text: `Ошибка ${code}` };
}

export function errorScreen(ctx: AppContext, err: unknown, retryDataId?: string): MsxContentRoot {
  const { code, text } = errorText(err);
  return {
    type: "pages",
    headline: "Ошибка",
    pages: [{ items: [{ type: "space", layout: "0,0,12,2", text: `${text}{br}Код: ${code}` }] }],
  };
}

export function placeholderScreen(ctx: AppContext, title: string): MsxContentRoot {
  return { type: "pages", headline: title, pages: [{ items: [{ type: "space", layout: "0,0,12,2", text: "Раздел в разработке" }] }] };
}
