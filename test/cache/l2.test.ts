import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KvStore } from "../../src/bridge/storage.ts";
import { L2 } from "../../src/cache/l2.ts";
import { Logger } from "../../src/core/log.ts";
import { FAKE_EPOCH, FakeClock } from "../helpers/fake-clock.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";

function setup(opts?: { maxBytes?: number; quotaBytes?: number }) {
  const clock = new FakeClock();
  const mem = new MemoryStorage(opts?.quotaBytes === undefined ? undefined : { quotaBytes: opts.quotaBytes });
  const log = new Logger(clock);
  const kv = new KvStore(mem, log);
  const l2 = new L2(kv, clock, opts?.maxBytes, log);
  return { clock, mem, log, kv, l2 };
}

const l2Keys = (mem: MemoryStorage): string[] => {
  const out: string[] = [];
  for (let i = 0; i < mem.length; i++) {
    const k = mem.key(i);
    if (k?.startsWith("kp.l2.")) out.push(k);
  }
  return out.sort();
};

/** Значение, у которого JSON.stringify(v).length * 2 === bytes (bytes чётное, ≥ 4). */
const sized = (bytes: number): string => "x".repeat(bytes / 2 - 2);

describe("L2", () => {
  it("put is deferred: nothing in storage until the 1 s batch timer fires", async () => {
    const { clock, mem, l2 } = setup();
    l2.put("home:fresh", { items: [1, 2, 3] });
    l2.put("genres:movie", [{ id: 1, title: "Драма" }]);
    assert.deepEqual(l2Keys(mem), []);
    assert.equal(mem.writes.length, 0);
    await clock.advance(999);
    assert.deepEqual(l2Keys(mem), []);
    await clock.advance(1);
    assert.deepEqual(l2Keys(mem), ["kp.l2.genres:movie", "kp.l2.home:fresh"]);
    assert.equal(clock.pending(), 0);
  });

  it("puts within one second share a single timer", async () => {
    const { clock, mem, l2 } = setup();
    l2.put("a", 1);
    await clock.advance(500);
    l2.put("b", 2);
    assert.equal(clock.pending(), 1);
    await clock.advance(500);
    assert.deepEqual(l2Keys(mem), ["kp.l2.a", "kp.l2.b"]);
  });

  it("get returns the value with savedAt = time of put and its size, before and after the flush", async () => {
    const { clock, l2 } = setup();
    l2.put("k", { a: "б" });
    await clock.advance(300);
    const bytes = JSON.stringify({ a: "б" }).length * 2;
    assert.deepEqual(l2.get("k"), { value: { a: "б" }, savedAt: FAKE_EPOCH, bytes });
    await clock.advance(1000);
    assert.deepEqual(l2.get("k"), { value: { a: "б" }, savedAt: FAKE_EPOCH, bytes });
    assert.equal(l2.get("missing"), undefined);
  });

  it("a new L2 on the same storage reads what the previous one flushed", async () => {
    const { clock, kv, l2 } = setup();
    l2.put("k", [1, 2]);
    l2.flush();
    assert.equal(clock.pending(), 0);
    const again = new L2(kv, clock);
    assert.deepEqual(again.get("k")?.value, [1, 2]);
  });

  it("flush writes immediately and cancels the timer", () => {
    const { clock, mem, l2 } = setup();
    l2.put("k", 1);
    l2.flush();
    assert.deepEqual(l2Keys(mem), ["kp.l2.k"]);
    assert.equal(clock.pending(), 0);
    l2.flush();
  });

  it("remove drops both the stored and the pending value", async () => {
    const { clock, mem, l2 } = setup();
    l2.put("a", 1);
    l2.flush();
    l2.put("b", 2);
    l2.remove("a");
    l2.remove("b");
    assert.equal(l2.get("a"), undefined);
    assert.equal(l2.get("b"), undefined);
    await clock.advance(1000);
    assert.deepEqual(l2Keys(mem), []);
  });

  it("over the byte budget evicts the oldest savedAt first", async () => {
    const { clock, mem, l2 } = setup({ maxBytes: 1000 });
    l2.put("old", sized(400));
    await clock.advance(1000);
    l2.put("mid", sized(400));
    await clock.advance(1000);
    assert.deepEqual(l2Keys(mem), ["kp.l2.mid", "kp.l2.old"]);
    l2.put("new", sized(400));
    await clock.advance(1000);
    assert.deepEqual(l2Keys(mem), ["kp.l2.mid", "kp.l2.new"]);
    assert.equal(l2.get("old"), undefined);
  });

  it("budget eviction also counts entries flushed by an earlier L2 instance", async () => {
    const { clock, kv, mem, l2 } = setup({ maxBytes: 1000 });
    l2.put("old", sized(600));
    l2.flush();
    await clock.advance(5000);
    const again = new L2(kv, clock, 1000);
    again.put("new", sized(600));
    again.flush();
    assert.deepEqual(l2Keys(mem), ["kp.l2.new"]);
  });

  it("overwriting a key replaces its size instead of adding to it", () => {
    const { mem, l2 } = setup({ maxBytes: 1000 });
    l2.put("a", sized(400));
    l2.put("b", sized(400));
    l2.flush();
    l2.put("a", sized(500));
    l2.flush();
    assert.deepEqual(l2Keys(mem), ["kp.l2.a", "kp.l2.b"]);
  });

  it("skips a value larger than the whole budget with a warning", () => {
    const { log, mem, l2 } = setup({ maxBytes: 1000 });
    l2.put("small", 1);
    l2.put("huge", sized(1002));
    l2.flush();
    assert.deepEqual(l2Keys(mem), ["kp.l2.small"]);
    assert.ok(log.entries().some((e) => e.level === "warn" && e.tag === "l2"));
  });

  it("storage quota overflow does not throw, skips the write and leaves kp.auth.* alone", () => {
    const { log, kv, mem, l2 } = setup({ quotaBytes: 2000 });
    assert.equal(kv.set("auth", "access", "mock-at-1"), true);
    assert.equal(kv.set("auth", "refresh", "mock-rt-1"), true);
    l2.put("small", 1);
    l2.put("big", sized(1800));
    assert.doesNotThrow(() => l2.flush());
    assert.equal(kv.get("auth", "access"), "mock-at-1");
    assert.equal(kv.get("auth", "refresh"), "mock-rt-1");
    assert.deepEqual(l2Keys(mem), ["kp.l2.small"]);
    assert.equal(l2.get("big"), undefined);
    assert.ok(log.entries().some((e) => e.level === "warn" && e.tag === "l2" && e.data?.["key"] === "big"));
  });

  it("ignores and removes a malformed record", () => {
    const { mem, l2 } = setup();
    mem.setItem("kp.l2.bad", '{"nope":1}');
    mem.setItem("kp.l2.broken", "{");
    assert.equal(l2.get("bad"), undefined);
    assert.equal(l2.get("broken"), undefined);
    l2.put("ok", 1);
    l2.flush();
    assert.deepEqual(l2Keys(mem), ["kp.l2.ok"]);
  });

  it("put with undefined removes the key", () => {
    const { mem, l2 } = setup();
    l2.put("k", 1);
    l2.flush();
    l2.put("k", undefined);
    l2.flush();
    assert.deepEqual(l2Keys(mem), []);
  });

  it("keys(prefix): stored and pending keys, oldest savedAt first; a new L2 loads them from storage", async () => {
    const { clock, kv, l2 } = setup();
    l2.put("item:1:", 1);
    await clock.advance(1000);
    l2.put("item:2:", 2);
    l2.put("shelf:hot:", 3);
    await clock.advance(1000);
    l2.put("item:1:", 11);
    assert.deepEqual(l2.keys("item:"), ["item:2:", "item:1:"]);
    l2.remove("item:2:");
    l2.put("item:3:", 3);
    l2.put("item:1:", undefined);
    assert.deepEqual(l2.keys("item:"), ["item:3:"]);
    l2.flush();
    const again = new L2(kv, clock);
    assert.deepEqual([again.keys("item:"), again.keys("shelf:"), again.keys("nope:")], [["item:3:"], ["shelf:hot:"], []]);
  });

  it("survives KvStore purging kp.l2.* behind its back", () => {
    const { kv, mem, l2 } = setup({ maxBytes: 1000 });
    l2.put("a", sized(400));
    l2.put("b", sized(400));
    l2.flush();
    kv.removeNs("l2");
    l2.put("c", sized(400));
    l2.put("d", sized(400));
    l2.flush();
    assert.deepEqual(l2Keys(mem), ["kp.l2.c", "kp.l2.d"]);
  });
});
