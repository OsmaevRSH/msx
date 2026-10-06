import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KP_PROPS, sessionFromProps } from "../../src/progress/session.ts";

const NOW = 1_767_225_600_000;

const PROPS = { "kp:i": "2001", "kp:m": "2001004", "kp:s": "1", "kp:e": "4", "kp:d": "2700", "kp:n": "1" };

describe("KP_PROPS", () => {
  it("names the kp:* markers of the resolve response", () => {
    assert.deepEqual(KP_PROPS, { item: "kp:i", mid: "kp:m", season: "kp:s", episode: "kp:e", duration: "kp:d", hasNext: "kp:n", probe: "kp:p", run: "kp:r" });
  });
});

describe("sessionFromProps", () => {
  it("turns string properties into a session with numbers", () => {
    assert.deepEqual(sessionFromProps(PROPS, NOW), {
      itemId: 2001,
      mid: 2001004,
      season: 1,
      video: 4,
      duration: 2700,
      hasNext: true,
      loadedAt: NOW,
      started: false,
      from: 0,
      peak: 0,
      watchedDone: false,
      ended: false,
    });
  });

  it("resume:position («Продолжить») starts the session maximum and is its start position; none or junk — 0 (этап 33c, фикс 35a)", () => {
    assert.equal(sessionFromProps({ ...PROPS, "resume:position": "1287" }, NOW)?.peak, 1287);
    assert.equal(sessionFromProps({ ...PROPS, "resume:position": "1287" }, NOW)?.from, 1287);
    assert.equal(sessionFromProps({ ...PROPS, "resume:position": "none" }, NOW)?.from, 0);
    assert.equal(sessionFromProps({ ...PROPS, "resume:position": "none" }, NOW)?.peak, 0);
    assert.equal(sessionFromProps({ ...PROPS, "resume:position": "-5" }, NOW)?.peak, 0);
  });

  it("without kp:i there is no session", () => {
    const { "kp:i": _, ...rest } = PROPS;
    assert.equal(sessionFromProps(rest, NOW), undefined);
  });

  it("no properties or a broken kp:i/kp:m/kp:e/kp:s — no session", () => {
    assert.equal(sessionFromProps(undefined, NOW), undefined);
    assert.equal(sessionFromProps({}, NOW), undefined);
    assert.equal(sessionFromProps({ ...PROPS, "kp:i": "abc" }, NOW), undefined);
    assert.equal(sessionFromProps({ ...PROPS, "kp:i": "" }, NOW), undefined);
    assert.equal(sessionFromProps({ ...PROPS, "kp:i": "0" }, NOW), undefined);
    assert.equal(sessionFromProps({ ...PROPS, "kp:m": undefined }, NOW), undefined);
    assert.equal(sessionFromProps({ ...PROPS, "kp:e": "1.5" }, NOW), undefined);
    assert.equal(sessionFromProps({ ...PROPS, "kp:s": "x" }, NOW), undefined);
  });

  it("accepts numbers as well as strings", () => {
    const s = sessionFromProps({ "kp:i": 2001, "kp:m": 2001004, "kp:s": 1, "kp:e": 4, "kp:d": 2700.5, "kp:n": true }, NOW);
    assert.equal(s?.itemId, 2001);
    assert.equal(s?.duration, 2700.5);
    assert.equal(s?.hasNext, true);
  });

  it("a movie: no kp:s means season 0, no kp:d means unknown duration 0, no kp:n means no next", () => {
    const s = sessionFromProps({ "kp:i": "77", "kp:m": "7701", "kp:e": "1" }, NOW);
    assert.equal(s?.season, 0);
    assert.equal(s?.video, 1);
    assert.equal(s?.duration, 0);
    assert.equal(s?.hasNext, false);
  });

  it("kp:n is true only for 1/true", () => {
    for (const v of ["0", "", "false", 0, false, "yes"]) {
      assert.equal(sessionFromProps({ ...PROPS, "kp:n": v }, NOW)?.hasNext, false, String(v));
    }
    for (const v of ["1", 1, true, "true"]) {
      assert.equal(sessionFromProps({ ...PROPS, "kp:n": v }, NOW)?.hasNext, true, String(v));
    }
  });

  it("kp:p becomes the probe variant", () => {
    assert.equal(sessionFromProps({ ...PROPS, "kp:p": "hls2" }, NOW)?.probe, "hls2");
    assert.equal(sessionFromProps(PROPS, NOW)?.probe, undefined);
  });

  it("kp:r becomes the launch nonce (fix 34b); without it or with a non-string — none", () => {
    assert.equal(sessionFromProps({ ...PROPS, "kp:r": "mjv0e9s1" }, NOW)?.run, "mjv0e9s1");
    assert.equal(sessionFromProps(PROPS, NOW)?.run, undefined);
    for (const v of ["", 7, true]) assert.equal(sessionFromProps({ ...PROPS, "kp:r": v }, NOW)?.run, undefined, String(v));
  });
});
