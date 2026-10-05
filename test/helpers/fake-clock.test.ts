import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sleep } from "../../src/core/clock.ts";
import { FakeClock } from "./fake-clock.ts";

describe("FakeClock", () => {
  it("starts from the given time; now() and perf() advance together", async () => {
    const c = new FakeClock(1_000_000, 50);
    assert.equal(c.now(), 1_000_000);
    assert.equal(c.perf(), 50);
    await c.advance(250);
    assert.equal(c.now(), 1_000_250);
    assert.equal(c.perf(), 300);
  });

  it("fires due timers in order of time, then of creation", async () => {
    const c = new FakeClock();
    const seen: string[] = [];
    c.setTimeout(() => seen.push("c300"), 300);
    c.setTimeout(() => seen.push("a100"), 100);
    c.setTimeout(() => seen.push("b100"), 100);
    c.setTimeout(() => seen.push("late"), 1000);
    await c.advance(500);
    assert.deepEqual(seen, ["a100", "b100", "c300"]);
    assert.equal(c.pending(), 1);
  });

  it("runs the callback with now() equal to the timer's due time", async () => {
    const c = new FakeClock(0, 0);
    let at = -1;
    c.setTimeout(() => (at = c.perf()), 120);
    await c.advance(1000);
    assert.equal(at, 120);
    assert.equal(c.perf(), 1000);
  });

  it("fires timers scheduled by other timers inside the same advance", async () => {
    const c = new FakeClock(0, 0);
    const seen: number[] = [];
    c.setTimeout(() => {
      seen.push(c.perf());
      c.setTimeout(() => seen.push(c.perf()), 100);
    }, 100);
    await c.advance(250);
    assert.deepEqual(seen, [100, 200]);
  });

  it("lets promise continuations run between timers", async () => {
    const c = new FakeClock(0, 0);
    const seen: string[] = [];
    void (async () => {
      await sleep(c, 100);
      seen.push("first");
      await sleep(c, 100);
      seen.push("second");
    })();
    await c.advance(200);
    assert.deepEqual(seen, ["first", "second"]);
  });

  it("clearTimeout cancels a pending timer", async () => {
    const c = new FakeClock();
    let fired = false;
    const id = c.setTimeout(() => (fired = true), 100);
    c.clearTimeout(id);
    await c.advance(1000);
    assert.equal(fired, false);
    assert.equal(c.pending(), 0);
  });

  it("runUntilSettled waits for a promise that sleeps 3000 ms of fake time", async () => {
    const c = new FakeClock(0, 0);
    const t0 = Date.now();
    const v = await c.runUntilSettled(
      (async () => {
        await sleep(c, 3000);
        return "done";
      })(),
    );
    assert.equal(v, "done");
    assert.equal(c.perf(), 3000);
    assert.ok(Date.now() - t0 < 1000, "fake time must not take real time");
  });

  it("runUntilSettled rethrows the rejection", async () => {
    const c = new FakeClock();
    const p = (async () => {
      await sleep(c, 10);
      throw new Error("nope");
    })();
    await assert.rejects(c.runUntilSettled(p), /nope/);
  });

  it("runUntilSettled throws when maxMs of fake time is exhausted", async () => {
    const c = new FakeClock(0, 0);
    const p = sleep(c, 10_000);
    await assert.rejects(c.runUntilSettled(p, 5000), /5000/);
    assert.ok(c.perf() <= 5000);
  });

  describe("with real HTTP", () => {
    let server: Server;
    let url = "";
    const serverTimers: NodeJS.Timeout[] = [];
    before(async () => {
      server = createServer((req, res) => {
        const delay = Number(new URL(req.url ?? "/", "http://x").searchParams.get("delay") ?? "0");
        serverTimers.push(setTimeout(() => res.end("ok"), delay));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    });
    after(() => {
      serverTimers.forEach(clearTimeout);
      server.closeAllConnections();
      server.close();
    });

    // Таймаут запроса — на поддельных часах, как у транспорта (этап 11).
    async function get(c: FakeClock, path: string, timeoutMs: number): Promise<string> {
      const ac = new AbortController();
      const id = c.setTimeout(() => ac.abort(), timeoutMs);
      try {
        const r = await fetch(url + path, { signal: ac.signal });
        return await r.text();
      } finally {
        c.clearTimeout(id);
      }
    }

    it("a fast response is not cut by a pending fake timeout", async () => {
      const c = new FakeClock(0, 0);
      for (let i = 0; i < 5; i++) {
        assert.equal(await c.runUntilSettled(get(c, "?delay=0", 8000)), "ok");
      }
      assert.equal(c.perf(), 0);
    });

    it("a response slower than ioGraceMs of real time loses to the fake timeout", async () => {
      const c = new FakeClock(0, 0);
      c.ioGraceMs = 100;
      await assert.rejects(c.runUntilSettled(get(c, "?delay=1000", 8000)), { name: "AbortError" });
      assert.equal(c.perf(), 8000);
    });
  });
});
