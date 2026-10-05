import type { AppContext } from "../app/context.ts";
import { toKpError } from "../core/errors.ts";
import type { KpErrorCode } from "../core/errors.ts";
import { chain, contentAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { ids } from "../router/ids.ts";

// Экран ошибки S14 (Plan B §8.3 S14, спец. §12): причина простыми словами и код KP-*.

const TEXTS: Readonly<Record<KpErrorCode, string>> = {
  "KP-NET": "Нет связи с KinoPub. Проверьте VPN",
  "KP-429": "KinoPub перегружен, повторите через минуту",
  "KP-5XX": "KinoPub не отвечает",
  "KP-404": "Тайтл недоступен или удалён из каталога",
  "KP-AUTH": "Сессия KinoPub завершена, войдите снова",
  "KP-CORS": "KinoPub не разрешает запросы из приложения (CORS)",
  "KP-BAD": "Неожиданный ответ KinoPub",
};

const T = {
  title: "Ошибка",
  headline: "{ico:msx-yellow:warning} Не удалось загрузить",
  code: "Код",
  retry: "Повторить",
  login: "Войти",
  probe: "Диагностика",
  placeholder: "Раздел в разработке",
};

/** Перезапросить текущий экран; `invalidate:content` — только визуальная пометка «обновляю» (msx-platform §3.2). */
export const RETRY_CONTENT = chain(["invalidate:content", "reload:content"]);
const RETRY_PANEL = "reload:panel";
const PAGE_W = 12;
const PANEL_W = 8;

export function errorText(err: unknown): { code: KpErrorCode; text: string } {
  const code = toKpError(err).code;
  return { code, text: TEXTS[code] };
}

export interface ErrorItemsOptions {
  /** Действие кнопки «Повторить». */
  retry: string;
  /** `KP-AUTH` — кнопка «Войти» вместо «Повторить». */
  offerLogin: boolean;
  /** Ширина сетки: 12 у экрана, 8 у панели. */
  width?: number;
  headline?: string;
}

/** Элементы S14: причина с кодом на `0,0,w,4` и две кнопки в нижней строке. */
export function errorItems(ctx: AppContext, err: unknown, o: ErrorItemsOptions): MsxContentItem[] {
  const { code, text } = errorText(err);
  const w = o.width ?? PAGE_W;
  const half = w / 2;
  const login = o.offerLogin && code === "KP-AUTH";
  return [
    { type: "space", layout: `0,0,${w},4`, headline: o.headline ?? T.headline, text: `${text}{br}${T.code}: ${code}` },
    {
      type: "button", layout: `0,5,${half},1`,
      label: login ? T.login : T.retry,
      action: login ? contentAction(ctx.P, ids.login()) : o.retry,
    },
    { type: "button", layout: `${half},5,${half},1`, label: T.probe, action: contentAction(ctx.P, ids.probe()) },
  ];
}

/**
 * S14. Ошибку запроса `panel:…` MSX рисует в панели (сетка 8×6), поэтому там «Повторить» перезапрашивает
 * панель, а не экран под ней.
 */
export function errorScreen(ctx: AppContext, err: unknown, retryDataId?: string): MsxContentRoot {
  const panel = retryDataId?.startsWith("panel:") === true;
  const items = errorItems(ctx, err, {
    retry: panel ? RETRY_PANEL : RETRY_CONTENT,
    offerLogin: true,
    width: panel ? PANEL_W : PAGE_W,
  });
  return { type: "pages", cache: false, reuse: false, headline: T.title, pages: [{ items }] };
}

export function placeholderScreen(ctx: AppContext, title: string): MsxContentRoot {
  return { type: "pages", headline: title, pages: [{ items: [{ type: "space", layout: "0,0,12,2", text: T.placeholder }] }] };
}
