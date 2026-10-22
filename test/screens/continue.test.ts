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
/** Когда ТВ загрузил страницу истории (`fetchedAt`, часы ТВ): здесь — в момент `last_seen`, часы ТВ и KinoPub совпадают. */
const AT = SEEN * 1000;

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

/** Строка `watching/serials`. `new` у KinoPub — тот же остаток `total − watched` (QA-API-2), `fresh` — подменить его. */
function serial(id: number, o: { total?: number; watched?: number; fresh?: number } = {}): SerialWatching {
  const total = o.total ?? 10;
  const watched = o.watched ?? 3;
  return { id, type: "serial", title: `Сериал ${id}`, posters: POSTERS, total, watched, new: o.fresh ?? total - watched };
}

function overlayOf(rows: [number, number, number, OverlayEntry][]): OverlayLookup {
  return (i, s, v) => rows.find(([a, b, c]) => a === i && b === s && c === v)?.[3];
}

describe("buildContinue: films (Plan B §8.3.1 п. 2)", () => {
  it("progress = time / duration, stamp with the remaining time, title and posters of the history item", () => {
    const [tile] = buildContinue([entry(1, { time: 1800, duration: 2 * HOUR })], [], [], none, AT);
    assert.deepEqual(tile, {
      id: 1, type: "movie", title: "Тайтл 1 / Title 1", posters: POSTERS, progress: 0.25, stamp: "1 ч 30 м",
    });
  });

  it("QA-API-8: watched from 85 % of the runtime, as KinoPub marks it — 87 % and exactly 85 % are skipped, 84 % stays", () => {
    const h = [0.87, 0.85, 0.84].map((p, i) => entry(i + 1, { time: p * 6000, duration: 6000 }));
    assert.deepEqual(buildContinue(h, [], [], none, AT).map((t) => t.id), [3]);
  });

  it("documovie, concert and 3D are films too", () => {
    const h = [entry(1, { type: "documovie", time: 60 }), entry(2, { type: "concert", time: 60 }), entry(3, { type: "3D", time: 60 })];
    const out = buildContinue(h, [], [], none, AT);
    assert.deepEqual(out.map((t) => t.id), [1, 2, 3]);
    for (const t of out) assert.ok(t.stamp !== undefined && t.tag === undefined);
  });

  it("only the first (latest) history entry of each title counts", () => {
    const h = [entry(1, { e: 2, time: 600 }), entry(1, { e: 1, time: 7000 }), entry(2, { time: 60 })];
    const out = buildContinue(h, [], [], none, AT);
    assert.deepEqual(out.map((t) => t.id), [1, 2]);
    assert.equal(out[0]?.progress, 600 / (2 * HOUR));
  });

  it("no more than 15 titles", () => {
    const h = Array.from({ length: 20 }, (_, i) => entry(i + 1, { time: 60 }));
    const out = buildContinue(h, [], [], none, AT);
    assert.equal(out.length, 15);
    assert.deepEqual(out.map((t) => t.id), h.slice(0, 15).map((e) => e.item.id));
  });
});

describe("buildContinue: TV overlay (спец. §10.2, Р-21)", () => {
  it("an overlay newer than history changes the progress and the stamp", () => {
    const ov = overlayOf([[1, 0, 1, { time: 3600, status: 0, at: (SEEN + 60) * 1000 }]]);
    const [tile] = buildContinue([entry(1, { time: 600 })], [], [], ov, AT);
    assert.equal(tile?.progress, 0.5);
    assert.equal(tile?.stamp, "1 ч");
  });

  it("an overlay older than history is ignored", () => {
    const ov = overlayOf([[1, 0, 1, { time: 3600, status: 0, at: (SEEN - 60) * 1000 }]]);
    assert.equal(buildContinue([entry(1, { time: 600 })], [], [], ov, AT)[0]?.progress, 600 / (2 * HOUR));
  });

  it("the overlay looks up the unit of the history entry; a film marked watched on this TV is skipped", () => {
    const ov = overlayOf([[1, 0, 2, { time: 100, status: 1, at: (SEEN + 60) * 1000 }]]);
    assert.deepEqual(buildContinue([entry(1, { e: 2, time: 600 }), entry(2, { time: 60 })], [], [], ov, AT).map((t) => t.id), [2]);
  });

  it("the overlay against the fetch time of the history (both by the TV clock), not against `last_seen` of KinoPub", () => {
    // Часы ТВ отстают на 10 мин: позиция записана после загрузки истории — главнее, хотя её `at` раньше `last_seen`.
    const behind = overlayOf([[1, 0, 1, { time: 3600, status: 0, at: (SEEN - 300) * 1000 }]]);
    assert.equal(buildContinue([entry(1, { time: 600 })], [], [], behind, (SEEN - 600) * 1000)[0]?.progress, 0.5);
    // Часы ТВ спешат: позиция записана до загрузки истории — та её уже учла, хотя `at` позже `last_seen`.
    const ahead = overlayOf([[1, 0, 1, { time: 3600, status: 0, at: (SEEN + 600) * 1000 }]]);
    assert.equal(buildContinue([entry(1, { time: 600 })], [], [], ahead, (SEEN + 900) * 1000)[0]?.progress, 600 / (2 * HOUR));
  });

  it("an overlay position past 85 % skips the film (QA-API-8)", () => {
    const ov = overlayOf([[1, 0, 1, { time: 0.87 * 2 * HOUR, status: 0, at: (SEEN + 1) * 1000 }]]);
    assert.deepEqual(buildContinue([entry(1, { time: 600 })], [], [], ov, AT), []);
  });
});

