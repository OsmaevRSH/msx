import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ItemDetail, MediaUnit, Season, WatchState } from "../../src/api/models.ts";
import { isKpError } from "../../src/core/errors.ts";
import type { OverlayEntry, OverlayLookup } from "../../src/progress/overlay.ts";
import {
  continueTarget,
  findUnit,
  mainButtonLabel,
  mergedState,
  neighbours,
  orderedUnits,
  startPosition,
  type EpRef,
} from "../../src/playback/episodes.ts";

const ID = 8632;
const NONE: WatchState = { status: -1, time: 0 };
const DONE: WatchState = { status: 1, time: 0 };
const at = (time: number): WatchState => ({ status: 0, time });

function unit(mid: number, number: number, snumber: number, watching: WatchState = NONE, duration = 2700): MediaUnit {
  return { id: mid, number, snumber, title: `E${number}`, duration, audios: [], files: [], subtitles: [], watching };
}

function item(over: Partial<ItemDetail>): ItemDetail {
  return {
    id: ID,
    type: "serial",
    subtype: "",
    title: "Черное зеркало / Black Mirror",
    genres: [],
    countries: [],
    quality: 1080,
    posters: { small: "s", medium: "m", big: "b" },
    videos: [],
    seasons: [],
    bookmarks: [],
    ...over,
  };
}

/** Сериал: сезон n → состояния серий по порядку; mid = 1000·сезон + серия. */
function serial(spec: Record<number, WatchState[]>, order?: number[]): ItemDetail {
  const numbers = order ?? Object.keys(spec).map(Number);
  const seasons: Season[] = numbers.map((n) => ({
    id: 50 + n,
    number: n,
    title: "",
    episodes: (spec[n] ?? []).map((w, i) => unit(1000 * n + i + 1, i + 1, n, w)),
  }));
  return item({ seasons });
}

function movie(parts: WatchState[], duration = 6000): ItemDetail {
  return item({ type: "movie", videos: parts.map((w, i) => unit(48967 + i, i + 1, 0, w, duration)) });
}

const ref = (season: number, video: number, mid = 1000 * season + video): EpRef => ({ itemId: ID, mid, season, video });
const tags = (refs: (EpRef | undefined)[]): (string | undefined)[] => refs.map((r) => (r ? `S${r.season}E${r.video}#${r.mid}` : undefined));

function overlayOf(entries: Record<string, OverlayEntry>): OverlayLookup {
  return (itemId, season, video) => entries[`${itemId}_${season}_${video}`];
}

describe("orderedUnits", () => {
  it("orders seasons and episodes by number", () => {
    const it2 = serial({ 2: [NONE, NONE], 1: [NONE, NONE] }, [2, 1]);
    it2.seasons[0]!.episodes.reverse();
    assert.deepEqual(tags(orderedUnits(it2)), ["S1E1#1001", "S1E2#1002", "S2E1#2001", "S2E2#2002"]);
    assert.deepEqual(orderedUnits(it2)[0], ref(1, 1));
  });

  it("lists film parts as season 0 by video number", () => {
    const m = movie([NONE, NONE, NONE]);
    m.videos.reverse();
    assert.deepEqual(
      orderedUnits(m).map((r) => [r.season, r.video, r.mid]),
      [
        [0, 1, 48967],
        [0, 2, 48968],
        [0, 3, 48969],
      ],
    );
  });

  it("is empty for an item without videos", () => {
    assert.deepEqual(orderedUnits(item({})), []);
  });
});

describe("findUnit", () => {
  it("finds a unit and its ref by mid", () => {
    const s = serial({ 1: [NONE, at(100)] });
    const found = findUnit(s, 1002);
    assert.equal(found?.unit, s.seasons[0]!.episodes[1]);
    assert.deepEqual(found?.ref, ref(1, 2));
    assert.equal(findUnit(s, 999), undefined);
  });
});

