import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Limiter } from "../../src/api/limiter.ts";
import { Priority } from "../../src/api/transport.ts";
import { KpError } from "../../src/core/errors.ts";
import { startMock } from "../../tools/kpmock/server.ts";
import type { MockServer } from "../../tools/kpmock/server.ts";
import { createCorsFetch } from "../helpers/cors-fetch.ts";
import { FakeClock } from "../helpers/fake-clock.ts";

interface Gate {
  started: boolean;
  release(): void;
  fn: () => Promise<string>;
}

/** Задача, которая стартует по команде лимитера и завершается по `release()`. */
function gate(name: string): Gate {
  let release: () => void = () => {};
  const done = new Promise<void>((r) => (release = r));
  const g: Gate = {
    started: false,
    release: () => release(),
    fn: async () => {
      g.started = true;
      await done;
      return name;
    },
  };
  return g;
}

const settle = async (c: FakeClock): Promise<void> => {
  await c.advance(0);
};

describe("Limiter", () => {
  describe("against kpmock", () => {
    let mock: MockServer;
    before(async () => {
      mock = await startMock({ port: 0 });
    });
    after(async () => {
      await mock.close();
    });

    it("6 parallel fg requests with 200 ms mock delay: at most 3 in flight (CC-04)", async () => {
      mock.reset();
      mock.setScenario({ delayMs: 200 });
      const c = new FakeClock();
      c.ioGraceMs = 5000;
      const l = new Limiter(c);
      const f = createCorsFetch({ origin: "https://example.github.io" });
      const all = Promise.all(Array.from({ length: 6 }, () => l.run("fg", async () => (await f(`${mock.url}/v1/types`, {})).status)));
      const statuses = await c.runUntilSettled(all);
      assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401]);
      assert.equal(mock.stats().maxInFlight, 3);
      assert.deepEqual(l.inFlight(), { fg: 0, bg: 0 });
    });
  });

  it("fg runs up to 3 at once; the 4th waits for a free slot", async () => {
    const c = new FakeClock();
    const l = new Limiter(c);
    const gs = [gate("a"), gate("b"), gate("c"), gate("d")];
    const ps = gs.map((g) => l.run("fg", g.fn));
    await settle(c);
    assert.deepEqual(gs.map((g) => g.started), [true, true, true, false]);
    assert.deepEqual(l.inFlight(), { fg: 3, bg: 0 });
    gs[0].release();
    assert.equal(await ps[0], "a");
    await settle(c);
    assert.equal(gs[3].started, true);
    gs.slice(1).forEach((g) => g.release());
    assert.deepEqual(await Promise.all(ps), ["a", "b", "c", "d"]);
    assert.deepEqual(l.inFlight(), { fg: 0, bg: 0 });
  });

  it("bg has its own single slot and does not take fg slots", async () => {
    const c = new FakeClock();
    const l = new Limiter(c);
    const bg1 = gate("bg1");
    const bg2 = gate("bg2");
    const fgs = [gate("f1"), gate("f2"), gate("f3")];
    const pb1 = l.run("bg", bg1.fn);
    const pb2 = l.run("bg", bg2.fn);
    const pf = fgs.map((g) => l.run("fg", g.fn));
    await settle(c);
    assert.equal(bg1.started, true);
    assert.equal(bg2.started, false, "only one bg at a time");
    assert.deepEqual(fgs.map((g) => g.started), [true, true, true]);
    assert.deepEqual(l.inFlight(), { fg: 3, bg: 1 });
    bg1.release();
    await pb1;
    await settle(c);
    assert.equal(bg2.started, true);
    bg2.release();
    fgs.forEach((g) => g.release());
    await Promise.all([pb2, ...pf]);
  });

  it("10 requests in a row take at least 1 s (≤ 5 per second)", async () => {
    const c = new FakeClock(0, 0);
    const l = new Limiter(c);
    const starts: number[] = [];
    const all = Promise.all(Array.from({ length: 10 }, () => l.run("fg", async () => {
      starts.push(c.perf());
    })));
    await c.runUntilSettled(all);
    assert.equal(starts.length, 10);
    assert.ok(starts[9] - starts[0] >= 1000, `spread ${starts[9] - starts[0]} ms`);
    for (let i = 5; i < starts.length; i++) {
      assert.ok(starts[i] - starts[i - 5] >= 1000, `starts ${i - 5} and ${i} are within 1 s`);
    }
  });

  it("the rate limit is shared by fg and bg", async () => {
    const c = new FakeClock(0, 0);
    const l = new Limiter(c);
    const starts: number[] = [];
    const run = (cls: "fg" | "bg"): Promise<void> => l.run(cls, async () => {
      starts.push(c.perf());
    });
    await c.runUntilSettled(Promise.all([run("fg"), run("bg"), run("fg"), run("bg"), run("fg"), run("bg")]));
    assert.equal(starts.filter((t) => t < 1000).length, 5);
  });

  it("a queued bg request is dropped when a fg request waits longer than 200 ms", async () => {
    const c = new FakeClock(0, 0);
    const l = new Limiter(c);
    const busy = [gate("f1"), gate("f2"), gate("f3"), gate("b1")];
    const pBusy = busy.map((g, i) => l.run(i < 3 ? "fg" : "bg", g.fn));
    await settle(c);
    const queuedBg = gate("b2");
    const pQueuedBg = l.run("bg", queuedBg.fn);
    const waitingFg = gate("f4");
    const pWaitingFg = l.run("fg", waitingFg.fn);
    let rejection: unknown;
    pQueuedBg.catch((e: unknown) => (rejection = e));
    const dropped = (): unknown => rejection;

    await c.advance(150);
    assert.equal(dropped(), undefined, "fg has waited only 150 ms");
    await c.advance(60);
    const err = dropped();
    assert.ok(err instanceof KpError);
    assert.equal(err.code, "KP-NET");
    assert.equal(err.message, "bg-dropped");
    assert.equal(queuedBg.started, false);
    assert.equal(busy[3].started, true, "a bg request already in flight is not touched");

    busy.forEach((g) => g.release());
    await Promise.all(pBusy);
    await settle(c);
    assert.equal(waitingFg.started, true);
    waitingFg.release();
    assert.equal(await pWaitingFg, "f4");
  });

  it("on429() limits fg to 1 for 30 s, then back to 3", async () => {
    const c = new FakeClock(0, 0);
    const l = new Limiter(c);
    assert.equal(l.fgLimit(), 3);
    l.on429();
    assert.equal(l.fgLimit(), 1);
    const gs = [gate("a"), gate("b"), gate("c")];
    const ps = gs.map((g) => l.run("fg", g.fn));
    await settle(c);
    assert.deepEqual(gs.map((g) => g.started), [true, false, false]);
    await c.advance(29_999);
    assert.equal(l.fgLimit(), 1);
    assert.deepEqual(gs.map((g) => g.started), [true, false, false]);
    await c.advance(1);
    assert.equal(l.fgLimit(), 3);
    assert.deepEqual(gs.map((g) => g.started), [true, true, true], "waiting requests start when the limit is lifted");
    gs.forEach((g) => g.release());
    await Promise.all(ps);
  });

  it("a repeated 429 extends the 30 s window", async () => {
    const c = new FakeClock(0, 0);
    const l = new Limiter(c);
    l.on429();
    await c.advance(20_000);
    l.on429();
    await c.advance(20_000);
    assert.equal(l.fgLimit(), 1);
    await c.advance(10_000);
    assert.equal(l.fgLimit(), 3);
  });

  describe("promotion: a fg caller joins a queued bg request (single-flight)", () => {
    /** 3 fg и единственный bg в полёте: новые запросы встают в очередь. */
    const busy = async (c: FakeClock, l: Limiter): Promise<{ gs: Gate[]; ps: Promise<string>[] }> => {
      const gs = [gate("f1"), gate("f2"), gate("f3"), gate("b1")];
      const ps = gs.map((g, i) => l.run(i < 3 ? "fg" : "bg", g.fn));
      await settle(c);
      return { gs, ps };
    };
    const rejection = (p: Promise<unknown>): (() => unknown) => {
      let err: unknown;
      p.catch((e: unknown) => (err = e));
      return () => err;
    };

    it("a promoted request is not dropped as bg while fg waits longer than 200 ms and takes the next fg slot", async () => {
      const c = new FakeClock(0, 0);
      const l = new Limiter(c);
      const held = await busy(c, l);
      const prio = new Priority("bg");
      const card = gate("card");
      const pCard = l.run(prio, card.fn);
      const cardErr = rejection(pCard);
      prio.promote();
      assert.equal(prio.cls(), "fg");
      const other = gate("f4");
      const pOther = l.run("fg", other.fn);

      await c.advance(250);
      assert.equal(cardErr(), undefined, "the promoted request is not dropped");
      assert.equal(card.started, false);

      held.gs[0].release();
      await held.ps[0];
      assert.equal(card.started, true, "first free fg slot");
      assert.equal(other.started, false);
      assert.deepEqual(l.inFlight(), { fg: 3, bg: 1 });
      card.release();
      assert.equal(await pCard, "card");
      await c.advance(1000);
      assert.equal(other.started, true, "next in the fg queue once the 5-per-second window allows");

      other.release();
      held.gs.forEach((g) => g.release());
      await Promise.all([pOther, ...held.ps]);
      assert.deepEqual(l.inFlight(), { fg: 0, bg: 0 });
    });

    it("pure bg requests and a never promoted one are still dropped; a late promote() changes nothing", async () => {
      const c = new FakeClock(0, 0);
      const l = new Limiter(c);
      const held = await busy(c, l);
      const prio = new Priority("bg");
      const a = gate("a");
      const b = gate("b");
      const errA = rejection(l.run(prio, a.fn));
      const errB = rejection(l.run("bg", b.fn));
      const waiting = gate("f4");
      const pWaiting = l.run("fg", waiting.fn);

      await c.advance(210);
      for (const err of [errA(), errB()]) {
        assert.ok(err instanceof KpError);
        assert.equal(err.code, "KP-NET");
        assert.equal(err.message, "bg-dropped");
      }
      prio.promote();
      held.gs.forEach((g) => g.release());
      await Promise.all(held.ps);
      await settle(c);
      assert.equal(waiting.started, true);
      assert.deepEqual([a.started, b.started], [false, false]);
      waiting.release();
      await pWaiting;
      assert.deepEqual(l.inFlight(), { fg: 0, bg: 0 });
    });

    it("the promoted request overtakes the bg requests queued before it", async () => {
      const c = new FakeClock(0, 0);
      const l = new Limiter(c);
      const b1 = gate("b1");
      const p1 = l.run("bg", b1.fn);
      await settle(c);
      const b2 = gate("b2");
      const b3 = gate("b3");
      const card = gate("card");
      const prio = new Priority("bg");
      const ps = [l.run("bg", b2.fn), l.run("bg", b3.fn), l.run(prio, card.fn)];
      await settle(c);
      assert.deepEqual([b2.started, b3.started, card.started], [false, false, false]);

      prio.promote();
      assert.equal(card.started, true, "starts at once in a free fg slot");
      assert.deepEqual([b2.started, b3.started], [false, false]);
      assert.deepEqual(l.inFlight(), { fg: 1, bg: 1 });

      b1.release();
      await p1;
      assert.deepEqual([b2.started, b3.started], [true, false], "the bg queue keeps its order");
      [b2, b3, card].forEach((g) => g.release());
      assert.deepEqual(await Promise.all(ps), ["b2", "b3", "card"]);
      assert.deepEqual(l.inFlight(), { fg: 0, bg: 0 });
    });

    it("promoting a request already in flight changes nothing; a fg Priority queues as fg", async () => {
      const c = new FakeClock(0, 0);
      const l = new Limiter(c);
      const prio = new Priority("bg");
      const g = gate("bg");
      const p = l.run(prio, g.fn);
      await settle(c);
      assert.equal(g.started, true);
      prio.promote();
      assert.deepEqual(l.inFlight(), { fg: 0, bg: 1 });
      g.release();
      await p;
      assert.deepEqual(l.inFlight(), { fg: 0, bg: 0 });

      const h = gate("fg");
      const ph = l.run(new Priority("fg"), h.fn);
      assert.equal(h.started, true);
      assert.deepEqual(l.inFlight(), { fg: 1, bg: 0 });
      h.release();
      await ph;
    });
  });

  it("a rejected task frees its slot and passes the error through", async () => {
    const c = new FakeClock();
    const l = new Limiter(c);
    await assert.rejects(l.run("fg", async () => {
      throw new Error("boom");
    }), /boom/);
    await assert.rejects(l.run("bg", () => {
      throw new Error("sync boom");
    }), /sync boom/);
    assert.deepEqual(l.inFlight(), { fg: 0, bg: 0 });
  });
});