describe("buildContinue: serials (Plan B §8.3.1 п. 3)", () => {
  it("tag «<season>×<episode>» of the history entry (V-18), progress watched / total, badge «+N» episodes left", () => {
    const h = [entry(5, { type: "serial", s: 2, e: 5, time: 300 })];
    const [tile] = buildContinue(h, [serial(5, { total: 10, watched: 7 })], [], none, AT);
    assert.deepEqual(tile, {
      id: 5, type: "serial", title: "Тайтл 5 / Title 5", posters: POSTERS, progress: 0.7, tag: "2×5", badge: "+3",
    });
  });

  it("QA-API-2: «+N» only for 1–5 episodes left (the serial is caught up), counted as total − watched, not from `new`", () => {
    const h = [1, 2, 3, 4].map((id) => entry(id, { type: "serial", s: 1, e: 1 }));
    const s = [serial(1, { total: 10, watched: 4 }), serial(2, { total: 10, watched: 5, fresh: 0 }), serial(3, { total: 10, watched: 9, fresh: 7 }),
      serial(4, { total: 0, watched: 3, fresh: 2 })];
    assert.deepEqual(buildContinue(h, s, [], none, AT).map((t) => [t.id, t.badge]), [[1, undefined], [2, "+5"], [3, "+1"], [4, undefined]]);
  });

  it("docuserial and tvshow are serials; no badge with 7 episodes left", () => {
    const h = [entry(5, { type: "docuserial", s: 1, e: 2 }), entry(6, { type: "tvshow", s: 1, e: 1 })];
    const out = buildContinue(h, [serial(5), serial(6)], [], none, AT);
    assert.deepEqual(out.map((t) => [t.id, t.tag, t.badge]), [[5, "1×2", undefined], [6, "1×1", undefined]]);
  });

  it("fully watched is skipped (whatever `new` says); a new episode out (total grew) — it stays with «+1»", () => {
    const h = [entry(5, { type: "serial", s: 1, e: 10 }), entry(6, { type: "serial", s: 1, e: 10 })];
    const s = [serial(5, { total: 10, watched: 10, fresh: 1 }), serial(6, { total: 11, watched: 10 })];
    const out = buildContinue(h, s, [], none, AT);
    assert.deepEqual(out.map((t) => [t.id, t.progress, t.badge]), [[6, 10 / 11, "+1"]]);
  });

  it("a serial missing from watching/serials with the episode of the history watched is finished — skipped", () => {
    const h = [entry(5, { type: "serial", s: 1, e: 1, time: 0.95 * 2 * HOUR })];
    assert.deepEqual(buildContinue(h, [serial(7, { total: 10, watched: 10 })], [], none, AT), []);
  });

  it("missing from watching/serials, the episode of the history not watched (QA-API-7): started — the tag, no progress", () => {
    const h = [entry(5, { type: "serial", s: 1, e: 2, time: 600 }), entry(6, { type: "serial", s: 1, e: 1, time: 0, duration: 0 })];
    assert.deepEqual(buildContinue(h, [], [], none, AT).map((t) => [t.id, t.tag, t.progress, t.badge]), [
      [5, "1×2", undefined, undefined], [6, "1×1", undefined, undefined],
    ]);
  });

  it("missing from watching/serials: the episode marked watched on the TV after the history entry — finished", () => {
    const ov = new Overlay(new FakeClock((SEEN + 60) * 1000));
    ov.set(5, 1, 2, { time: 100, status: 1 });
    assert.deepEqual(buildContinue([entry(5, { type: "serial", s: 1, e: 2, time: 600 })], [], [], none, AT, (id) => ov.forItem(id)), []);
  });

  it("watching/serials did not answer (undefined): serials of the history stay — tag, no progress, no badge; films as usual", () => {
    const h = [entry(5, { type: "serial", s: 2, e: 5 }), entry(1, { time: 1800, duration: 2 * HOUR }), entry(6, { type: "tvshow", s: 1, e: 3 })];
    const out = buildContinue(h, undefined, [], none, AT);
    assert.deepEqual(out.map((t) => [t.id, t.tag, t.progress, t.badge]), [
      [5, "2×5", undefined, undefined], [1, undefined, 0.25, undefined], [6, "1×3", undefined, undefined],
    ]);
  });

  it("watching/serials did not answer: an episode marked on the TV after the history entry still gives the tag", () => {
    const ov = new Overlay(new FakeClock((SEEN + 60) * 1000));
    ov.set(5, 1, 6, { time: 100, status: 1 });
    const [tile] = buildContinue([entry(5, { type: "serial", s: 1, e: 5 })], undefined, [], none, AT, (id) => ov.forItem(id));
    assert.deepEqual([tile?.tag, tile?.progress], ["1×6", undefined]);
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
    const [tile] = buildContinue(h, [serial(5, { total: 10, watched: 4 })], [], none, AT, ov);
    assert.deepEqual([tile?.tag, tile?.progress], ["2×1", 0.6]);
  });

  it("episodes marked on the TV against the fetch time of the history (TV clock), not against `last_seen`", () => {
    // ТВ отстаёт: отметка 1×6 после загрузки истории — тег и прогресс с ней; ТВ спешит: отметка до загрузки — без неё.
    const [a] = buildContinue(h, [serial(5, { total: 10, watched: 4 })], [], none, (SEEN - 600) * 1000, tv((SEEN - 300) * 1000, [[5, 1, 6, 1]]));
    assert.deepEqual([a?.tag, a?.progress], ["1×6", 0.5]);
    const [b] = buildContinue(h, [serial(5, { total: 10, watched: 5 })], [], none, (SEEN + 900) * 1000, tv((SEEN + 600) * 1000, [[5, 1, 6, 1]]));
    assert.deepEqual([b?.tag, b?.progress], ["1×5", 0.5]);
  });

  it("an overlay older than the history entry is ignored", () => {
    const ov = tv((SEEN - 60) * 1000, [[5, 1, 6, 1]]);
    const [tile] = buildContinue(h, [serial(5, { total: 10, watched: 4 })], [], none, AT, ov);
    assert.deepEqual([tile?.tag, tile?.progress], ["1×5", 0.4]);
  });

  it("the last episode watched on the TV skips a serial with nothing left; one more episode out — it stays, «+1» counts the TV", () => {
    const ov = tv((SEEN + 60) * 1000, [[5, 1, 10, 1], [6, 1, 10, 1]]);
    const hh = [entry(5, { type: "serial", s: 1, e: 9 }), entry(6, { type: "serial", s: 1, e: 9 })];
    const s = [serial(5, { total: 10, watched: 9 }), serial(6, { total: 11, watched: 9 })];
    assert.deepEqual(buildContinue(hh, s, [], none, AT, ov).map((t) => [t.id, t.tag, t.progress, t.badge]), [[6, "1×10", 10 / 11, "+1"]]);
  });
});

