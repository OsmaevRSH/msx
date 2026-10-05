import type { AppContext } from "../app/context.ts";
import type { MsxResolveResponse } from "../msx/types.ts";
import type { TrackerEvent } from "../progress/tracker.ts";
import type { PlayRoute } from "../router/ids.ts";

// Заглушка этапа 16; resolve (спец. §9.1–9.2) — этап 18.

export async function resolvePlay(ctx: AppContext, r: PlayRoute): Promise<MsxResolveResponse> {
  return { error: "Не реализовано" };
}

/** Подписан на `ProgressTracker` в `createApp`: `started` → `chain.markStarted` и префетч ссылок следующей серии. */
export function onTrackerEvent(ctx: AppContext, ev: TrackerEvent): void {}
