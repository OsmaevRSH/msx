import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KpError } from "../../src/core/errors.ts";
import { FAKE_EPOCH, FakeClock } from "../helpers/fake-clock.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";
import { EP, MOVIE, logged, marktimes, toggles, useApps, watchingReads } from "./progress-rig.ts";

const make = useApps();

const DAY_MS = 86_400_000;
const net = (): KpError => new KpError("KP-NET", "network");

describe("Outbox.setWatched: status check first (спец. §10.3, CM-01, Р-20)", () => {
  it("status already equals the desired one → done without toggle", async () => {
    const t = await make();
    assert.equal(await t.run(t.ctx.outbox.setWatched(EP.item, 1, 1, 1)), "done");
    assert.equal(watchingReads(t).length, 1);
    assert.equal(toggles(t).length, 0);
    assert.equal(t.ctx.outbox.size(), 0);
  });

  it("status differs → GET /v1/watching, then one toggle; desired 0 un-marks", async () => {
    const t = await make();
    assert.equal(await t.run(t.ctx.outbox.setWatched(EP.item, 1, 5, 1)), "done");
    assert.deepEqual(t.mock.calls().map((c) => c.path), ["/v1/watching", "/v1/watching/toggle"]);
    assert.equal(t.mock.state.watching.get("2001:1:5")?.status, 1);
    assert.equal(await t.run(t.ctx.outbox.setWatched(EP.item, 1, 5, 0)), "done");
    assert.equal(toggles(t).length, 2);
    assert.equal(t.mock.state.watching.get("2001:1:5")?.status, -1);
  });

  it("a movie toggle goes without season", async () => {
    const t = await make();
    assert.equal(await t.run(t.ctx.outbox.setWatched(MOVIE.item, 0, 1, 1)), "done");
    assert.equal(new URLSearchParams(toggles(t)[0]?.query).has("season"), false);
    assert.equal(t.mock.state.watching.get(`${MOVIE.item}:0:1`)?.status, 1);
  });

  it("the toggle answer contradicts the desired state → one more toggle and check (Plan B §9.4 п. 3)", async () => {
    const t = await make();
    const seen: string[] = [];
    const answers: (0 | 1)[] = [0, 1];
    t.ctx.api.watching = async () => {
      seen.push("watching");
      return [{ number: 5, season: 1, status: -1, time: 0, duration: EP.duration }];
    };
    t.ctx.api.toggle = async () => {
      seen.push("toggle");
      return { watched: answers.shift() ?? 0 };
    };
    assert.equal(await t.run(t.ctx.outbox.setWatched(EP.item, 1, 5, 1)), "done");
    assert.deepEqual(seen, ["watching", "toggle", "toggle"]);
  });

  it("status check fails (watching dropped) → queued, no toggle; flush keeps the record without toggle", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/watching$", drop: true }] });
    assert.equal(await t.run(t.ctx.outbox.setWatched(EP.item, 1, 5, 1)), "queued");
    assert.equal(toggles(t).length, 0);
    assert.equal(t.ctx.outbox.size(), 1);
    assert.ok(t.storage.getItem("kp.out.w_2001_1_5") !== null);
    await t.run(t.ctx.outbox.flush());
    assert.equal(toggles(t).length, 0);
    assert.equal(t.ctx.outbox.size(), 1);

    t.mock.setScenario({ rules: [] });
    await t.clock.advance(20_000);   // circuit breaker после серии обрывов снова пропускает запросы
    await t.run(t.ctx.outbox.flush());
    assert.equal(toggles(t).length, 1);
    assert.equal(t.ctx.outbox.size(), 0);
    assert.equal(t.mock.state.watching.get("2001:1:5")?.status, 1);
  });
});

