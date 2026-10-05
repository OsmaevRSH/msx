import type { HistoryEntry, ItemSummary, ItemType, Posters, SerialWatching } from "../api/models.ts";
import type { OverlayLookup } from "../progress/overlay.ts";

// Заглушка этапа 16; «Продолжить просмотр» (Plan B §8.3.1) — этап 30.

export interface ContinueTile { id: number; type: ItemType; title: string; posters: Posters; progress?: number; tag?: string; badge?: string; stamp?: string }

export function buildContinue(h: HistoryEntry[], s: SerialWatching[], m: ItemSummary[], overlay: OverlayLookup): ContinueTile[] {
  return [];
}
