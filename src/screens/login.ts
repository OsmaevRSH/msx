import type { AppContext } from "../app/context.ts";
import { DeviceFlow } from "../auth/device-flow.ts";
import type { LoginState } from "../auth/device-flow.ts";
import { KpError } from "../core/errors.ts";
import type { KpErrorCode } from "../core/errors.ts";
import { fmtTime } from "../core/format.ts";
import { commitMsg, contentAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { ids, msgs } from "../router/ids.ts";
import { RETRY_CONTENT, errorItems } from "./error.ts";
import { toMenu } from "./menu.ts";

// Вход по коду S2 (спец. §7.1, §11; Plan B §8.3 S2). Опрос ведёт DeviceFlow по таймеру плагина;
// экран перерисовывается, только пока он текущий (спец. §6.3, CD-16).

const TAG = "login";
const FLAG = "login";
const DEFAULT_URI = "kino.watch/device";

const T = {
  headline: "Вход в KinoPub",
  steps: (uri: string): string => `{col:msx-white}1. Откройте на телефоне ${uri}{br}2. Введите код:`,
  until: (hhmm: string): string => `{col:msx-white}Код действует до ${hhmm}`,
  check: "Проверить сейчас",
  pending: "Код ещё не подтверждён",
  checkFailed: "Не удалось проверить, повторю через несколько секунд",
  newCode: "Новый код",
  probe: "Диагностика",
  codeFailed: "{ico:msx-yellow:warning} Не удалось получить код входа",
  done: "Вход выполнен",
  doneHeadline: "{ico:msx-green:check} Вход выполнен",
  doneText: "Если меню не обновилось, обновите его кнопкой ниже",
  reloadMenu: "Обновить меню",
};

/** `https://kino.watch/device` → `kino.watch/device`; фигурные скобки MSX счёл бы своим выражением. */
function bareUri(uri: string): string {
  const s = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "").replace(/[{}]/g, "");
  return s !== "" ? s : DEFAULT_URI;
}

/**
 * Код входа картинкой (V-01): у текста MSX нет размера шрифта, а код читают с дивана. SVG рисуется MSX как `<img>`
 * (web MSX 0.1.167); ширина растёт с длиной кода, `imageFiller: "fit"` вписывает её в плитку.
 */
function codeImage(code: string): string {
  const text = code.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const w = Math.max(900, code.length * 112);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 220"><text x="50%" y="50%" dominant-baseline="central" ` +
    `text-anchor="middle" font-family="Roboto,Arial,sans-serif" font-size="150" font-weight="500" letter-spacing="18" fill="#fff">${text}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function screen(items: MsxContentItem[]): MsxContentRoot {
  return { type: "pages", flag: FLAG, cache: false, reuse: false, headline: T.headline, pages: [{ items }] };
}

function codeScreen(ctx: AppContext, st: Extract<LoginState, { phase: "code" }>): MsxContentRoot {
  return screen([
    { type: "space", layout: "0,0,12,2", text: T.steps(bareUri(st.verificationUri)) },
    { id: "login_code", type: "space", layout: "2,2,8,2", color: "msx-glass", image: codeImage(st.userCode), imageFiller: "fit" },
    { type: "space", layout: "0,4,12,1", alignment: "center", text: T.until(fmtTime(st.expiresAt)) },
    // Первой и в фокусе — безопасная проверка: OK по привычке не должен менять код, пока его вводят (V-02).
    { type: "button", layout: "0,5,4,1", label: T.check, action: commitMsg(msgs.act("login", "check")), focus: true },
    { type: "button", layout: "4,5,4,1", label: T.newCode, action: commitMsg(msgs.act("login", "new")) },
    { type: "button", layout: "8,5,4,1", label: T.probe, action: contentAction(ctx.P, ids.probe()) },
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
    { type: "button", layout: "0,5,6,1", label: T.reloadMenu, action: toMenu(ctx.P, T.done) },
    { type: "button", layout: "6,5,6,1", label: T.probe, action: contentAction(ctx.P, ids.probe()) },
  ]);
}

function onFlowChange(ctx: AppContext, flow: DeviceFlow, s: LoginState): void {
  if (s.phase === "done") {
    // Меню — не контент: обновляется всегда, на каком бы экране ни был пользователь (спец. §7.1 п. 4; X-3).
    ctx.host.executeAction(toMenu(ctx.P, T.done));
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

/** `act:login:new` — новый код; `act:login:check` — опрос сразу, с откликом, если код ещё не подтверждён. */
export async function onLoginAct(ctx: AppContext, name: string, _args: string[]): Promise<void> {
  if (name !== "new" && name !== "check") {
    ctx.log.warn(TAG, "unknown_act", { name });
    return;
  }
  const flow = ctx.state.login;
  if (flow === undefined || ctx.auth.isLoggedIn()) {
    // Плагин перезагружен (входа в памяти нет) или вход уже выполнен: экран сам покажет верное состояние.
    if (ctx.current.isCurrent(ids.login())) ctx.host.executeAction("reload:content");
    return;
  }
  if (name === "new") {
    await flow.renew();
    return;
  }
  const r = await flow.checkNow();
  if (r !== undefined) ctx.host.executeAction(`info:${r === "pending" ? T.pending : T.checkFailed}`);
}