describe("buildContinue: empty history (Plan B §8.3.1 п. 4)", () => {
  it("serials and movies in watching without progress", () => {
    const out = buildContinue([], [serial(6), serial(5, { watched: 8 })], [summary(7, "movie")], none, AT);
    assert.deepEqual(out, [
      { id: 5, type: "serial", title: "Сериал 5", posters: POSTERS, badge: "+2" },
      { id: 6, type: "serial", title: "Сериал 6", posters: POSTERS },
      { id: 7, type: "movie", title: "Тайтл 7 / Title 7", posters: POSTERS },
    ]);
  });

  it("no more than 15 here as well", () => {
    const s = Array.from({ length: 10 }, (_, i) => serial(i + 1));
    const m = Array.from({ length: 10 }, (_, i) => summary(i + 100, "movie"));
    assert.equal(buildContinue([], s, m, none, AT).length, 15);
  });

  it("no history and no answer from watching/serials (undefined) — the movies", () => {
    assert.deepEqual(buildContinue([], undefined, [summary(7, "movie")], none, AT).map((t) => t.id), [7]);
  });
});

describe("buildContinue: titles of watching lists missing from the history page (QA-API-1)", () => {
  /** 50 строк истории — серии одного сериала: бинж недели вытеснил из страницы всё остальное. */
  const binge = (id: number, seen = SEEN): HistoryEntry[] =>
    Array.from({ length: 50 }, (_, i) => entry(id, { type: "serial", s: 1, e: 50 - i, time: 2 * HOUR, seen: seen - i * 60 }));

  it("after the history titles: unfinished serials by fewer episodes left (not by `new`, QA-API-2), then the started films", () => {
    const s = [serial(9, { total: 60, watched: 50 }), serial(7, { total: 200, watched: 3, fresh: 0 }), serial(8, { total: 6, watched: 1, fresh: 0 })];
    const out = buildContinue(binge(9), s, [summary(20, "movie")], none, AT);
    assert.deepEqual(out.map((t) => [t.id, t.tag, t.progress, t.badge]), [
      [9, "1×50", 50 / 60, undefined], [8, undefined, undefined, "+5"], [7, undefined, undefined, undefined], [20, undefined, undefined, undefined],
    ]);
  });

  it("the binge serial finished: the shelf is not empty — the other started titles stay (the whole shelf vanished before)", () => {
    const s = [serial(9, { total: 50, watched: 50 }), serial(7, { total: 10, watched: 4 })];
    assert.deepEqual(buildContinue(binge(9), s, [summary(20, "movie")], none, AT).map((t) => t.id), [7, 20]);
  });

  it("finished serials of the list and titles already in the history are not added again; a film skipped as watched stays skipped", () => {
    const h = [entry(20, { time: 0.95 * 6000, duration: 6000 }), entry(7, { type: "serial", s: 1, e: 5 })];
    const s = [serial(7), serial(8, { total: 10, watched: 10 }), serial(9, { total: 0, watched: 0 })];
    assert.deepEqual(buildContinue(h, s, [summary(20, "movie"), summary(21, "movie")], none, AT).map((t) => t.id), [7, 9, 21]);
  });

  it("no more than 15 with the lists", () => {
    const s = Array.from({ length: 20 }, (_, i) => serial(i + 100));
    assert.equal(buildContinue(binge(9), s, [], none, AT).length, 15);
  });
});

