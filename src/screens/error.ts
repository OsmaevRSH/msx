import type { AppContext } from "../app/context.ts";
import { KpError, toKpError } from "../core/errors.ts";
import type { KpErrorCode } from "../core/errors.ts";
import { chain, contentAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { ids, isPanelId, parseDataId } from "../router/ids.ts";

// Экран ошибки S14 (Plan B §8.3 S14, спец. §12): причина простыми словами и код KP-*.

const TEXTS: Readonly<Record<KpErrorCode, string>> = {
  "KP-NET": "Нет связи с KinoPub. Проверьте VPN",
  "KP-429": "KinoPub сейчас не отвечает. Повторите через минуту",
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
  back: "Назад",
  search: "Поиск",
  placeholder: "Раздел в разработке",
  /** V-40: за срок экрана не пришло ничего — причина неизвестна (5xx, `TypeError`, зависание). */
  slow: "KinoPub не отвечает. Проверьте VPN",
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
  /** `KP-404` тайтла: «Назад» и «Поиск» — повтор не вернёт удалённый тайтл (V-41). */
  gone?: boolean;
  /** Причина вместо текста кода. */
  text?: string;
}

/** Элементы S14: причина с кодом на `0,0,w,4` и две кнопки в нижней строке. */
export function errorItems(ctx: AppContext, err: unknown, o: ErrorItemsOptions): MsxContentItem[] {
  const { code, text } = errorText(err);
  const w = o.width ?? PAGE_W;
  const half = w / 2;
  const login = o.offerLogin && code === "KP-AUTH";
  const gone = o.gone === true && code === "KP-404";
  const button = (x: number, label: string, action: string): MsxContentItem => ({ type: "button", layout: `${x},5,${half},1`, label, action });
  return [
    { type: "space", layout: `0,0,${w},4`, headline: o.headline ?? T.headline, text: `${o.text ?? text}{br}${T.code}: ${code}` },
    gone ? button(0, T.back, "back") : button(0, login ? T.login : T.retry, login ? contentAction(ctx.P, ids.login()) : o.retry),
    gone ? button(half, T.search, contentAction(ctx.P, ids.search())) : button(half, T.probe, contentAction(ctx.P, ids.probe())),
  ];
}

/** Корни экранов ошибки: поздний ответ с ошибкой не заменяет экран «не отвечает» (V-40). */
const failed = new WeakSet<object>();

/**
 * S14. Ошибку запроса `panel:…` MSX рисует в панели (сетка 8×6), поэтому там «Повторить» перезапрашивает
 * панель, а не экран под ней.
 */
export function errorScreen(ctx: AppContext, err: unknown, retryDataId?: string, text?: string): MsxContentRoot {
  const panel = retryDataId !== undefined && isPanelId(retryDataId);
  const k = retryDataId === undefined ? undefined : parseDataId(retryDataId).k;
  const items = errorItems(ctx, err, {
    retry: panel ? RETRY_PANEL : RETRY_CONTENT,
    offerLogin: true,
    width: panel ? PANEL_W : PAGE_W,
    gone: k === "item" || k === "season",
    text,
  });
  const root: MsxContentRoot = { type: "pages", cache: false, reuse: false, headline: T.title, pages: [{ items }] };
  failed.add(root);
  return root;
}

export const isErrorScreen = (v: unknown): boolean => typeof v === "object" && v !== null && failed.has(v);

/**
 * V-40: данных экрана нет за срок (спец. §12) — S14 `KP-NET` «KinoPub не отвечает». `flag` — для `replace:` поздним
 * ответом: MSX заменит только этот экран.
 */
export function slowScreen(ctx: AppContext, dataId: string, flag: string): MsxContentRoot {
  return { ...errorScreen(ctx, new KpError("KP-NET", "deadline"), dataId, T.slow), flag };
}

export function placeholderScreen(ctx: AppContext, title: string): MsxContentRoot {
  return { type: "pages", headline: title, pages: [{ items: [{ type: "space", layout: "0,0,12,2", text: T.placeholder }] }] };
}
