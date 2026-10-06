import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KvStore } from "../../src/bridge/storage.ts";
import { L2 } from "../../src/cache/l2.ts";
import { Lru } from "../../src/cache/lru.ts";
import { type Policy, SwrCache } from "../../src/cache/swr.ts";
import { KpError } from "../../src/core/errors.ts";
import { Logger } from "../../src/core/log.ts";
import { FAKE_EPOCH, FakeClock } from "../helpers/fake-clock.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";

const TTL = 600_000;
const STALE_MAX = 7 * 24 * 3_600_000;
const PERSIST: Policy = { ttlMs: TTL, staleMaxMs: STALE_MAX, persist: true };
const MEMORY: Policy = { ttlMs: TTL, staleMaxMs: STALE_MAX, persist: false };

function setup(opts?: { mem?: MemoryStorage; clock?: FakeClock }) {
  const clock = opts?.clock ?? new FakeClock();
  const mem = opts?.mem ?? new MemoryStorage();
  const log = new Logger(clock);
  const l2 = new L2(new KvStore(mem, log), clock, undefined, log);
  const cache = new SwrCache({ l1: new Lru(), l2, clock, log });
  return { clock, mem, log, l2, cache };
}

/** Загрузчик, который отдаёт values по очереди и считает вызовы. */
function loader<T>(...values: T[]) {
  const fn = Object.assign(
    async (): Promise<T> => {
      const v = values[Math.min(fn.calls, values.length - 1)] as T;
      fn.calls++;
      return v;
    },
    { calls: 0 },
  );
  return fn;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

const l2Keys = (mem: MemoryStorage): string[] => {
  const out: string[] = [];
  for (let i = 0; i < mem.length; i++) {
    const k = mem.key(i);
    if (k?.startsWith("kp.l2.")) out.push(k);
  }
  return out.sort();
};

const failNet = async (): Promise<never> => {
  throw new TypeError("Failed to fetch");
};

describe("SwrCache", () => {
  it("miss: waits for load, then serves the fresh entry from L1 without calling load", async () => {
    const { clock, cache } = setup();
    const load = loader({ id: 1 });
    assert.deepEqual(await cache.get("item:1", PERSIST, load), {
      value: { id: 1 },
      fetchedAt: FAKE_EPOCH,
      stale: false,
      source: "net",
    });
    await clock.advance(TTL - 1);
    assert.deepEqual(await cache.get("item:1", PERSIST, load), {
      value: { id: 1 },
      fetchedAt: FAKE_EPOCH,
      stale: false,
      source: "l1",
    });
    assert.equal(load.calls, 1);
  });

  it("stale within staleMax: returns at once, exactly one background load, onRefreshed gets the new value", async () => {
    const { clock, cache } = setup();
    await cache.get("home", PERSIST, loader("v1"));
    await clock.advance(TTL);
    const d = deferred<string>();
    let calls = 0;
    const load = (): Promise<string> => {
      calls++;
      return d.promise;
    };
    const refreshed: string[] = [];
    const a = await cache.get("home", PERSIST, load, { onRefreshed: (v) => refreshed.push(`a:${v}`) });
    const b = await cache.get("home", PERSIST, load, { onRefreshed: (v) => refreshed.push(`b:${v}`) });
    assert.deepEqual(a, { value: "v1", fetchedAt: FAKE_EPOCH, stale: true, source: "l1" });
    assert.deepEqual(b, a);
    assert.equal(calls, 1);
    assert.deepEqual(refreshed, []);
    d.resolve("v2");
    await clock.advance(0);
    assert.deepEqual(refreshed, ["a:v2", "b:v2"]);
    assert.deepEqual(await cache.get("home", PERSIST, load), {
      value: "v2",
      fetchedAt: FAKE_EPOCH + TTL,
      stale: false,
      source: "l1",
    });
    assert.equal(calls, 1);
  });

  it("five concurrent gets with no data share one load", async () => {
    const { cache } = setup();
    const d = deferred<number[]>();
    let calls = 0;
    const load = (): Promise<number[]> => {
      calls++;
      return d.promise;
    };
    const all = Promise.all([1, 2, 3, 4, 5].map(() => cache.get("genres:movie", PERSIST, load)));
    d.resolve([1, 2]);
    const got = await all;
    assert.equal(calls, 1);
    for (const g of got) assert.deepEqual(g, { value: [1, 2], fetchedAt: FAKE_EPOCH, stale: false, source: "net" });
  });

  it("older than staleMax: waits for a new load instead of serving the old value", async () => {
    const { clock, cache } = setup();
    await cache.get("k", PERSIST, loader("old"));
    await clock.advance(STALE_MAX);
    assert.deepEqual(await cache.get("k", PERSIST, loader("new")), {
      value: "new",
      fetchedAt: FAKE_EPOCH + STALE_MAX,
      stale: false,
      source: "net",
    });
  });

  it("load error with an entry older than staleMax returns that entry with offline code", async () => {
    const { clock, cache } = setup();
    await cache.get("k", PERSIST, loader("old"));
    await clock.advance(STALE_MAX + 1);
    assert.deepEqual(await cache.get("k", PERSIST, failNet), {
      value: "old",
      fetchedAt: FAKE_EPOCH,
      stale: true,
      source: "l1",
      offline: "KP-NET",
    });
  });

  it("X-1: after a failed load an entry older than staleMax is served at once with offline, refreshed in the background", async () => {
    const { clock, cache } = setup();
    await cache.get("k", PERSIST, loader("old"));
    await clock.advance(STALE_MAX + 1);
    await cache.get("k", PERSIST, failNet);
    const hang = deferred<string>();
    let calls = 0;
    const slow = (): Promise<string> => {
      calls++;
      return hang.promise;
    };
    const want = { value: "old", fetchedAt: FAKE_EPOCH, stale: true, source: "l1", offline: "KP-NET" };
    assert.deepEqual(await cache.get("k", PERSIST, slow), want);
    assert.deepEqual(await cache.get("k", PERSIST, slow), want, "the refresh in flight is not waited for either");
    assert.equal(calls, 1, "one background refresh");
    hang.resolve("new");
    await clock.advance(0);
    assert.deepEqual(await cache.get("k", PERSIST, slow), { value: "new", fetchedAt: FAKE_EPOCH + STALE_MAX + 1, stale: false, source: "l1" });
  });

  it("X-1: a successful load clears the failure: the next entry older than staleMax waits for the network again", async () => {
    const { clock, cache } = setup();
    await cache.get("k", PERSIST, loader("v1"));
    await clock.advance(STALE_MAX + 1);
    await cache.get("k", PERSIST, failNet);
    await cache.get("k", PERSIST, loader("v2"));
    await clock.advance(0);
    await clock.advance(STALE_MAX + 1);
    assert.deepEqual(await cache.get("k", PERSIST, loader("v3")), {
      value: "v3", fetchedAt: FAKE_EPOCH + 2 * (STALE_MAX + 1), stale: false, source: "net",
    });
  });

  it("X-1: staleMax 0 (stream links) is never served after a failure", async () => {
    const { clock, cache } = setup();
    const links: Policy = { ttlMs: TTL, staleMaxMs: 0, persist: false };
    await cache.get("k", links, loader("old"));
    await clock.advance(TTL);
    assert.equal((await cache.get("k", links, failNet)).offline, "KP-NET");
    assert.deepEqual(await cache.get("k", links, loader("new")), { value: "new", fetchedAt: FAKE_EPOCH + TTL, stale: false, source: "net" });
  });

  it("load error without any entry throws a KpError", async () => {
    const { cache } = setup();
    await assert.rejects(cache.get("k", PERSIST, failNet), (e: unknown) => e instanceof KpError && e.code === "KP-NET");
    const fail5xx = async (): Promise<never> => {
      throw new KpError("KP-5XX", "server", 502);
    };
    await assert.rejects(cache.get("k", PERSIST, fail5xx), (e: unknown) => e instanceof KpError && e.code === "KP-5XX");
    const syncThrow = (): Promise<never> => {
      throw new Error("boom");
    };
    await assert.rejects(cache.get("k", PERSIST, syncThrow), (e: unknown) => e instanceof KpError && e.code === "KP-BAD");
    assert.equal(cache.peek("k"), undefined);
    assert.deepEqual(await cache.get("k", PERSIST, loader("ok")), { value: "ok", fetchedAt: FAKE_EPOCH, stale: false, source: "net" });
  });

  it("a background refresh failure keeps the stale entry, logs a warning and retries on the next get", async () => {
    const { clock, log, cache } = setup();
    await cache.get("k", PERSIST, loader("v1"));
    await clock.advance(TTL);
    let refreshed = 0;
    const got = await cache.get("k", PERSIST, failNet, { onRefreshed: () => refreshed++ });
    assert.equal(got.value, "v1");
    await clock.advance(0);
    assert.equal(refreshed, 0);
    assert.ok(log.entries().some((e) => e.level === "warn" && e.tag === "swr" && e.data?.["key"] === "k" && e.data["err"] === "KP-NET"));
    const load = loader("v2");
    assert.equal((await cache.get("k", PERSIST, load)).stale, true);
    await clock.advance(0);
    assert.equal(load.calls, 1);
    assert.equal((await cache.get("k", PERSIST, load)).value, "v2");
  });

  it("a throwing onRefreshed does not break the cache", async () => {
    const { clock, cache } = setup();
    await cache.get("k", PERSIST, loader("v1"));
    await clock.advance(TTL);
    await cache.get("k", PERSIST, loader("v2"), {
      onRefreshed: () => {
        throw new Error("screen gone");
      },
    });
    await clock.advance(0);
    assert.equal((await cache.get("k", PERSIST, loader("v3"))).value, "v2");
  });

  it("a new SwrCache on the same storage takes the value from L2", async () => {
    const { clock, mem, cache } = setup();
    await cache.get("home:fresh", PERSIST, loader([1, 2, 3]));
    await clock.advance(1000);
    assert.deepEqual(l2Keys(mem), ["kp.l2.home:fresh"]);
    const next = setup({ mem, clock });
    const load = loader([9]);
    assert.deepEqual(await next.cache.get("home:fresh", PERSIST, load), {
      value: [1, 2, 3],
      fetchedAt: FAKE_EPOCH,
      stale: false,
      source: "l2",
    });
    assert.equal(load.calls, 0);
    assert.equal((await next.cache.get("home:fresh", PERSIST, load)).source, "l1");
  });

  it("a stale L2 value is served at once and refreshed in the background into L1 and L2", async () => {
    const { clock, mem, cache } = setup();
    await cache.get("k", PERSIST, loader("old"));
    await clock.advance(TTL + 1000);
    const next = setup({ mem, clock });
    const load = loader("new");
    assert.deepEqual(await next.cache.get("k", PERSIST, load), { value: "old", fetchedAt: FAKE_EPOCH, stale: true, source: "l2" });
    await clock.advance(1000);
    assert.equal(load.calls, 1);
    assert.equal(next.l2.get("k")?.value, "new");
    assert.equal((await next.cache.get("k", PERSIST, load)).value, "new");
  });

  it("persist: false never writes to L2", async () => {
    const { clock, mem, cache } = setup();
    await cache.get("links:1", MEMORY, loader("u1"));
    await clock.advance(TTL);
    await cache.get("links:1", MEMORY, loader("u2"));
    await clock.advance(5000);
    assert.deepEqual(l2Keys(mem), []);
    assert.equal(mem.writes.length, 0);
  });

  it("persist: false does not read an L2 value either", async () => {
    const { clock, mem, cache } = setup();
    await cache.get("k", PERSIST, loader("persisted"));
    await clock.advance(1000);
    const next = setup({ mem, clock });
    assert.equal((await next.cache.get("k", MEMORY, loader("net"))).source, "net");
  });

  it("markStale marks by prefix without deleting and makes the next get refresh in the background", async () => {
    const { clock, cache } = setup();
    await cache.get("items/1", PERSIST, loader("a1"));
    await cache.get("items/2", PERSIST, loader("b1"));
    await cache.get("history", PERSIST, loader("h1"));
    cache.markStale("items/");
    assert.deepEqual(cache.peek("items/1"), { value: "a1", fetchedAt: FAKE_EPOCH, stale: true, source: "l1" });
    assert.equal(cache.peek("history")?.stale, false);
    const load = loader("a2");
    assert.deepEqual(await cache.get("items/1", PERSIST, load), { value: "a1", fetchedAt: FAKE_EPOCH, stale: true, source: "l1" });
    await clock.advance(0);
    assert.equal(load.calls, 1);
    assert.deepEqual(await cache.get("items/1", PERSIST, load), { value: "a2", fetchedAt: FAKE_EPOCH, stale: false, source: "l1" });
    const history = loader("h2");
    assert.equal((await cache.get("history", PERSIST, history)).value, "h1");
    assert.equal(history.calls, 0);
  });

  it("markStale during an in-flight load stores the result already marked", async () => {
    const { clock, cache } = setup();
    const d = deferred<string>();
    const pending = cache.get("items/1", PERSIST, () => d.promise);
    cache.markStale("items/1");
    d.resolve("before-mutation");
    assert.deepEqual(await pending, { value: "before-mutation", fetchedAt: FAKE_EPOCH, stale: true, source: "net" });
    const load = loader("after");
    assert.equal((await cache.get("items/1", PERSIST, load)).stale, true);
    await clock.advance(0);
    assert.equal(load.calls, 1);
  });

  it("markStale also applies to an L2 value saved before the mark and not yet in L1", async () => {
    const { clock, mem, cache } = setup();
    await cache.get("bookmarks/7", PERSIST, loader("v1"));
    await clock.advance(1000);
    const next = setup({ mem, clock });
    next.cache.markStale("bookmarks/7");
    const load = loader("v2");
    assert.deepEqual(await next.cache.get("bookmarks/7", PERSIST, load), {
      value: "v1",
      fetchedAt: FAKE_EPOCH,
      stale: true,
      source: "l2",
    });
    await clock.advance(0);
    assert.equal(load.calls, 1);
  });

  it("force: always loads; on error falls back to the cached entry with offline code", async () => {
    const { clock, cache } = setup();
    await cache.get("k", PERSIST, loader("v1"));
    const load = loader("v2");
    assert.deepEqual(await cache.get("k", PERSIST, load, { force: true }), {
      value: "v2",
      fetchedAt: FAKE_EPOCH,
      stale: false,
      source: "net",
    });
    assert.equal(load.calls, 1);
    await clock.advance(TTL);
    assert.deepEqual(await cache.get("k", PERSIST, failNet, { force: true }), {
      value: "v2",
      fetchedAt: FAKE_EPOCH,
      stale: true,
      source: "l1",
      offline: "KP-NET",
    });
    const { cache: empty } = setup();
    await assert.rejects(empty.get("k", PERSIST, failNet, { force: true }), (e: unknown) => e instanceof KpError);
  });

  it("peek reads L1, then L2, without loading", async () => {
    const { clock, mem, cache } = setup();
    assert.equal(cache.peek("k"), undefined);
    await cache.get("k", PERSIST, loader("v"));
    assert.deepEqual(cache.peek("k"), { value: "v", fetchedAt: FAKE_EPOCH, stale: false, source: "l1" });
    await clock.advance(1000);
    const next = setup({ mem, clock });
    assert.deepEqual(next.cache.peek("k"), { value: "v", fetchedAt: FAKE_EPOCH, stale: false, source: "l2" });
  });

  it("delete removes the entry from L1 and L2", async () => {
    const { clock, mem, cache } = setup();
    await cache.get("k", PERSIST, loader("v"));
    await clock.advance(1000);
    cache.delete("k");
    assert.equal(cache.peek("k"), undefined);
    assert.deepEqual(l2Keys(mem), []);
    const load = loader("v2");
    assert.equal((await cache.get("k", PERSIST, load)).source, "net");
    assert.equal(load.calls, 1);
  });

  it("writes to L2 only through the deferred L2.put", async () => {
    const { clock, mem, cache } = setup();
    await cache.get("k", PERSIST, loader("v"));
    assert.equal(mem.writes.length, 0);
    await clock.advance(1000);
    assert.deepEqual(mem.writes, ["kp.l2.k"]);
  });
});
