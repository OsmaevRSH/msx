import type { AppContext } from "../app/context.ts";
import type { PlaybackSession } from "./session.ts";

// Заглушка этапа 16; трекер событий плеера (спец. §10) — этап 19. Тип TrackerEvent уже окончательный (этап 19).

export type TrackerEvent =
  | { kind: "raw"; source: "handleEvent" | "handleData" | "timer"; name: string; position?: number }
  | { kind: "load"; s: PlaybackSession }
  | { kind: "started"; s: PlaybackSession; ttffMs?: number }
  | { kind: "pause" | "stop"; s: PlaybackSession; pos?: number }
  | { kind: "snapshot"; s: PlaybackSession; pos?: number }
  | { kind: "marktime"; s: PlaybackSession; time: number; ok: boolean }
  | { kind: "watched"; s: PlaybackSession; result: "done" | "queued" };

export class ProgressTracker {
  private ctx: AppContext;
  private listeners: ((e: TrackerEvent) => void)[] = [];

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /** `handleEvent` с `video:*`. */
  onEvent(ev: any): void {}

  /** `handleData` с `video` (`interaction:commit:video` из триггеров плеера). */
  onSnapshot(payload: any): void {}

  addListener(fn: (e: TrackerEvent) => void): void {
    this.listeners.push(fn);
  }

  session(): PlaybackSession | undefined {
    return undefined;
  }
}
