import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TokenStore } from "../../src/auth/tokens.ts";
import { KvStore } from "../../src/bridge/storage.ts";
import { FAKE_EPOCH, FakeClock } from "../helpers/fake-clock.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";

function setup(quotaBytes?: number): { mem: MemoryStorage; clock: FakeClock; store: KvStore; tokens: TokenStore } {
  const mem = new MemoryStorage(quotaBytes === undefined ? undefined : { quotaBytes });
  const clock = new FakeClock();
  const store = new KvStore(mem);
  return { mem, clock, store, tokens: new TokenStore(store, clock) };
}

const RAW = { access: "mock-at-1", refresh: "mock-rt-1", expiresIn: 3600 };

describe("TokenStore (spec §7.3, decision Р-16)", () => {
  it("save writes one kp.auth.pair record: gen +1, expiresAt = now + ttl − 30 s", () => {
    const { mem, tokens } = setup();
    assert.equal(tokens.pair(), undefined);
    const first = tokens.save(RAW);
    assert.deepEqual(first, { access: "mock-at-1", refresh: "mock-rt-1", expiresAt: FAKE_EPOCH + 3600_000 - 30_000, gen: 1 });
    assert.deepEqual(JSON.parse(mem.getItem("kp.auth.pair") ?? "null"), first);
    assert.deepEqual(mem.writes, ["kp.auth.pair"], "the pair is a single atomic setItem");
    assert.deepEqual(tokens.pair(), first);
  });

  it("each save increments gen and recomputes expiresAt from the current time", async () => {
    const { clock, tokens } = setup();
    tokens.save(RAW);
    await clock.advance(60_000);
    const second = tokens.save({ access: "mock-at-2", refresh: "mock-rt-2", expiresIn: 600 });
    assert.equal(second.gen, 2);
    assert.equal(second.expiresAt, FAKE_EPOCH + 60_000 + 600_000 - 30_000);
  });

  it("the record is written to storage before save returns; a new TokenStore reads it back", () => {
    const { store, clock, tokens } = setup();
    const saved = tokens.save(RAW);
    assert.deepEqual(new TokenStore(store, clock).pair(), saved);
  });

  it("gen continues from the stored pair after a restart", () => {
    const { store, clock, tokens } = setup();
    tokens.save(RAW);
    tokens.save(RAW);
    assert.equal(new TokenStore(store, clock).save(RAW).gen, 3);
  });

  it("gen never goes back after clear (a stale request cannot match the new session)", () => {
    const { tokens } = setup();
    tokens.save(RAW);
    tokens.save(RAW);
    tokens.clear();
    assert.equal(tokens.save(RAW).gen, 3);
  });

  it("a malformed stored pair is treated as absent", () => {
    const { mem, store, clock } = setup();
    mem.setItem("kp.auth.pair", JSON.stringify({ access: "", refresh: "mock-rt-1", expiresAt: 1, gen: 1 }));
    assert.equal(new TokenStore(store, clock).pair(), undefined);
    mem.setItem("kp.auth.pair", "{not json");
    assert.equal(new TokenStore(store, clock).pair(), undefined);
    mem.setItem("kp.auth.pair", JSON.stringify({ access: "a", refresh: "r", expiresAt: "soon", gen: 1 }));
    assert.equal(new TokenStore(store, clock).pair(), undefined);
  });

  it("device: empty by default, saved as kp.auth.device, returned as a copy", () => {
    const { mem, store, clock, tokens } = setup();
    assert.deepEqual(tokens.device(), {});
    tokens.saveDevice({ id: 42, notifiedVersion: "1.0.0", title: "MSX UE55" });
    assert.deepEqual(JSON.parse(mem.getItem("kp.auth.device") ?? "null"), { id: 42, notifiedVersion: "1.0.0", title: "MSX UE55" });
    const d = tokens.device();
    d.id = 7;
    assert.equal(tokens.device().id, 42);
    assert.deepEqual(new TokenStore(store, clock).device(), { id: 42, notifiedVersion: "1.0.0", title: "MSX UE55" });
  });

  it("device: fields of a wrong type are dropped", () => {
    const { mem, store, clock } = setup();
    mem.setItem("kp.auth.device", JSON.stringify({ id: "42", notifiedVersion: 1, title: "MSX" }));
    assert.deepEqual(new TokenStore(store, clock).device(), { title: "MSX" });
  });

  it("clear removes only kp.auth.* (no localStorage.clear)", () => {
    const { mem, store, tokens } = setup();
    tokens.save(RAW);
    tokens.saveDevice({ id: 1 });
    store.set("auth", "probeMarker", { at: 1 });
    store.set("cfg", "flags", { streamMode: "hls2" });
    store.set("out", "overlay", { a: 1 });
    store.set("l2", "x", "y");
    mem.setItem("other.app", "keep");
    tokens.clear();
    assert.equal(tokens.pair(), undefined);
    assert.deepEqual(tokens.device(), {});
    assert.deepEqual(store.keys("auth"), []);
    assert.deepEqual(store.keys("cfg"), ["flags"]);
    assert.deepEqual(store.keys("out"), ["overlay"]);
    assert.deepEqual(store.keys("l2"), ["x"]);
    assert.equal(mem.getItem("other.app"), "keep");
  });

  it("tokens win over the L2 cache when storage is full (CR-12)", () => {
    const { mem, store, tokens } = setup(2000);
    let n = 0;
    while (store.set("l2", `c${n}`, "x".repeat(80))) n++;
    assert.ok(n > 0);
    const saved = tokens.save(RAW);
    assert.deepEqual(JSON.parse(mem.getItem("kp.auth.pair") ?? "null"), saved);
    assert.deepEqual(store.keys("l2"), []);
  });

  it("if the write still fails, the new pair stays usable in memory (the old one is already dead)", () => {
    const { mem, tokens } = setup(10);
    const saved = tokens.save(RAW);
    assert.equal(mem.getItem("kp.auth.pair"), null);
    assert.deepEqual(tokens.pair(), saved);
  });
});