describe("buildContinue: kpmock fixtures", () => {
  let t: TestApp | undefined;
  after(async () => {
    await t?.close();
  });

  it("SERIAL_BIG: 1×4 from history, 3 of 200 watched — no badge; MOVIE_SIMPLE at 1200 of 5400 s, then SERIAL_SMALL with «+5»", async () => {
    t = await createTestApp({ loggedIn: true });
    const { ctx } = t;
    const [h, s, m] = await t.run(Promise.all([ctx.repo.history(), ctx.repo.serials(), ctx.repo.watchingMovies()]));
    const out = buildContinue(h.value, s.value, m.value, ctx.overlay.get, h.fetchedAt);
    const big = out.find((x) => x.id === FIX.SERIAL_BIG);
    const w = s.value.find((x) => x.id === FIX.SERIAL_BIG);
    assert.ok(big && w);
    assert.equal(big.tag, "1×4");
    assert.equal(big.badge, undefined);
    assert.equal(w.watched, 3);
    assert.equal(big.progress, 3 / w.total);
    const movie = out.find((x) => x.id === FIX.MOVIE_SIMPLE);
    assert.equal(movie?.stamp, "1 ч 10 м");
    assert.equal(movie?.progress, 1200 / 5400);
    assert.deepEqual(out.map((x) => x.id), [FIX.SERIAL_BIG, FIX.MOVIE_SIMPLE, FIX.SERIAL_SMALL]);
    assert.equal(out[2]?.badge, "+5");
  });
});
