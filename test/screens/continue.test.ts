import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { HistoryEntry, ItemSummary, ItemType, SerialWatching } from "../../src/api/models.ts";
import { Overlay } from "../../src/progress/overlay.ts";
import type { OverlayEntry, OverlayLookup } from "../../src/progress/overlay.ts";
import { buildContinue } from "../../src/screens/continue.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { FakeClock } from "../helpers/fake-clock.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

// «Продолжить просмотр» (Plan B §8.3.1, решение Р-21): история по порядку, оверлей ТВ главнее, если новее истории.

const POSTERS = { small: "s.jpg", medium: "m.jpg", big: "b.jpg" };
const HOUR = 3600;
/** `lastSeen` истории — Unix-секунды; `at` оверлея — миллисекунды эпохи. */
const SEEN = 1_767_225_600;

const none: OverlayLookup = () => undefined;

function summary(id: number, type: ItemType): ItemSummary {
  return { id, type, subtype: "", title: `Тайтл ${id} / Title ${id}`, genres: [], countries: [], quality: 1080, posters: POSTERS };
}

function entry(id: number, o: { type?: ItemType; s?: number; e?: number; time?: number; duration?: number; seen?: number } = {}): HistoryEntry {
  const duration = o.duration ?? 2 * HOUR;
  return {
    item: summary(id, o.type ?? "movie"), time: o.time ?? 0, lastSeen: o.seen ?? SEEN,
    media: { id: id * 1000 + (o.e ?? 1), number: o.e ?? 1, snumber: o.s ?? 0, title: "", duration },
  };
}

function serial(id: number, o: { total?: number; watched?: number; fresh?: number } = {}): SerialWatching {
  return { id, type: "serial", title: `Сериал ${id}`, posters: POSTERS, total: o.total ?? 10, watched: o.watched ?? 3, new: o.fresh ?? 0 };
}

function overlayOf(rows: [number, number, number, OverlayEntry][]): OverlayLookup {
  return (i, s, v) => rows.find(([a, b, c]) => a === i && b === s && c === v)?.[3];
}

describe("buildContinue: films (Plan B §8.3.1 п. 2)", () => {
  it("progress = time / duration, stamp with the remaining time, title and posters of the history item", () => {
    const [tile] = buildContinue([entry(1, { time: 1800, duration: 2 * HOUR })], [], [], none);
    assert.deepEqual(tile, {
      id: 1, type: "movie", title: "Тайтл 1 / Title 1", posters: POSTERS, progress: 0.25, stamp: "осталось 1 ч 30 мин",
    });
  });

  it("a film watched to 95 % is skipped, at 89 % it stays", () => {
    const h = [entry(1, { time: 0.95 * 6000, duration: 6000 }), entry(2, { time: 0.89 * 6000, duration: 6000 })];
    assert.deepEqual(buildContinue(h, [], [], none).map((t) => t.id), [2]);
  });

  it("documovie, concert and 3D are films too", () => {
    const h = [entry(1, { type: "documovie", time: 60 }), entry(2, { type: "concert", time: 60 }), entry(3, { type: "3D", time: 60 })];
    const out = buildContinue(h, [], [], none);
    assert.deepEqual(out.map((t) => t.id), [1, 2, 3]);
    for (const t of out) assert.ok(t.stamp !== undefined && t.tag === undefined);
  });

  it("only the first (latest) history entry of each title counts", () => {
    const h = [entry(1, { e: 2, time: 600 }), entry(1, { e: 1, time: 7000 }), entry(2, { time: 60 })];
    const out = buildContinue(h, [], [], none);
    assert.deepEqual(out.map((t) => t.id), [1, 2]);
    assert.equal(out[0]?.progress, 600 / (2 * HOUR));
  });

  it("no more than 15 titles", () => {
    const h = Array.from({ length: 20 }, (_, i) => entry(i + 1, { time: 60 }));
    const out = buildContinue(h, [], [], none);
    assert.equal(out.length, 15);
    assert.deepEqual(out.map((t) => t.id), h.slice(0, 15).map((e) => e.item.id));
  });
});

