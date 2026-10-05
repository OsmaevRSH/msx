import type { Clock } from "../core/clock.ts";

export interface OverlayEntry {
  time: number;
  status: -1 | 0 | 1;
  at: number;
}
export type OverlayLookup = (itemId: number, season: number, video: number) => OverlayEntry | undefined;

type Status = OverlayEntry["status"];
interface Stored extends OverlayEntry {
  itemId: number;
  season: number;
  video: number;
}
// Формат kp.out.overlay: кортежи [item, season, video, time, status, at] — компактно для хранилища ТВ.
type Row = [number, number, number, number, Status, number];

const DAY_MS = 24 * 3_600_000;
const FORMAT = 1;

const isInt = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min;
const isStatus = (v: unknown): v is Status => v === -1 || v === 0 || v === 1;

/**
 * Последние позиции и статусы, известные ТВ (спец. §10.2, Plan B §9.1): экраны показывают их сразу,
 * пока KinoPub и кэш карточки не догнали. Запись живёт 24 ч; `at` — `clock.now()`, чтобы сравнивать
 * с `fetchedAt` карточки и переживать перезапуск.
 */
export class Overlay {
  private clock: Clock;
  private entries = new Map<string, Stored>();

  constructor(clock: Clock) {
    this.clock = clock;
  }

  set(itemId: number, season: number, video: number, e: { time: number; status: -1 | 0 | 1 }): void {
    this.entries.set(keyOf(itemId, season, video), { itemId, season, video, time: e.time, status: e.status, at: this.clock.now() });
  }

  /** Поле, а не метод: передаётся как `OverlayLookup` без `bind`. */
  get: OverlayLookup = (itemId, season, video) => {
    const e = this.entries.get(keyOf(itemId, season, video));
    return e && this.fresh(e, DAY_MS) ? { time: e.time, status: e.status, at: e.at } : undefined;
  };

  forItem(itemId: number): (OverlayEntry & { season: number; video: number })[] {
    const out: (OverlayEntry & { season: number; video: number })[] = [];
    for (const e of this.entries.values()) {
      if (e.itemId === itemId && this.fresh(e, DAY_MS)) {
        out.push({ season: e.season, video: e.video, time: e.time, status: e.status, at: e.at });
      }
    }
    return out.sort((a, b) => a.season - b.season || a.video - b.video);
  }

  prune(maxAgeMs: number = DAY_MS): void {
    for (const [key, e] of this.entries) {
      if (!this.fresh(e, maxAgeMs)) this.entries.delete(key);
    }
  }

  serialize(): string {
    this.prune();
    const rows: Row[] = [];
    for (const e of this.entries.values()) rows.push([e.itemId, e.season, e.video, e.time, e.status, e.at]);
    return JSON.stringify({ v: FORMAT, e: rows });
  }

  /** Битые данные и чужой формат молча игнорируются: оверлей — только ускоритель, источник истины — KinoPub. */
  load(json: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return;
    }
    const doc = parsed as { v?: unknown; e?: unknown } | null;
    if (typeof doc !== "object" || doc === null || doc.v !== FORMAT || !Array.isArray(doc.e)) return;
    for (const row of doc.e) {
      const e = storedFrom(row);
      if (!e || !this.fresh(e, DAY_MS)) continue;
      const key = keyOf(e.itemId, e.season, e.video);
      const cur = this.entries.get(key);
      if (!cur || cur.at < e.at) this.entries.set(key, e);
    }
  }

  private fresh(e: OverlayEntry, maxAgeMs: number): boolean {
    return this.clock.now() - e.at <= maxAgeMs;
  }
}

function keyOf(itemId: number, season: number, video: number): string {
  return `${itemId}_${season}_${video}`;
}

function storedFrom(row: unknown): Stored | undefined {
  if (!Array.isArray(row) || row.length !== 6) return undefined;
  const [itemId, season, video, time, status, at] = row as unknown[];
  if (!isInt(itemId, 1) || !isInt(season, 0) || !isInt(video, 1)) return undefined;
  if (typeof time !== "number" || !Number.isFinite(time) || time < 0) return undefined;
  if (!isStatus(status) || typeof at !== "number" || !Number.isFinite(at)) return undefined;
  return { itemId, season, video, time, status, at };
}
