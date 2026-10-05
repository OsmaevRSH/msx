import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "./memory-storage.ts";

describe("MemoryStorage", () => {
  it("behaves like localStorage for get/set/remove/key/length", () => {
    const s = new MemoryStorage();
    assert.equal(s.getItem("a"), null);
    s.setItem("a", "1");
    s.setItem("b", "2");
    s.setItem("a", "3");
    assert.equal(s.getItem("a"), "3");
    assert.equal(s.length, 2);
    assert.deepEqual([s.key(0), s.key(1), s.key(2)], ["a", "b", null]);
    s.removeItem("a");
    s.removeItem("missing");
    assert.equal(s.getItem("a"), null);
    assert.equal(s.length, 1);
  });

  it("logs written keys in order", () => {
    const s = new MemoryStorage();
    s.setItem("kp.auth.pair", "{}");
    s.setItem("kp.l2.x", "{}");
    s.setItem("kp.auth.pair", "{}");
    assert.deepEqual(s.writes, ["kp.auth.pair", "kp.l2.x", "kp.auth.pair"]);
  });

  it("counts (key + value) × 2 bytes", () => {
    const s = new MemoryStorage();
    s.setItem("ab", "cde");
    assert.equal(s.usedBytes(), 10);
  });

  it("throws QuotaExceededError above quotaBytes and keeps the old value", () => {
    const s = new MemoryStorage({ quotaBytes: 40 });
    s.setItem("k", "x".repeat(9)); // 20 байт
    s.setItem("k", "y".repeat(9)); // замена, по-прежнему 20 байт
    assert.throws(
      () => s.setItem("k2", "z".repeat(10)), // ещё 22 байта → 42 > 40
      (e: unknown) => (e as { name?: string }).name === "QuotaExceededError",
    );
    assert.equal(s.getItem("k"), "y".repeat(9));
    assert.equal(s.getItem("k2"), null);
    assert.deepEqual(s.writes, ["k", "k"]);
    s.removeItem("k");
    s.setItem("k2", "z".repeat(10));
    assert.equal(s.getItem("k2"), "z".repeat(10));
  });

  it("has no clear()", () => {
    assert.equal("clear" in new MemoryStorage(), false);
  });
});