describe("neighbours", () => {
  const s = serial({ 1: Array.from({ length: 20 }, () => NONE), 2: [NONE, NONE, NONE] });

  it("crosses the season boundary: S1E20 → S2E1 and back", () => {
    assert.deepEqual(tags([neighbours(s, 1020).prev, neighbours(s, 1020).next]), ["S1E19#1019", "S2E1#2001"]);
    assert.deepEqual(tags([neighbours(s, 2001).prev, neighbours(s, 2001).next]), ["S1E20#1020", "S2E2#2002"]);
  });

  it("has no prev for the first episode and no next for the last", () => {
    assert.deepEqual(neighbours(s, 1001), { next: ref(1, 2) });
    assert.deepEqual(neighbours(s, 2003), { prev: ref(2, 2) });
  });

  it("walks film parts", () => {
    const m = movie([NONE, NONE, NONE]);
    assert.deepEqual(neighbours(m, 48968), { prev: { itemId: ID, mid: 48967, season: 0, video: 1 }, next: { itemId: ID, mid: 48969, season: 0, video: 3 } });
    assert.deepEqual(neighbours(movie([NONE]), 48967), {});
  });

  it("returns nothing for an unknown mid", () => {
    assert.deepEqual(neighbours(s, 7), {});
  });
});

describe("mergedState", () => {
  const s = serial({ 1: [at(600)] });
  const CARD_AT = 1_000_000;

  it("takes the card state without an overlay entry", () => {
    assert.deepEqual(mergedState(s, ref(1, 1)), { status: 0, time: 600 });
    assert.deepEqual(mergedState(s, ref(1, 1), overlayOf({}), CARD_AT), { status: 0, time: 600 });
  });

  it("takes the overlay when it is newer than the card", () => {
    const o = overlayOf({ [`${ID}_1_1`]: { time: 1500, status: 0, at: CARD_AT + 1 } });
    assert.deepEqual(mergedState(s, ref(1, 1), o, CARD_AT), { status: 0, time: 1500 });
  });

  it("keeps the card when the overlay is not newer", () => {
    const o = overlayOf({ [`${ID}_1_1`]: { time: 1500, status: 0, at: CARD_AT } });
    assert.deepEqual(mergedState(s, ref(1, 1), o, CARD_AT), { status: 0, time: 600 });
  });

  it("takes the overlay when the card time is unknown", () => {
    const o = overlayOf({ [`${ID}_1_1`]: { time: 2650, status: 1, at: 5 } });
    assert.deepEqual(mergedState(s, ref(1, 1), o), { status: 1, time: 2650 });
  });

  it("returns a copy, not the card object", () => {
    const st = mergedState(s, ref(1, 1));
    st.time = 1;
    assert.equal(s.seasons[0]!.episodes[0]!.watching.time, 600);
  });
});

describe("startPosition", () => {
  const D = 2700;

  it("resumes 3 s before the saved time", () => {
    assert.equal(startPosition(at(1200), D), 1197);
    assert.equal(startPosition(at(30), D), 27);
    assert.equal(startPosition(at(D - 60), D), D - 63);
  });

  it("starts from the beginning by the Plan B §9.7 table", () => {
    assert.equal(startPosition(at(29), D), "none");
    assert.equal(startPosition(at(D - 59), D), "none");
    assert.equal(startPosition({ status: 1, time: 1200 }, D), "none");
    assert.equal(startPosition(at(1200), D, true), "none");
  });

  it("ignores the end rule when the duration is unknown", () => {
    assert.equal(startPosition(at(1200), 0), 1197);
  });

  it("drops fractions of a second", () => {
    assert.equal(startPosition(at(1200.7), D), 1197);
  });
});