describe("Outbox: records and flush", () => {
  it("records live in kp.out.m_* and kp.out.w_*; size() ignores kp.out.overlay; m_* keeps the last position", async () => {
    const t = await make();
    t.ctx.store.set("out", "overlay", "{}");
    t.ctx.outbox.putMarktime(EP.item, 1, 5, 100);
    t.ctx.outbox.putMarktime(EP.item, 1, 5, 160);
    t.ctx.api.watching = async () => {
      throw net();
    };
    assert.equal(await t.run(t.ctx.outbox.setWatched(EP.item, 1, 5, 1)), "queued");
    assert.equal(t.ctx.outbox.size(), 2);
    const m = t.ctx.store.get<{ time: number; createdAt: number; attempts: number; nextAt: number }>("out", "m_2001_1_5");
    assert.equal(m?.time, 160);
    assert.equal(m?.attempts, 0);
    assert.equal(m?.nextAt, t.clock.now() + 10_000);
    assert.equal(m?.createdAt, t.clock.now());
    assert.equal(t.ctx.store.get<{ desired: number }>("out", "w_2001_1_5")?.desired, 1);
  });

  it("flush sends m_* before w_* and removes delivered records", async () => {
    const t = await make();
    const seen: string[] = [];
    t.ctx.api.watching = async () => {
      throw net();
    };
    await t.run(t.ctx.outbox.setWatched(EP.item, 1, 5, 1));
    t.ctx.outbox.putMarktime(EP.item, 1, 5, 2300);
    t.ctx.api.watching = async () => {
      seen.push("watching");
      return [{ number: 5, season: 1, status: -1, time: 0, duration: EP.duration }];
    };
    t.ctx.api.toggle = async () => {
      seen.push("toggle");
      return { watched: 1 };
    };
    t.ctx.api.marktime = async (id, video, time, season) => {
      seen.push(`marktime ${id} ${video} ${time} ${season}`);
    };
    await t.run(t.ctx.outbox.flush());
    assert.deepEqual(seen, ["marktime 2001 5 2300 1", "watching", "toggle"]);
    assert.equal(t.ctx.outbox.size(), 0);
  });

  it("request class: retries from kp.out.* go bg, setWatched from the tracker goes fg (Plan B §9.5)", async () => {
    const t = await make();
    const seen: string[] = [];
    const send = t.ctx.transport.send.bind(t.ctx.transport);
    t.ctx.transport.send = (req) => {
      seen.push(`${req.cls} ${req.path}`);
      return send(req);
    };
    const now = t.clock.now();
    t.ctx.store.set("out", "w_2001_1_5", { item: EP.item, season: 1, video: 5, desired: 1, createdAt: now, attempts: 0, nextAt: now });
    t.ctx.outbox.putMarktime(EP.item, 1, 4, 300);
    await t.run(t.ctx.outbox.flush());
    assert.deepEqual(seen, ["bg /v1/watching/marktime", "bg /v1/watching", "bg /v1/watching/toggle"]);
    assert.equal(t.ctx.outbox.size(), 0);
    seen.length = 0;
    assert.equal(await t.run(t.ctx.outbox.setWatched(EP.item, 1, 5, 0)), "done");
    assert.deepEqual(seen, ["fg /v1/watching", "fg /v1/watching/toggle"]);
  });

  it("retries 10 s → 30 s → 2 min → 10 min → every 30 min", async () => {
    const t = await make();
    const at: number[] = [];
    t.ctx.api.marktime = async () => {
      at.push(t.clock.now());
      throw net();
    };
    const t0 = t.clock.now();
    t.ctx.outbox.putMarktime(EP.item, 1, 5, 300);
    t.ctx.outbox.start();
    await t.clock.advance(2 * 3_600_000);
    const gaps = at.map((x, i) => x - (i === 0 ? t0 : (at[i - 1] as number)));
    assert.deepEqual(gaps.slice(0, 6), [10_000, 30_000, 120_000, 600_000, 1_800_000, 1_800_000]);
    assert.equal(t.ctx.outbox.size(), 1);
    assert.equal(t.ctx.store.get<{ attempts: number }>("out", "m_2001_1_5")?.attempts, at.length);
  });

  it("4xx other than 401/429 → the record is removed with log.error", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/watching/marktime$", status: 404 }] });
    t.ctx.outbox.putMarktime(EP.item, 1, 5, 300);
    await t.run(t.ctx.outbox.flush());
    assert.equal(marktimes(t).length, 1);
    assert.equal(t.ctx.outbox.size(), 0);
    assert.equal(logged(t, "outbox_dropped"), 1);
    assert.ok(t.ctx.log.entries().some((e) => e.level === "error" && e.msg === "outbox_dropped"));
  });

  it("429 keeps the record for the next attempt", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/watching/marktime$", status: 429 }] });
    t.ctx.outbox.putMarktime(EP.item, 1, 5, 300);
    await t.run(t.ctx.outbox.flush());
    assert.equal(marktimes(t).length, 3);
    assert.equal(t.ctx.outbox.size(), 1);
    assert.equal(t.ctx.store.get<{ attempts: number }>("out", "m_2001_1_5")?.attempts, 1);
  });

  it("a record older than 7 days is removed with log.warn and not sent (TV off for 8 days)", async () => {
    const t = await make();
    const storage = new MemoryStorage();
    const first = await make({ mock: t.mock, storage });
    first.ctx.outbox.putMarktime(EP.item, 1, 5, 300);
    const later = await make({ mock: t.mock, storage, clock: new FakeClock(FAKE_EPOCH + 8 * DAY_MS), loggedIn: false });
    await later.run(later.ctx.outbox.flush());
    assert.equal(marktimes(t).length, 0);
    assert.equal(later.ctx.outbox.size(), 0);
    assert.equal(storage.getItem("kp.out.m_2001_1_5"), null);
    assert.ok(later.ctx.log.entries().some((e) => e.level === "warn" && e.msg === "outbox_expired"));
  });

  it("a newer direct marktime makes the queued older position obsolete", async () => {
    const t = await make();
    t.ctx.outbox.putMarktime(EP.item, 1, 5, 300);
    t.ctx.outbox.forgetMarktime(EP.item, 1, 5);
    assert.equal(t.ctx.outbox.size(), 0);
  });
});

