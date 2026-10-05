import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PlaybackSession } from "../../src/progress/session.ts";
import {
  MIN_POSITION,
  WATCHED_RATIO,
  checkToggleResult,
  decideMarktime,
  decideWatched,
  isWatchedPosition,
} from "../../src/progress/rules.ts";

const DURATION = 2700;

function session(over: Partial<PlaybackSession> = {}): PlaybackSession {
  return {
    itemId: 2001,
    mid: 2001004,
    season: 1,
    video: 4,
    duration: DURATION,
    hasNext: true,
    loadedAt: 0,
    started: true,
    watchedDone: false,
    ended: false,
    ...over,
  };
}

const at = (ratio: number): number => DURATION * ratio;

describe("constants", () => {
  it("30 s threshold and 90 % watched", () => {
    assert.equal(MIN_POSITION, 30);
    assert.equal(WATCHED_RATIO, 0.9);
  });
});

describe("isWatchedPosition", () => {
  it("90 % and above, never with an unknown duration", () => {
    assert.equal(isWatchedPosition(2430, 2700), true);
    assert.equal(isWatchedPosition(2427.3, 2700), false);
    assert.equal(isWatchedPosition(2700, 2700), true);
    assert.equal(isWatchedPosition(3348, 3720), true);
    assert.equal(isWatchedPosition(100, 0), false);
    assert.equal(isWatchedPosition(NaN, 2700), false);
  });
});

describe("decideMarktime", () => {
  it("29 s — not sent, 30 s — sent", () => {
    assert.deepEqual(decideMarktime(session(), 29, "hb"), { send: false, reason: "below-threshold" });
    assert.deepEqual(decideMarktime(session(), 29.99, "stop"), { send: false, reason: "below-threshold" });
    assert.deepEqual(decideMarktime(session(), 30, "hb"), { send: true, time: 30, reason: "ok" });
  });

  it("time is whole seconds rounded down", () => {
    assert.equal(decideMarktime(session(), 600.9, "pause").time, 600);
  });

  it("the same position as already sent is not repeated", () => {
    assert.deepEqual(decideMarktime(session({ lastSentPos: 600 }), 600, "pause"), { send: false, reason: "same" });
    assert.deepEqual(decideMarktime(session({ lastSentPos: 600 }), 600.7, "stop"), { send: false, reason: "same" });
    assert.equal(decideMarktime(session({ lastSentPos: 600 }), 660, "hb").send, true);
  });

  it("rewinding is a legitimate change and is sent", () => {
    const r = decideMarktime(session({ lastSentPos: 600 }), 300, "snapshot");
    assert.equal(r.send, true);
    assert.equal(r.time, 300);
  });

  it("after watched: 50 % is not sent, 95 % is", () => {
    assert.deepEqual(decideMarktime(session({ watchedDone: true }), at(0.5), "stop"), { send: false, reason: "after-watched" });
    const r = decideMarktime(session({ watchedDone: true }), at(0.95), "end");
    assert.equal(r.send, true);
    assert.equal(r.time, Math.floor(at(0.95)));
  });

  it("the rules do not depend on the event kind", () => {
    for (const kind of ["hb", "pause", "stop", "end", "snapshot"] as const) {
      assert.equal(decideMarktime(session(), 29, kind).send, false, kind);
      assert.equal(decideMarktime(session(), 120, kind).send, true, kind);
    }
  });

  it("no usable position — not sent", () => {
    assert.deepEqual(decideMarktime(session(), NaN, "hb"), { send: false, reason: "no-position" });
    assert.equal(decideMarktime(session(), Infinity, "hb").send, false);
    assert.equal(decideMarktime(session(), -5, "hb").send, false);
  });
});

describe("decideWatched", () => {
  it("never on load or play, even at 95 %", () => {
    assert.equal(decideWatched(session(), at(0.95), "load", 0), "none");
    assert.equal(decideWatched(session(), at(0.95), "play", -1), "none");
  });

  it("89.9 % — none, 90 % — toggle", () => {
    assert.equal(decideWatched(session(), at(0.899), "hb", 0), "none");
    assert.equal(decideWatched(session(), 2430, "hb", 0), "toggle");
  });

  it("toggle on every position-carrying event at or above 90 %", () => {
    for (const kind of ["hb", "pause", "stop", "end", "snapshot"] as const) {
      assert.equal(decideWatched(session(), at(0.95), kind, -1), "toggle", kind);
    }
  });

  it("status 1 — none (toggle would unmark it)", () => {
    assert.equal(decideWatched(session(), at(0.95), "end", 1), "none");
  });

  it("already marked in this session — none", () => {
    assert.equal(decideWatched(session({ watchedDone: true }), at(0.99), "snapshot", 0), "none");
  });

  it("unknown duration — none", () => {
    assert.equal(decideWatched(session({ duration: 0 }), 5000, "end", 0), "none");
  });
});

describe("checkToggleResult", () => {
  it("matching answer — done, otherwise toggle again", () => {
    assert.equal(checkToggleResult(1, { watched: 1 }), "done");
    assert.equal(checkToggleResult(0, { watched: 0 }), "done");
    assert.equal(checkToggleResult(1, { watched: 0 }), "toggle-again");
    assert.equal(checkToggleResult(0, { watched: 1 }), "toggle-again");
  });
});
