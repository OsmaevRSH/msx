import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TrackerEvent } from "../../src/progress/tracker.ts";
import type { TestApp } from "../helpers/harness.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";
import {
  EP, apiCalls, load, marktimes, noCorsCalls, pct, player, recordEvents, snapshot, toggles, useApps, waitFor, watchingReads,
} from "./progress-rig.ts";

// Contract-тесты outbox против kpmock (спец. §10.3, §14.3: CC-10, CC-13; CM-01).

const make = useApps();

const watchedResults = (ev: TrackerEvent[]): string[] =>
  ev.filter((e): e is Extract<TrackerEvent, { kind: "watched" }> => e.kind === "watched").map((e) => e.result);

/** CM-01: каждая проба `no-cors` — только `GET /v1/types?access_token=x`; простые запросы без preflight (CC-01). */
function assertProbesClean(t: TestApp): void {
  for (const c of noCorsCalls(t)) assert.equal(`${c.method} ${c.path}?${c.query}`, "GET /v1/types?access_token=x");
  assert.equal(t.mock.calls().filter((c) => c.method === "OPTIONS").length, 0);
  assert.equal(t.fetch.preflights, 0);
}

/** Отметка «просмотрено» через трекер: снимок на 92 % (спец. §10.1, `trigger:90%`). */
async function watchTo92(t: TestApp, ev: TrackerEvent[]): Promise<void> {
  load(t);
  player(t, "play", { state: 1, position: 0, duration: EP.duration });
  snapshot(t, pct(EP, 92));
  await waitFor(t, () => watchedResults(ev).length === 1, "watched result");
}

describe("Outbox against kpmock (contract)", () => {
  it("CC-10: marktime dropped → kp.out.m_* → plugin restart on the same storage → ready() → delivered, record removed", async () => {
    const storage = new MemoryStorage();
    const a = await make({ storage });
    a.mock.setScenario({ rules: [{ path: "^/v1/watching/marktime$", drop: true }] });
    load(a);
    player(a, "pause", { state: 2, position: 700, duration: EP.duration });
    await waitFor(a, () => a.ctx.outbox.size() === 1, "queued marktime");
    assert.ok(storage.getItem("kp.out.m_2001_1_5")?.includes("700"));
    assert.ok(apiCalls(a, "/v1/watching/marktime").every((c) => c.status === 0));
    assert.equal(a.mock.state.watching.get("2001:1:5"), undefined);

    a.mock.setScenario({ rules: [] });
    const b = await make({ mock: a.mock, storage, loggedIn: false });
    const t0 = b.clock.now();
    b.app.ready();
    await waitFor(b, () => b.ctx.outbox.size() === 0, "delivered after restart");
    assert.ok(b.clock.now() - t0 < 10_000, "ready flushes at once, not by the retry timer");
    const delivered = apiCalls(b, "/v1/watching/marktime").filter((c) => c.status === 200).map((c) => c.query);
    assert.deepEqual(delivered.map((s) => new URLSearchParams(s).get("time")), ["700"]);
    assert.deepEqual(marktimes(b).at(-1), { id: EP.item, video: 5, season: 1, time: 700 });
    assert.equal(b.mock.state.watching.get("2001:1:5")?.time, 700);
    assert.equal(storage.getItem("kp.out.m_2001_1_5"), null);
    assertProbesClean(b);
  });

  it("CC-13 toggle_lost_response: queued, no automatic toggle; flush → GET /v1/watching and no new toggle; status 1", async () => {
    const t = await make();
    const ev = recordEvents(t);
    t.mock.setScenario({ toggleLostResponse: 1 });
    await watchTo92(t, ev);
    assert.deepEqual(watchedResults(ev), ["queued"]);
    assert.equal(toggles(t).length, 1);
    assert.equal(toggles(t)[0]?.status, 0, "the toggle was applied, its answer lost");
    assert.equal(watchingReads(t).length, 1, "status check before the first toggle (Р-20)");
    assert.equal(t.ctx.outbox.size(), 1);
    assert.equal(t.ctx.store.get<{ desired: number }>("out", "w_2001_1_5")?.desired, 1, "desired state, not a toggle command");
    assert.equal(t.ctx.overlay.get(EP.item, 1, 5)?.status, 1);

    await t.run(t.ctx.outbox.flush());
    assert.equal(watchingReads(t).length, 2);
    assert.equal(toggles(t).length, 1, "no new toggle: the status already equals the desired one");
    assert.equal(t.ctx.outbox.size(), 0);
    assert.equal(t.mock.state.watching.get("2001:1:5")?.status, 1);
    assertProbesClean(t);
  });

  it("CC-13 toggle_lost_response across a restart: ready() reconciles, still one toggle in total", async () => {
    const storage = new MemoryStorage();
    const a = await make({ storage });
    const ev = recordEvents(a);
    a.mock.setScenario({ toggleLostResponse: 1 });
    await watchTo92(a, ev);
    assert.deepEqual(watchedResults(ev), ["queued"]);

    const b = await make({ mock: a.mock, storage, loggedIn: false });
    b.app.ready();
    await waitFor(b, () => b.ctx.outbox.size() === 0, "reconciled after restart");
    assert.equal(toggles(b).length, 1);
    assert.equal(watchingReads(b).length, 2);
    assert.equal(b.mock.state.watching.get("2001:1:5")?.status, 1);
    assertProbesClean(b);
  });

  it("CC-13: a no-cors probe during the status check never repeats toggle; the record waits for a successful check", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/watching$", drop: true }] });
    assert.equal(await t.run(t.ctx.outbox.setWatched(EP.item, 1, 5, 1)), "queued");
    assert.equal(toggles(t).length, 0);
    assert.ok(noCorsCalls(t).length >= 1, "three TypeErrors in a row trigger the probe");
    assertProbesClean(t);

    await t.run(t.ctx.outbox.flush());
    assert.equal(toggles(t).length, 0, "status check failed → no toggle");
    assert.equal(t.ctx.outbox.size(), 1);

    t.mock.setScenario({ rules: [] });
    await waitFor(t, () => t.ctx.outbox.size() === 0, "retry timer delivers", 120_000, 1000);
    assert.equal(toggles(t).length, 1);
    assert.equal(t.mock.state.watching.get("2001:1:5")?.status, 1);
    assertProbesClean(t);
  });
});
