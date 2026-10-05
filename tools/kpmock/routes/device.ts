import { HttpError, requireAuth } from "../router.ts";
import type { HandlerCtx, MockResponse, Router } from "../router.ts";
import type { DeviceRec, MockState } from "../state.ts";
import { param } from "./oauth.ts";
import { SERVER_LOCATIONS, STREAMING_TYPES } from "./user.ts";

// Устройство KinoPub (research kinopub-api §5; Plan B §12.3). POST-тело с неверным Content-Type
// молча игнорируется с ответом {"status":200} — ловушка Apple (спец. §14.2); параметры в query принимаются.

const BOOL_SETTINGS: readonly [key: string, label: string][] = [
  ["supportSsl", "Use SSL"], ["supportHevc", "HEVC"], ["supportHdr", "HDR"], ["support4k", "4K"], ["mixedPlaylist", "Mixed playlist"],
];
// Списочные настройки хранятся как выбранный id; у реального API они приходят массивом с флагом selected.
const LIST_SETTINGS = [
  { key: "streamingType", label: "Streaming type", def: 4, options: () => STREAMING_TYPES.map((t) => ({ id: t.id, label: t.name, description: t.description })) },
  { key: "serverLocation", label: "Server location", def: 1, options: () => SERVER_LOCATIONS.map((l) => ({ id: l.id, label: l.name, description: "" })) },
];

const OK: MockResponse = { status: 200, json: { status: 200 } };
const nowSec = (): number => Math.floor(Date.now() / 1000);

function settingsJson(d: DeviceRec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, label] of BOOL_SETTINGS) out[key] = { label, value: d.settings[key] ?? 0, type: "bool" };
  for (const ls of LIST_SETTINGS) {
    const sel = d.settings[ls.key] ?? ls.def;
    out[ls.key] = { label: ls.label, type: "list", value: ls.options().map((o) => ({ ...o, selected: o.id === sel ? 1 : 0 })) };
  }
  return out;
}

/** Применяет только допустимые значения: bool — "0"/"1", списки — известный id. */
function applySettings(ctx: HandlerCtx, d: DeviceRec): void {
  for (const [key] of BOOL_SETTINGS) {
    const v = param(ctx, key);
    if (v === "0" || v === "1") d.settings[key] = Number(v);
  }
  for (const ls of LIST_SETTINGS) {
    const id = Number(param(ctx, ls.key));
    if (ls.options().some((o) => o.id === id)) d.settings[ls.key] = id;
  }
}

export function register(r: Router, s: MockState, base: () => string): void {
  // Время последнего изменения устройства (в DeviceRec его нет); id монотонны, поэтому reset() не мешает.
  const updatedAt = new Map<number, number>();

  const deviceJson = (id: number, d: DeviceRec): Record<string, unknown> => ({
    id, title: d.title, hardware: d.hardware, software: d.software,
    created: d.createdAt, updated: updatedAt.get(id) ?? d.createdAt, last_seen: nowSec(), is_browser: false,
    settings: settingsJson(d),
  });

  const own = (ctx: HandlerCtx): { id: number; d: DeviceRec } => {
    const { deviceId } = requireAuth(ctx);
    const d = ctx.state.devices.get(deviceId);
    if (!d) throw new HttpError(404, { status: 404, error: "Not found" });
    return { id: deviceId, d };
  };

  const byParam = (ctx: HandlerCtx): { id: number; d: DeviceRec } => {
    requireAuth(ctx);
    const id = Number(ctx.params.id);
    const d = Number.isInteger(id) ? ctx.state.devices.get(id) : undefined;
    if (!d) throw new HttpError(404, { status: 404, error: "Not found" });
    return { id, d };
  };

  r.add("POST", "/v1/device/notify", (ctx) => {
    const { id, d } = own(ctx);
    let changed = false;
    for (const key of ["title", "hardware", "software"] as const) {
      const v = param(ctx, key);
      if (v !== undefined) {
        d[key] = v;
        changed = true;
      }
    }
    if (changed) updatedAt.set(id, nowSec());
    return OK;
  });

  r.add("GET", "/v1/device/info", (ctx) => {
    const { id, d } = own(ctx);
    return { status: 200, json: { status: 200, device: deviceJson(id, d) } };
  });

  r.add("GET", "/v1/device", (ctx) => {
    requireAuth(ctx);
    const devices = [...ctx.state.devices].map(([id, d]) => deviceJson(id, d));
    return { status: 200, json: { status: 200, devices } };
  });

  r.add("GET", "/v1/device/:id/settings", (ctx) => {
    const { d } = byParam(ctx);
    return { status: 200, json: { status: 200, settings: settingsJson(d) } };
  });

  r.add("POST", "/v1/device/:id/settings", (ctx) => {
    const { id, d } = byParam(ctx);
    applySettings(ctx, d);
    updatedAt.set(id, nowSec());
    return OK;
  });

  r.add("POST", "/v1/device/unlink", (ctx) => {
    const { deviceId } = requireAuth(ctx);
    ctx.state.devices.delete(deviceId);
    for (const [access, rec] of ctx.state.tokens) {
      if (rec.deviceId !== deviceId) continue;
      ctx.state.tokens.delete(access);
      ctx.state.refreshTokens.delete(rec.refresh);
    }
    return OK;
  });
}
