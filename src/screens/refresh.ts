import type { AppContext } from "../app/context.ts";
import { fnv1a } from "../core/hash.ts";

// Заглушка этапа 16; перерисовка персональных данных текущего экрана (спец. §6.3) — этап 24.

export interface RefreshSpec { dataId: string; flag: string; hash: string; recompute: () => Promise<string> }

export function scheduleRefresh(ctx: AppContext, spec: RefreshSpec): void {}

export function refreshAfterPlayback(ctx: AppContext, itemId: number): void {}

/** Хеш персональной части экрана (Plan B §7.7). */
export function personalHash(v: unknown): string {
  return fnv1a(JSON.stringify(v) ?? "");
}
