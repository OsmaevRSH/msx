import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Breaker } from "../../src/api/breaker.ts";
import { FakeClock } from "../helpers/fake-clock.ts";

const fail = (b: Breaker, n: number): void => {
  for (let i = 0; i < n; i++) b.failure();
};

describe("Breaker", () => {
  it("starts closed and lets requests through", () => {
    const b = new Breaker(new FakeClock());
    assert.equal(b.state(), "closed");
    assert.equal(b.allow(), true);
  });

  it("opens after 5 consecutive failures; allow() is false while open", async () => {
    const c = new FakeClock();
    const b = new Breaker(c);
    fail(b, 4);
    assert.equal(b.state(), "closed");
    b.failure();
    assert.equal(b.state(), "open");
    assert.equal(b.allow(), false);
    await c.advance(14_999);
    assert.equal(b.state(), "open");
    assert.equal(b.allow(), false);
  });

  it("a success resets the run of failures", () => {
    const b = new Breaker(new FakeClock());
    fail(b, 4);
    b.success();
    fail(b, 4);
    assert.equal(b.state(), "closed");
  });

  it("after 15 s is half-open: one probe passes, success closes it", async () => {
    const c = new FakeClock();
    const b = new Breaker(c);
    fail(b, 5);
    await c.advance(15_000);
    assert.equal(b.state(), "half");
    assert.equal(b.allow(), true);
    assert.equal(b.allow(), false, "only one probe while half-open");
    b.success();
    assert.equal(b.state(), "closed");
    assert.equal(b.allow(), true);
  });

  it("a failed probe opens it again for another 15 s", async () => {
    const c = new FakeClock();
    const b = new Breaker(c);
    fail(b, 5);
    await c.advance(15_000);
    assert.equal(b.allow(), true);
    b.failure();
    assert.equal(b.state(), "open");
    assert.equal(b.allow(), false);
    await c.advance(15_000);
    assert.equal(b.state(), "half");
    assert.equal(b.allow(), true);
  });

  it("a probe that never reports back does not block the breaker forever", async () => {
    const c = new FakeClock();
    const b = new Breaker(c);
    fail(b, 5);
    await c.advance(15_000);
    assert.equal(b.allow(), true);
    await c.advance(15_000);
    assert.equal(b.allow(), true, "a new probe after another 15 s");
  });
});
