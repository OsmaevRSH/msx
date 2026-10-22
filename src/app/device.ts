import { deviceMismatch } from "../api/client.ts";
import type { DeviceForm, DeviceInfo } from "../api/models.ts";
import { KpError } from "../core/errors.ts";
import type { AppContext } from "./context.ts";

/**
 * Настройки своего устройства KinoPub (Plan B §6.2.1; SET-3): POST полной формой поверх `base` (кэш `device/info`), ссылки
 * на поток в кэше устаревают (Plan B §7.3), сверка свежим чтением по всем полям формы. Чтение не удалось — ошибка сети,
 * а не сверка с прежним значением. Отдельный модуль: его берут и «Настройки», и тест скорости CDN из probe.js — модуль
 * экрана в реестре probe.js замкнул бы цикл импортов, и app.js вырос бы на 1,4 КБ gzip.
 */
export async function saveDevice(ctx: AppContext, base: DeviceInfo, change: Partial<DeviceForm>): Promise<void> {
  const sent = await ctx.api.deviceSettingsSave(base, change);
  ctx.repo.invalidateAfterDevice();
  const got = await ctx.repo.deviceInfo({ fresh: true });
  if (got.offline !== undefined) throw new KpError(got.offline, "device-reread-failed");
  const keys = deviceMismatch(sent, got.value);
  if (keys.length > 0) throw new KpError("KP-BAD", "device-settings-mismatch", undefined, keys.join(","));
}
