import type { AppContext } from "../app/context.ts";
import { DeviceFlow } from "../auth/device-flow.ts";
import type { LoginState } from "../auth/device-flow.ts";
import { KpError } from "../core/errors.ts";
import type { KpErrorCode } from "../core/errors.ts";
import { fmtTime } from "../core/format.ts";
import { chain, commitMsg, contentAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { ids, msgs } from "../router/ids.ts";
import { RETRY_CONTENT, errorItems } from "./error.ts";

// Вход по коду S2 (спец. §7.1, §11; Plan B §8.3 S2). Опрос ведёт DeviceFlow по таймеру плагина;
// экран перерисовывается, только пока он текущий (спец. §6.3, CD-16).

const TAG = "login";
const FLAG = "login";
const DEFAULT_URI = "kino.watch/device";

const T = {
  headline: "Вход в KinoPub",
  steps: (uri: string): string => `1. Откройте на телефоне {txt:msx-white:${uri}}{br}2. Введите код:`,
  until: (hhmm: string): string => `Код действует до ${hhmm}`,
  newCode: "Новый код",
  probe: "Диагностика",
  codeFailed: "{ico:msx-yellow:warning} Не удалось получить код входа",
  done: "Вход выполнен",
  doneHeadline: "{ico:msx-green:check} Вход выполнен",
  doneText: "Если меню не обновилось, обновите его кнопкой ниже",
  reloadMenu: "Обновить меню",
};

/** `https://kino.watch/device` → `kino.watch/device`; фигурные скобки сломали бы выражение `{txt:…}`. */
function bareUri(uri: string): string {
  const s = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "").replace(/[{}]/g, "");
  return s !== "" ? s : DEFAULT_URI;
}

function screen(items: MsxContentItem[]): MsxContentRoot {
  return { type: "pages", flag: FLAG, cache: false, reuse: false, headline: T.headline, pages: [{ items }] };
}

function codeScreen(ctx: AppContext, st: Extract<LoginState, { phase: "code" }>): MsxContentRoot {
  return screen([
    { type: "space", layout: "0,0,12,2", text: T.steps(bareUri(st.verificationUri)) },
    { id: "login_code", type: "space", layout: "2,2,8,2", color: "msx-glass", alignment: "center", headline: st.userCode },
    { type: "space", layout: "0,4,12,1", alignment: "center", text: T.until(fmtTime(st.expiresAt)) },
    { type: "button", layout: "0,5,6,1", label: T.newCode, action: commitMsg(msgs.act("login", "new")) },
    { type: "button", layout: "6,5,6,1", label: T.probe, action: contentAction(ctx.P, ids.probe()) },
  ]);
}

/** Код не получен: «Повторить» перезапрашивает экран, а он начинает новый вход. */
function failedScreen(ctx: AppContext, code: KpErrorCode): MsxContentRoot {
  return screen(errorItems(ctx, new KpError(code, "login"), { retry: RETRY_CONTENT, offerLogin: false, headline: T.codeFailed }));
}

/** Вход уже выполнен (меню могло не успеть обновиться): новый код не запрашивается — он занял бы слот устройства. */
function doneScreen(ctx: AppContext): MsxContentRoot {
  return screen([
    { type: "space", layout: "0,0,12,4", headline: T.doneHeadline, text: T.doneText },
    { type: "button", layout: "0,5,6,1", label: T.reloadMenu, action: "reload:menu" },
    { type: "button", layout: "6,5,6,1", label: T.probe, action: contentAction(ctx.P, ids.probe()) },
  ]);
}

function onFlowChange(ctx: AppContext, flow: DeviceFlow, s: LoginState): void {
  if (s.phase === "done") {
    // Меню — не контент: обновляется всегда, на каком бы экране ни был пользователь (спец. §7.1 п. 4).
    ctx.host.executeAction(chain([`info:${T.done}`, "reload:menu"]));
    return;
  }
  if (ctx.state.login !== flow || !ctx.current.isCurrent(ids.login())) return;
  // Новый код или ошибка: экран перезапросит состояние входа.
  ctx.host.executeAction("reload:content");
}

/**
 * Текущий вход по коду: `code` и `idle` (код ещё запрашивается — второй запрос экрана получит тот же `start()`)
 * переиспользуются, иначе начинается новый.
 */
function ensureFlow(ctx: AppContext): DeviceFlow {
  const cur = ctx.state.login;
  const phase = cur?.state().phase;
  if (cur !== undefined && (phase === "code" || phase === "idle")) return cur;
  cur?.stop();
  const flow: DeviceFlow = new DeviceFlow({
    api: ctx.api, auth: ctx.auth, clock: ctx.clock, log: ctx.log,
    deviceTitle: async () => {
      const info = ctx.state.msxInfo;
      return `MSX ${info?.model ?? info?.platform ?? "TV"}`;
    },
    onChange: (s) => onFlowChange(ctx, flow, s),
  });
  ctx.state.login = flow;
  return flow;
}

export async function loginScreen(ctx: AppContext): Promise<MsxContentRoot> {
  if (ctx.auth.isLoggedIn()) return doneScreen(ctx);
  const st = await ensureFlow(ctx).start();
  switch (st.phase) {
    case "code":
      return codeScreen(ctx, st);
    case "done":
      return doneScreen(ctx);
    case "error":
      return failedScreen(ctx, st.code);
    case "idle":
      // Запрос кода перебит остановкой входа; «Повторить» начнёт новый.
      return failedScreen(ctx, "KP-BAD");
  }
}

export async function onLoginAct(ctx: AppContext, name: string, _args: string[]): Promise<void> {
  if (name !== "new") {
    ctx.log.warn(TAG, "unknown_act", { name });
    return;
  }
  const flow = ctx.state.login;
  if (flow === undefined || ctx.auth.isLoggedIn()) {
    // Плагин перезагружен (входа в памяти нет) или вход уже выполнен: экран сам покажет верное состояние.
    if (ctx.current.isCurrent(ids.login())) ctx.host.executeAction("reload:content");
    return;
  }
  await flow.renew();
}
