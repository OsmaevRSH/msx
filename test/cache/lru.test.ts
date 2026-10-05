import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { type Entry, Lru } from "../../src/cache/lru.ts";

const entry = (value: string, bytes: number): Entry<string> => ({ value, bytes, fetchedAt: 0, staleMarked: false });

describe("Lru", () => {
  it("defaults to a 15 MB budget (CNFR-17)", () => {
    const lru = new Lru<string>();
    lru.set("a", entry("a", 15 * 1024 * 1024));
    assert.equal(lru.get("a")?.value, "a");
    lru.set("b", entry("b", 1));
    assert.equal(lru.get("a"), undefined);
    assert.deepEqual(lru.keys(), ["b"]);
  });

  it("set/get/delete and byte accounting", () => {
    const lru = new Lru<string>(100);
    lru.set("a", entry("A", 10));
    lru.set("b", entry("B", 20));
    assert.equal(lru.get("a")?.value, "A");
    assert.equal(lru.bytes(), 30);
    lru.set("a", entry("A2", 5));
    assert.equal(lru.get("a")?.value, "A2");
    assert.equal(lru.bytes(), 25);
    lru.delete("b");
    lru.delete("missing");
    assert.equal(lru.get("b"), undefined);
    assert.equal(lru.bytes(), 5);
    assert.deepEqual(lru.keys(), ["a"]);
  });

  it("evicts the least recently used entries when over the byte budget", () => {
    const lru = new Lru<string>(100);
    lru.set("a", entry("A", 40));
    lru.set("b", entry("B", 40));
    lru.set("c", entry("C", 40));
    assert.equal(lru.get("a"), undefined);
    assert.deepEqual(lru.keys(), ["b", "c"]);
    assert.equal(lru.bytes(), 80);
    lru.set("d", entry("D", 90));
    assert.deepEqual(lru.keys(), ["d"]);
    assert.equal(lru.bytes(), 90);
  });

  it("get moves the entry to the most recently used position", () => {
    const lru = new Lru<string>(100);
    lru.set("a", entry("A", 40));
    lru.set("b", entry("B", 40));
    assert.equal(lru.get("a")?.value, "A");
    assert.deepEqual(lru.keys(), ["b", "a"]);
    lru.set("c", entry("C", 40));
    assert.equal(lru.get("b"), undefined);
    assert.equal(lru.get("a")?.value, "A");
    assert.deepEqual(lru.keys(), ["c", "a"]);
  });

  it("overwriting a key also refreshes its position", () => {
    const lru = new Lru<string>(100);
    lru.set("a", entry("A", 40));
    lru.set("b", entry("B", 40));
    lru.set("a", entry("A2", 40));
    lru.set("c", entry("C", 40));
    assert.deepEqual(lru.keys(), ["a", "c"]);
  });

  it("peek reads without changing the order", () => {
    const lru = new Lru<string>(100);
    lru.set("a", entry("A", 40));
    lru.set("b", entry("B", 40));
    assert.equal(lru.peek("a")?.value, "A");
    assert.equal(lru.peek("missing"), undefined);
    lru.set("c", entry("C", 40));
    assert.equal(lru.peek("a"), undefined);
  });

  it("does not keep an entry larger than the whole budget and drops the old value of that key", () => {
    const lru = new Lru<string>(100);
    lru.set("a", entry("A", 10));
    lru.set("b", entry("B", 10));
    lru.set("a", entry("huge", 101));
    assert.equal(lru.get("a"), undefined);
    assert.equal(lru.get("b")?.value, "B");
    assert.equal(lru.bytes(), 10);
  });

  it("returns the stored entry object, so a stale mark set on it sticks", () => {
    const lru = new Lru<string>(100);
    lru.set("a", entry("A", 10));
    const e = lru.peek("a");
    assert.ok(e);
    e.staleMarked = true;
    assert.equal(lru.get("a")?.staleMarked, true);
  });
});