describe("buildContinue: TV overlay (спец. §10.2, Р-21)", () => {
  it("an overlay newer than history changes the progress and the stamp", () => {
    const ov = overlayOf([[1, 0, 1, { time: 3600, status: 0, at: (SEEN + 60) * 1000 }]]);
    const [tile] = buildContinue([entry(1, { time: 600 })], [], [], ov);
    assert.equal(tile?.progress, 0.5);
    assert.equal(tile?.stamp, "осталось 1 ч 00 мин");
  });

  it("an overlay older than history is ignored", () => {
    const ov = overlayOf([[1, 0, 1, { time: 3600, status: 0, at: (SEEN - 60) * 1000 }]]);
    assert.equal(buildContinue([entry(1, { time: 600 })], [], [], ov)[0]?.progress, 600 / (2 * HOUR));
  });

  it("the overlay looks up the unit of the history entry; a film marked watched on this TV is skipped", () => {
    const ov = overlayOf([[1, 0, 2, { time: 100, status: 1, at: (SEEN + 60) * 1000 }]]);
    assert.deepEqual(buildContinue([entry(1, { e: 2, time: 600 }), entry(2, { time: 60 })], [], [], ov).map((t) => t.id), [2]);
  });

  it("an overlay position past 90 % skips the film", () => {
    const ov = overlayOf([[1, 0, 1, { time: 0.92 * 2 * HOUR, status: 0, at: (SEEN + 1) * 1000 }]]);
    assert.deepEqual(buildContinue([entry(1, { time: 600 })], [], [], ov), []);
  });
});

describe("buildContinue: serials (Plan B §8.3.1 п. 3)", () => {
  it("tag S<season>E<episode> of the history entry, progress watched / total, badge +new", () => {
    const h = [entry(5, { type: "serial", s: 2, e: 5, time: 300 })];
    const [tile] = buildContinue(h, [serial(5, { total: 10, watched: 4, fresh: 3 })], [], none);
    assert.deepEqual(tile, {
      id: 5, type: "serial", title: "Тайтл 5 / Title 5", posters: POSTERS, progress: 0.4, tag: "S2E5", badge: "+3",
    });
  });

  it("docuserial and tvshow are serials; no badge without new episodes", () => {
    const h = [entry(5, { type: "docuserial", s: 1, e: 2 }), entry(6, { type: "tvshow", s: 1, e: 1 })];
    const out = buildContinue(h, [serial(5), serial(6)], [], none);
    assert.deepEqual(out.map((t) => [t.id, t.tag, t.badge]), [[5, "S1E2", undefined], [6, "S1E1", undefined]]);
  });

  it("fully watched without new episodes is skipped; fully watched with new ones stays", () => {
    const h = [entry(5, { type: "serial", s: 1, e: 10 }), entry(6, { type: "serial", s: 1, e: 10 })];
    const s = [serial(5, { total: 10, watched: 10 }), serial(6, { total: 10, watched: 10, fresh: 1 })];
    const out = buildContinue(h, s, [], none);
    assert.deepEqual(out.map((t) => [t.id, t.progress, t.badge]), [[6, 1, "+1"]]);
  });

  it("a serial missing from watching/serials is skipped", () => {
    assert.deepEqual(buildContinue([entry(5, { type: "serial", s: 1, e: 1 })], [serial(7)], [], none), []);
  });
});