describe("continueTarget", () => {
  it("nothing watched → S1E1 from the start", () => {
    assert.deepEqual(continueTarget(serial({ 1: [NONE, NONE], 2: [NONE] })), { ref: ref(1, 1), position: "none", again: false });
  });

  it("last started episode with status 0 → it from time − 3", () => {
    const s = serial({ 1: [DONE, at(600), NONE], 2: [NONE] });
    assert.deepEqual(continueTarget(s), { ref: ref(1, 2), position: 597, again: false });
  });

  it("takes the last episode in order, not the first started one", () => {
    const s = serial({ 1: [at(900), DONE, at(40)], 2: [NONE] });
    assert.deepEqual(continueTarget(s), { ref: ref(1, 3), position: 37, again: false });
  });

  it("last episode watched → the next one from the start, across the season boundary", () => {
    assert.deepEqual(continueTarget(serial({ 1: [DONE, DONE, NONE] })), { ref: ref(1, 3), position: "none", again: false });
    assert.deepEqual(continueTarget(serial({ 1: [DONE, DONE], 2: [NONE, NONE] })), { ref: ref(2, 1), position: "none", again: false });
  });

  it("everything watched → S1E1 again", () => {
    assert.deepEqual(continueTarget(serial({ 1: [DONE, DONE], 2: [DONE] })), { ref: ref(1, 1), position: "none", again: true });
  });

  it("an overlay newer than the card wins", () => {
    const s = serial({ 1: [DONE, at(600), NONE] });
    const fresh = overlayOf({ [`${ID}_1_2`]: { time: 2650, status: 1, at: 2000 } });
    assert.deepEqual(continueTarget(s, fresh, 1000), { ref: ref(1, 3), position: "none", again: false });
    const ahead = overlayOf({ [`${ID}_1_3`]: { time: 300, status: 0, at: 2000 } });
    assert.deepEqual(continueTarget(s, ahead, 1000), { ref: ref(1, 3), position: 297, again: false });
    const stale = overlayOf({ [`${ID}_1_2`]: { time: 2650, status: 1, at: 500 } });
    assert.deepEqual(continueTarget(s, stale, 1000), { ref: ref(1, 2), position: 597, again: false });
  });

  it("a film at 1200 s resumes at 1197", () => {
    assert.deepEqual(continueTarget(movie([at(1200)])), { ref: { itemId: ID, mid: 48967, season: 0, video: 1 }, position: 1197, again: false });
  });

  it("a watched film starts again", () => {
    assert.deepEqual(continueTarget(movie([DONE])), { ref: { itemId: ID, mid: 48967, season: 0, video: 1 }, position: "none", again: true });
  });

  it("throws KP-BAD for an item without videos", () => {
    assert.throws(() => continueTarget(item({})), (e: unknown) => isKpError(e) && e.code === "KP-BAD");
  });
});

describe("mainButtonLabel", () => {
  it("covers the five variants of the card button", () => {
    const fresh = serial({ 1: [NONE, NONE] });
    assert.equal(mainButtonLabel(fresh, continueTarget(fresh)), "▶ Смотреть");

    const m = movie([at(3738)]);
    assert.equal(mainButtonLabel(m, continueTarget(m)), "▶ Продолжить 1:02:15");

    const started = serial({ 1: [DONE, DONE], 2: [DONE, DONE, DONE, DONE, at(600)] });
    assert.equal(mainButtonLabel(started, continueTarget(started)), "▶ Продолжить S2E5");

    const next = serial({ 1: [DONE], 2: [DONE, DONE, DONE, DONE, DONE, NONE] });
    assert.equal(mainButtonLabel(next, continueTarget(next)), "▶ S2E6");

    const all = serial({ 1: [DONE, DONE], 2: [DONE] });
    assert.equal(mainButtonLabel(all, continueTarget(all)), "▶ Смотреть снова S1E1");
  });

  it("names an episode restarted from the beginning", () => {
    const s = serial({ 1: [DONE], 2: [DONE, at(10)] });
    assert.equal(mainButtonLabel(s, continueTarget(s)), "▶ S2E2");
  });

  it("uses film wording without episode numbers", () => {
    assert.equal(mainButtonLabel(movie([NONE]), continueTarget(movie([NONE]))), "▶ Смотреть");
    assert.equal(mainButtonLabel(movie([DONE]), continueTarget(movie([DONE]))), "▶ Смотреть снова");
    const parts = movie([DONE, NONE, NONE]);
    assert.equal(mainButtonLabel(parts, continueTarget(parts)), "▶ Часть 2");
  });
});
