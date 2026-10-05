import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KvStore, type Ns, type StorageLike } from "../../src/bridge/storage.ts";
import { Logger } from "../../src/core/log.ts";
import { FakeClock } from "../helpers/fake-clock.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";

const NS: Ns[] = ["auth", "cfg", "out", "l2"];

function setup(quotaBytes?: number): { mem: MemoryStorage; log: Logger; kv: KvStore } {
  const mem = new MemoryStorage(quotaBytes === undefined ? undefined : { quotaBytes });
  const log = new Logger(new FakeClock());
  return { mem, log, kv: new KvStore(mem, log) };
}

/** Пишет в l2 записи по ~200 байт, пока хранилище не откажет; возвращает число записанных. */
function fillL2(kv: KvStore): number {
  const chunk = "x".repeat(80);
  let n = 0;
  while (kv.set("l2", `c${n}`, chunk)) n++;
  return n;
}

const messages = (log: Logger): string[] => log.entries().map((e) => `${e.level}:${e.tag}:${e.msg}`);

describe("KvStore", () => {
  it("writes and reads JSON in all four namespaces under kp.<ns>.<key>", () => {
    const { mem, kv } = setup();
    for (const ns of NS) {
      assert.equal(kv.set(ns, "v", { ns, n: 1, list: [1, "a"] }), true);
      assert.deepEqual(kv.get(ns, "v"), { ns, n: 1, list: [1, "a"] });
      assert.equal(mem.getItem(`kp.${ns}.v`), JSON.stringify({ ns, n: 1, list: [1, "a"] }));
    }
    kv.set("cfg", "flags", { streamMode: "hls2" });
    assert.equal(mem.getItem("kp.cfg.flags"), '{"streamMode":"hls2"}');
    kv.set("auth", "gen", 0);
    kv.set("out", "flag", false);
    kv.set("out", "s", "строка");
    assert.equal(kv.get<number>("auth", "gen"), 0);
    assert.equal(kv.get<boolean>("out", "flag"), false);
    assert.equal(kv.get<string>("out", "s"), "строка");
  });

  it("returns undefined for a missing key and keeps namespaces apart", () => {
    const { kv } = setup();
    kv.set("auth", "k", 1);
    assert.equal(kv.get("cfg", "k"), undefined);
    assert.equal(kv.get("auth", "missing"), undefined);
  });

  it("set with undefined removes the key", () => {
    const { mem, kv } = setup();
    kv.set("cfg", "k", 1);
    assert.equal(kv.set("cfg", "k", undefined), true);
    assert.equal(mem.getItem("kp.cfg.k"), null);
  });

  it("remove deletes one key only", () => {
    const { kv } = setup();
    kv.set("out", "a", 1);
    kv.set("out", "b", 2);
    kv.remove("out", "a");
    kv.remove("out", "missing");
    assert.deepEqual(kv.keys("out"), ["b"]);
  });

  it("keys lists keys of one namespace without the prefix", () => {
    const { mem, kv } = setup();
    mem.setItem("other.x", "1");
    mem.setItem("kp.l2x", "1");
    kv.set("l2", "list:abc", 1);
    kv.set("l2", "item:7", 2);
    kv.set("auth", "pair", 3);
    assert.deepEqual(kv.keys("l2").sort(), ["item:7", "list:abc"]);
    assert.deepEqual(kv.keys("auth"), ["pair"]);
    assert.deepEqual(kv.keys("out"), []);
  });

  it('removeNs("l2") deletes only kp.l2.*', () => {
    const { mem, kv } = setup();
    mem.setItem("other.x", "1");
    kv.set("auth", "pair", { access: "mock-at-1" });
    kv.set("cfg", "flags", {});
    kv.set("out", "q", []);
    for (let i = 0; i < 5; i++) kv.set("l2", `k${i}`, i);
    kv.removeNs("l2");
    assert.deepEqual(kv.keys("l2"), []);
    assert.deepEqual(kv.get("auth", "pair"), { access: "mock-at-1" });
    assert.deepEqual(kv.keys("cfg"), ["flags"]);
    assert.deepEqual(kv.keys("out"), ["q"]);
    assert.equal(mem.getItem("other.x"), "1");
  });

  it("bytes counts (full key + value) × 2 per namespace", () => {
    const { mem, kv } = setup();
    kv.set("l2", "a", "xy");
    kv.set("l2", "bb", 1);
    kv.set("auth", "a", 1);
    const expected = ("kp.l2.a".length + '"xy"'.length + "kp.l2.bb".length + "1".length) * 2;
    assert.equal(kv.bytes("l2"), expected);
    assert.equal(kv.bytes("out"), 0);
    assert.equal(kv.bytes("l2") + kv.bytes("auth"), mem.usedBytes());
  });

  it("on quota overflow while writing auth purges l2 and retries", () => {
    const { mem, log, kv } = setup(4000);
    kv.set("cfg", "flags", { streamMode: "hls2" });
    const filled = fillL2(kv);
    assert.ok(filled > 5, `l2 filled with ${filled} entries`);
    const pair = { access: "mock-at-2", refresh: "mock-rt-2", expiresAt: 123 };
    assert.equal(kv.set("auth", "pair", pair), true);
    assert.deepEqual(kv.get("auth", "pair"), pair);
    assert.deepEqual(kv.keys("l2"), []);
    assert.deepEqual(kv.get("cfg", "flags"), { streamMode: "hls2" });
    assert.ok(messages(log).includes("warn:storage:quota_purge_l2"), messages(log).join("\n"));
    assert.ok(mem.usedBytes() <= 4000);
  });

  it("purges l2 for cfg and out as well", () => {
    for (const ns of ["cfg", "out"] as const) {
      const { log, kv } = setup(4000);
      fillL2(kv);
      assert.equal(kv.set(ns, "v", "y".repeat(100)), true, ns);
      assert.deepEqual(kv.keys("l2"), [], ns);
      assert.ok(messages(log).includes("warn:storage:quota_purge_l2"), ns);
    }
  });

  it("onL2Purged: listeners hear the quota purge and removeNs('l2'), nothing else", () => {
    const { kv } = setup(4000);
    let calls = 0;
    kv.onL2Purged(() => (calls += 1));
    fillL2(kv);
    assert.equal(kv.set("l2", "one-more", "z".repeat(4000)), false);
    kv.removeNs("auth");
    assert.equal(calls, 0);
    assert.equal(kv.set("auth", "pair", { access: "mock-at-1" }), true);
    assert.equal(calls, 1);
    kv.removeNs("l2");
    assert.equal(calls, 2);
  });

  it("on quota overflow while writing l2 returns false and deletes nothing", () => {
    const { log, kv } = setup(4000);
    kv.set("auth", "pair", { access: "mock-at-1" });
    kv.set("cfg", "flags", { heartbeat: "timer" });
    kv.set("out", "q", [1, 2]);
    const filled = fillL2(kv);
    assert.equal(kv.set("l2", "one-more", "z".repeat(80)), false);
    assert.equal(kv.keys("l2").length, filled);
    assert.equal(kv.get("l2", "one-more"), undefined);
    assert.deepEqual(kv.get("auth", "pair"), { access: "mock-at-1" });
    assert.deepEqual(kv.get("cfg", "flags"), { heartbeat: "timer" });
    assert.deepEqual(kv.get("out", "q"), [1, 2]);
    assert.ok(!messages(log).includes("warn:storage:quota_purge_l2"));
  });

  it("returns false when the value does not fit even after purging l2", () => {
    const { log, kv } = setup(1000);
    kv.set("l2", "a", 1);
    assert.equal(kv.set("auth", "big", "q".repeat(2000)), false);
    assert.equal(kv.get("auth", "big"), undefined);
    assert.ok(messages(log).includes("error:storage:set_failed"), messages(log).join("\n"));
  });

  it("recognises quota errors by code 22 and other write errors return false", () => {
    let fail: Error | undefined;
    const backing = new MemoryStorage();
    const flaky: StorageLike = {
      getItem: (k) => backing.getItem(k),
      removeItem: (k) => backing.removeItem(k),
      key: (i) => backing.key(i),
      get length() {
        return backing.length;
      },
      setItem(k, v) {
        const e = fail;
        fail = undefined;
        if (e) throw e;
        backing.setItem(k, v);
      },
    };
    const log = new Logger(new FakeClock());
    const kv = new KvStore(flaky, log);
    kv.set("l2", "a", 1);

    fail = Object.assign(new Error("full"), { name: "QUOTA_EXCEEDED_ERR", code: 22 });
    assert.equal(kv.set("auth", "pair", 1), true);
    assert.deepEqual(kv.keys("l2"), []);

    fail = Object.assign(new Error("denied"), { name: "SecurityError", code: 18 });
    assert.equal(kv.set("auth", "x", 1), false);
    assert.equal(kv.get("auth", "x"), undefined);
    assert.ok(messages(log).includes("error:storage:set_failed"));
  });

  it("returns undefined and warns for broken JSON", () => {
    const { mem, log, kv } = setup();
    mem.setItem("kp.out.q", "{not json");
    assert.equal(kv.get("out", "q"), undefined);
    const e = log.entries().find((x) => x.msg === "bad_json");
    assert.equal(e?.level, "warn");
    assert.equal(e?.data?.key, "kp.out.q");
  });

  it("works without a logger", () => {
    const mem = new MemoryStorage({ quotaBytes: 500 });
    const kv = new KvStore(mem);
    mem.setItem("kp.cfg.bad", "{");
    assert.equal(kv.get("cfg", "bad"), undefined);
    kv.set("l2", "a", "x".repeat(100));
    assert.equal(kv.set("auth", "a", "y".repeat(150)), true);
    assert.equal(kv.set("auth", "b", "y".repeat(400)), false);
  });

  it("has no clear method", () => {
    assert.equal("clear" in KvStore.prototype, false);
    const { kv } = setup();
    assert.equal((kv as unknown as Record<string, unknown>).clear, undefined);
  });
});
