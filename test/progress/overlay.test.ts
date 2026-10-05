import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FAKE_EPOCH, FakeClock } from "../helpers/fake-clock.ts";
import { Overlay } from "../../src/progress/overlay.ts";

const HOUR = 3_600_000;

describe("Overlay", () => {
  it("set/get by (item, season, video), stamped with clock.now()", async () => {
    const clock = new FakeClock();
    const o = new Overlay(clock);
    o.set(2001, 1, 4, { time: 600, status: 0 });
    await clock.advance(5000);
    o.set(2001, 1, 5, { time: 30, status: -1 });
    assert.deepEqual(o.get(2001, 1, 4), { time: 600, status: 0, at: FAKE_EPOCH });
    assert.deepEqual(o.get(2001, 1, 5), { time: 30, status: -1, at: FAKE_EPOCH + 5000 });
    assert.equal(o.get(2001, 2, 4), undefined);
    assert.equal(o.get(2002, 1, 4), undefined);
  });

  it("set overwrites the previous value", async () => {
    const clock = new FakeClock();
    const o = new Overlay(clock);
    o.set(77, 0, 1, { time: 600, status: 0 });
    await clock.advance(60_000);
    o.set(77, 0, 1, { time: 6500, status: 1 });
    assert.deepEqual(o.get(77, 0, 1), { time: 6500, status: 1, at: FAKE_EPOCH + 60_000 });
  });

  it("get works as a detached OverlayLookup and returns copies", () => {
    const o = new Overlay(new FakeClock());
    o.set(77, 0, 1, { time: 100, status: 0 });
    const lookup = o.get;
    const e = lookup(77, 0, 1);
    assert.equal(e?.time, 100);
    if (e) e.time = 999;
    assert.equal(o.get(77, 0, 1)?.time, 100);
  });

  it("forItem lists only that item, ordered by season and video", () => {
    const o = new Overlay(new FakeClock());
    o.set(2001, 2, 1, { time: 50, status: 0 });
    o.set(2001, 1, 5, { time: 40, status: 0 });
    o.set(3003, 1, 1, { time: 90, status: 0 });
    o.set(2001, 1, 4, { time: 2500, status: 1 });
    assert.deepEqual(
      o.forItem(2001).map((e) => [e.season, e.video, e.time, e.status]),
      [
        [1, 4, 2500, 1],
        [1, 5, 40, 0],
        [2, 1, 50, 0],
      ],
    );
    assert.deepEqual(o.forItem(4004), []);
  });

  it("prune removes entries older than 24 h by default", async () => {
    const clock = new FakeClock();
    const o = new Overlay(clock);
    o.set(1, 0, 1, { time: 100, status: 0 });
    await clock.advance(23 * HOUR);
    o.set(2, 0, 1, { time: 200, status: 0 });
    await clock.advance(HOUR);
    o.prune();
    assert.equal(o.get(1, 0, 1)?.time, 100, "exactly 24 h old is kept");
    await clock.advance(1);
    o.prune();
    assert.equal(o.get(1, 0, 1), undefined);
    assert.equal(o.get(2, 0, 1)?.time, 200);
    assert.deepEqual(JSON.parse(o.serialize()).e.length, 1);
  });

  it("prune with a custom age", async () => {
    const clock = new FakeClock();
    const o = new Overlay(clock);
    o.set(1, 0, 1, { time: 100, status: 0 });
    await clock.advance(2 * HOUR);
    o.set(2, 0, 1, { time: 200, status: 0 });
    o.prune(HOUR);
    assert.equal(o.get(1, 0, 1), undefined);
    assert.equal(o.get(2, 0, 1)?.time, 200);
  });

  it("entries older than 24 h are not returned even before prune", async () => {
    const clock = new FakeClock();
    const o = new Overlay(clock);
    o.set(1, 0, 1, { time: 100, status: 0 });
    await clock.advance(24 * HOUR + 1);
    assert.equal(o.get(1, 0, 1), undefined);
    assert.deepEqual(o.forItem(1), []);
  });

  it("serialize/load round trip", async () => {
    const clock = new FakeClock();
    const a = new Overlay(clock);
    a.set(2001, 1, 4, { time: 2500, status: 1 });
    await clock.advance(1000);
    a.set(77, 0, 1, { time: 600.5, status: -1 });
    const b = new Overlay(clock);
    b.load(a.serialize());
    assert.deepEqual(b.get(2001, 1, 4), a.get(2001, 1, 4));
    assert.deepEqual(b.get(77, 0, 1), { time: 600.5, status: -1, at: FAKE_EPOCH + 1000 });
    assert.deepEqual(b.forItem(2001), a.forItem(2001));
    assert.equal(b.serialize(), a.serialize());
  });

  it("load after a restart drops entries older than 24 h", async () => {
    const clock = new FakeClock();
    const a = new Overlay(clock);
    a.set(1, 0, 1, { time: 100, status: 0 });
    const json = a.serialize();
    await clock.advance(25 * HOUR);
    const b = new Overlay(clock);
    b.load(json);
    assert.equal(b.get(1, 0, 1), undefined);
    assert.deepEqual(JSON.parse(b.serialize()).e, []);
  });

  it("load keeps the newer of an existing and a loaded entry", async () => {
    const clock = new FakeClock();
    const old = new Overlay(clock);
    old.set(1, 0, 1, { time: 100, status: 0 });
    old.set(2, 0, 1, { time: 200, status: 0 });
    await clock.advance(1000);
    const o = new Overlay(clock);
    o.set(1, 0, 1, { time: 150, status: 0 });
    o.load(old.serialize());
    assert.equal(o.get(1, 0, 1)?.time, 150);
    assert.equal(o.get(2, 0, 1)?.time, 200);
  });

  it("load ignores garbage and invalid entries", () => {
    const o = new Overlay(new FakeClock());
    for (const s of ["", "not json", "null", "[]", '{"v":2,"e":[[1,0,1,10,0,0]]}', '{"v":1,"e":"x"}']) {
      assert.doesNotThrow(() => o.load(s), s);
    }
    o.load(
      JSON.stringify({
        v: 1,
        e: [
          [1, 0, 1, 10, 0, FAKE_EPOCH],
          [0, 0, 1, 10, 0, FAKE_EPOCH],
          [2, -1, 1, 10, 0, FAKE_EPOCH],
          [3, 0, 1, "10", 0, FAKE_EPOCH],
          [4, 0, 1, 10, 2, FAKE_EPOCH],
          [5, 0, 1, 10, 0],
          "x",
        ],
      }),
    );
    assert.deepEqual(o.get(1, 0, 1), { time: 10, status: 0, at: FAKE_EPOCH });
    assert.equal(JSON.parse(o.serialize()).e.length, 1);
  });
});
