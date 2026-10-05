import type { HandlerCtx, MockResponse, Router } from "../router.ts";
import type { MockState } from "../state.ts";

// OAuth2 device flow и refresh (спец. §7.1, §7.3; research kinopub-api §4; Plan B §12.3).

/** Публичная пара неофициальных клиентов KinoPub (research kinopub-api §4.1); не секрет. */
export const MOCK_CLIENT = { id: "xbmc", secret: "cgg3gtifu46urtfp2zp1nqtba0k2ezxh" } as const;
const VERIFICATION_URI = "https://kino.watch/device";
const CODE_TTL_SEC = 600;
const USER_CODE_SPACE = 26 ** 6;

/** Параметр из тела (только при верном Content-Type — ловушка Apple) или из query. */
export function param(ctx: HandlerCtx, key: string): string | undefined {
  return ctx.form?.get(key) ?? ctx.query.get(key) ?? undefined;
}

const oauthError = (error: string, description: string): MockResponse =>
  ({ status: 400, json: { error, error_description: description } });

function tokenResponse(pair: { access: string; refresh: string }, ttlSec: number): MockResponse {
  return { status: 200, json: { access_token: pair.access, token_type: "bearer", expires_in: ttlSec, refresh_token: pair.refresh, scope: null } };
}

/** 6 заглавных латинских букв, однозначно от n (умножение на простое по модулю 26^6 — биекция). */
function userCode(n: number): string {
  let x = (n * 7919) % USER_CODE_SPACE;
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += String.fromCharCode(65 + (x % 26));
    x = Math.floor(x / 26);
  }
  return out;
}

function clientOk(ctx: HandlerCtx): boolean {
  return param(ctx, "client_id") === MOCK_CLIENT.id && param(ctx, "client_secret") === MOCK_CLIENT.secret;
}

function issueDeviceCode(ctx: HandlerCtx): MockResponse {
  const n = ctx.state.nextId();
  const code = `mock-dc-${n}`;
  const uc = userCode(n);
  ctx.state.deviceCodes.set(code, { userCode: uc, polls: 0, expiresAt: Date.now() + CODE_TTL_SEC * 1000 });
  // interval строкой, как в фикстурах Kodi: проверка толерантного разбора (research kinopub-api §3).
  return { status: 200, json: { code, user_code: uc, verification_uri: VERIFICATION_URI, expires_in: CODE_TTL_SEC, interval: "5" } };
}

/** Опрос: pending первые `pendingPolls` раз, особые ответы на заданных номерах опроса, затем пара и новое устройство. */
function pollDeviceToken(ctx: HandlerCtx): MockResponse {
  const { state, scenario } = ctx;
  const code = param(ctx, "code");
  if (!code) return oauthError("invalid_request", "code is required");
  const rec = state.deviceCodes.get(code);
  if (!rec || rec.expiresAt <= Date.now()) {
    state.deviceCodes.delete(code);
    return oauthError("code_expired", "The device code has expired.");
  }
  rec.polls += 1;
  if (rec.polls === scenario.codeExpiredAtPoll) {
    state.deviceCodes.delete(code);
    return oauthError("code_expired", "The device code has expired.");
  }
  if (rec.polls === scenario.slowDownAtPoll) return oauthError("slow_down", "Polling too frequently.");
  if (rec.polls <= scenario.pendingPolls) return oauthError("authorization_pending", "The user has not yet entered the code.");
  state.deviceCodes.delete(code);
  // Без device/notify устройство в аккаунте выглядит как «unknown» (research kinopub-api §4.4).
  const deviceId = state.createDevice({ title: "unknown", hardware: "unknown", software: "unknown" });
  return tokenResponse(state.issueToken(deviceId, scenario.accessTtlSec), scenario.accessTtlSec);
}

/** Ротация: старые access и refresh недействительны сразу (research kinopub-api §4.5). */
function refreshPair(ctx: HandlerCtx): MockResponse {
  const { state, scenario } = ctx;
  const refresh = param(ctx, "refresh_token") ?? "";
  const access = state.refreshTokens.get(refresh);
  const rec = access === undefined ? undefined : state.tokens.get(access);
  if (scenario.refreshInvalid || access === undefined || !rec || !state.devices.has(rec.deviceId)) {
    return oauthError("invalid_refresh_token", "The refresh token is invalid.");
  }
  state.tokens.delete(access);
  state.refreshTokens.delete(refresh);
  return tokenResponse(state.issueToken(rec.deviceId, scenario.accessTtlSec), scenario.accessTtlSec);
}

export function register(r: Router, s: MockState, base: () => string): void {
  r.add("POST", "/oauth2/device", (ctx) => {
    if (!clientOk(ctx)) return oauthError("invalid_client", "Client authentication failed.");
    switch (param(ctx, "grant_type")) {
      case "device_code": return issueDeviceCode(ctx);
      case "device_token": return pollDeviceToken(ctx);
      case "refresh_token": return refreshPair(ctx);
      default: return oauthError("unsupported_grant_type", "The grant type is not supported.");
    }
  });

  r.add("POST", "/oauth2/token", (ctx) => {
    if (!clientOk(ctx)) return oauthError("invalid_client", "Client authentication failed.");
    if (param(ctx, "grant_type") !== "refresh_token") return oauthError("unsupported_grant_type", "The grant type is not supported.");
    return refreshPair(ctx);
  });
}