describe("Outbox: an older marktime never replaces a newer one (этап 33c)", () => {
  it("records carry the decision time: an older decision does not overwrite a newer record", async () => {
    const t = await make();
    const now = t.clock.now();
    t.ctx.outbox.putMarktime(EP.item, 1, 5, 2000, now - 1000);
    t.ctx.outbox.putMarktime(EP.item, 1, 5, 600, now - 5000);
    assert.equal(t.ctx.store.get<{ time: number }>("out", "m_2001_1_5")?.time, 2000);
    assert.equal(logged(t, "marktime_stale_dropped"), 1);
  });

  it("a position decided before a delivered one is not queued, even if its request failed only now", async () => {
    const t = await make();
    const now = t.clock.now();
    t.ctx.outbox.forgetMarktime(EP.item, 1, 5, now - 1000);
    t.ctx.outbox.putMarktime(EP.item, 1, 5, 600, now - 5000);
    assert.equal(t.ctx.outbox.size(), 0);
    t.ctx.outbox.putMarktime(EP.item, 1, 5, 2100, now);
    assert.equal(t.ctx.outbox.size(), 1, "a later decision is queued as usual");
  });

  it("forgetMarktime compares decision times, not the moment the record was written", async () => {
    const t = await make();
    const now = t.clock.now();
    t.ctx.outbox.putMarktime(EP.item, 1, 5, 600, now - 5000);
    t.ctx.outbox.forgetMarktime(EP.item, 1, 5, now - 1000);
    assert.equal(t.ctx.outbox.size(), 0);
  });

  it("the TV clock went back after a restart: a new decision is still newer than the stored record", async () => {
    const t = await make();
    const later = t.clock.now() + 3_600_000;
    t.ctx.store.set("out", "m_2001_1_5", { item: EP.item, season: 1, video: 5, time: 600, at: later, createdAt: later, attempts: 0, nextAt: later });
    assert.equal(t.ctx.outbox.putMarktime(EP.item, 1, 5, 2000), true);
    assert.equal(t.ctx.store.get<{ time: number }>("out", "m_2001_1_5")?.time, 2000);
    t.ctx.outbox.forgetMarktime(EP.item, 1, 5);
    assert.equal(t.ctx.outbox.size(), 0);
  });

  it("a record from an older version without the decision time still works (createdAt)", async () => {
    const t = await make();
    const now = t.clock.now();
    t.ctx.store.set("out", "m_2001_1_5", { item: EP.item, season: 1, video: 5, time: 300, createdAt: now, attempts: 0, nextAt: now });
    t.ctx.outbox.forgetMarktime(EP.item, 1, 5, now - 1);
    assert.equal(t.ctx.outbox.size(), 1);
    t.ctx.outbox.forgetMarktime(EP.item, 1, 5, now);
    assert.equal(t.ctx.outbox.size(), 0);
  });
});