describe("buildContinue: TV overlay on serials (спец. §10.2, Р-21)", () => {
  const h = [entry(5, { type: "serial", s: 1, e: 5 })];
  /** Оверлей ТВ, записи сделаны в `at` (мс эпохи); `forItem` отдаёт их по сезону и серии. */
  function tv(at: number, rows: [number, number, number, -1 | 0 | 1][]): (id: number) => ReturnType<Overlay["forItem"]> {
    const ov = new Overlay(new FakeClock(at));
    for (const [item, season, video, status] of rows) ov.set(item, season, video, { time: 100, status });
    return (id) => ov.forItem(id);
  }

  it("episodes marked on the TV after the history entry: tag of the furthest one, watched ones add to the progress", () => {
    const ov = tv((SEEN + 60) * 1000, [[5, 2, 1, 0], [5, 1, 6, 1], [5, 1, 7, 1], [6, 1, 9, 1]]);
    const [tile] = buildContinue(h, [serial(5, { total: 10, watched: 4 })], [], none, ov);
    assert.deepEqual([tile?.tag, tile?.progress], ["S2E1", 0.6]);
  });

  it("an overlay older than the history entry is ignored", () => {
    const ov = tv((SEEN - 60) * 1000, [[5, 1, 6, 1]]);
    const [tile] = buildContinue(h, [serial(5, { total: 10, watched: 4 })], [], none, ov);
    assert.deepEqual([tile?.tag, tile?.progress], ["S1E5", 0.4]);
  });

  it("the last episode watched on the TV skips a serial without new episodes; with new ones it stays", () => {
    const ov = tv((SEEN + 60) * 1000, [[5, 1, 10, 1], [6, 1, 10, 1]]);
    const hh = [entry(5, { type: "serial", s: 1, e: 9 }), entry(6, { type: "serial", s: 1, e: 9 })];
    const s = [serial(5, { total: 10, watched: 9 }), serial(6, { total: 10, watched: 9, fresh: 1 })];
    assert.deepEqual(buildContinue(hh, s, [], none, ov).map((t) => [t.id, t.tag, t.progress, t.badge]), [[6, "S1E10", 1, "+1"]]);
  });
});

describe("buildContinue: empty history (Plan B §8.3.1 п. 4)", () => {
  it("serials and movies in watching without progress", () => {
    const out = buildContinue([], [serial(5, { fresh: 2 }), serial(6)], [summary(7, "movie")], none);
    assert.deepEqual(out, [
      { id: 5, type: "serial", title: "Сериал 5", posters: POSTERS, badge: "+2" },
      { id: 6, type: "serial", title: "Сериал 6", posters: POSTERS },
      { id: 7, type: "movie", title: "Тайтл 7 / Title 7", posters: POSTERS },
    ]);
  });

  it("no more than 15 here as well", () => {
    const s = Array.from({ length: 10 }, (_, i) => serial(i + 1));
    const m = Array.from({ length: 10 }, (_, i) => summary(i + 100, "movie"));
    assert.equal(buildContinue([], s, m, none).length, 15);
  });
});

describe("buildContinue: kpmock fixtures", () => {
  let t: TestApp | undefined;
  after(async () => {
    await t?.close();
  });

  it("SERIAL_BIG: S1E4 from history, +2 new, 3 of its episodes watched; MOVIE_SIMPLE at 1200 of 5400 s, then SERIAL_SMALL", async () => {
    t = await createTestApp({ loggedIn: true });
    const { ctx } = t;
    const [h, s] = await t.run(Promise.all([ctx.repo.history(), ctx.repo.serials()]));
    const out = buildContinue(h.value, s.value, [], ctx.overlay.get);
    const big = out.find((x) => x.id === FIX.SERIAL_BIG);
    const w = s.value.find((x) => x.id === FIX.SERIAL_BIG);
    assert.ok(big && w);
    assert.equal(big.tag, "S1E4");
    assert.equal(big.badge, "+2");
    assert.equal(w.watched, 3);
    assert.equal(big.progress, 3 / w.total);
    const movie = out.find((x) => x.id === FIX.MOVIE_SIMPLE);
    assert.equal(movie?.stamp, "осталось 1 ч 10 мин");
    assert.equal(movie?.progress, 1200 / 5400);
    assert.deepEqual(out.map((x) => x.id), [FIX.SERIAL_BIG, FIX.MOVIE_SIMPLE, FIX.SERIAL_SMALL]);
  });
});
