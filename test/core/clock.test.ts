import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sleep, systemClock } from "../../src/core/clock.ts";

describe("systemClock", () => {
  it("now() follows wall time and perf() is monotonic", () => {
    assert.ok(Math.abs(systemClock.now() - Date.now()) < 1000);
    const a = systemClock.perf();
    const b = systemClock.perf();
    assert.ok(b >= a);
  });

  it("setTimeout returns a numeric id and fires", async () => {
    let fired = false;
    const id = systemClock.setTimeout(() => (fired = true), 1);
    assert.equal(typeof id, "number");
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(fired, true);
  });

  it("clearTimeout cancels by numeric id", async () => {
    let fired = false;
    const id = systemClock.setTimeout(() => (fired = true), 5);
    systemClock.clearTimeout(id);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fired, false);
  });

  it("sleep resolves after the delay", async () => {
    const t = Date.now();
    await sleep(systemClock, 15);
    assert.ok(Date.now() - t >= 10);
  });
});
