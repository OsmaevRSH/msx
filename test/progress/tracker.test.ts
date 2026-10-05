import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TrackerEvent } from "../../src/progress/tracker.ts";
import {
  EP, MOVIE, apiCalls, kpProps, load, logged, marktimes, pass, pct, player, q, recordEvents, snapshot, toggles, useApps,
  waitFor, watchingReads,
} from "./progress-rig.ts";

const make = useApps();

const kinds = (ev: TrackerEvent[], kind: TrackerEvent["kind"]): TrackerEvent[] => ev.filter((e) => e.kind === kind);
const times = (t: Parameters<typeof marktimes>[0]): number[] => marktimes(t).map((m) => m.time);

describe("ProgressTracker: session and start (CC-09)", () => {
  it("video:load with kp:* opens a session; the first video:play → started with TTFF", async () => {
    const t = await make();
    const ev = recordEvents(t);
    t.ctx.state.resolveAt.set(EP.mid, t.clock.perf());
    await t.clock.advance(1500);
    load(t);
    const s = t.ctx.tracker.session();
    assert.ok(s);
    assert.deepEqual([s.itemId, s.mid, s.season, s.video, s.duration, s.hasNext], [EP.item, EP.mid, 1, 5, EP.duration, true]);
    assert.equal(kinds(ev, "load").length, 1);
    player(t, "play", { state: 1, position: 0, duration: EP.duration });
    player(t, "play", { state: 1, position: 40, duration: EP.duration });
    const started = kinds(ev, "started") as Extract<TrackerEvent, { kind: "started" }>[];
    assert.equal(started.length, 1);
    assert.equal(started[0]?.ttffMs, 1500);
    assert.equal(t.ctx.metrics.summary().values.ttff?.n, 1);
    assert.equal(s.started, true);
    const raw = kinds(ev, "raw") as Extract<TrackerEvent, { kind: "raw" }>[];
    assert.deepEqual(raw.map((e) => [e.source, e.name]), [["handleEvent", "video:load"], ["handleEvent", "video:play"], ["handleEvent", "video:play"]]);
  });

  it("without kp:* properties there is no session; every input still gives a raw event", async () => {
    const t = await make();
    const ev = recordEvents(t);
    load(t, { "resume:key": "x" });
    snapshot(t, 300, {});
    player(t, "stop", { position: 300 });
    await pass(t, 3000);
    assert.equal(t.ctx.tracker.session(), undefined);
    assert.deepEqual(ev.map((e) => e.kind), ["raw", "raw", "raw"]);
    assert.equal(marktimes(t).length, 0);
  });

  it("a snapshot opens a session when there is none or the mid differs; a position > 0 counts as started", async () => {
    const t = await make();
    const ev = recordEvents(t);
    snapshot(t, 45);
    assert.equal(t.ctx.tracker.session()?.mid, EP.mid);
    assert.equal(kinds(ev, "started").length, 1);
    snapshot(t, 50, kpProps({ ...EP, mid: EP.mid + 1, video: 6 }));
    assert.equal(t.ctx.tracker.session()?.video, 6);
    assert.equal(kinds(ev, "load").length, 2);
    const raw = kinds(ev, "raw") as Extract<TrackerEvent, { kind: "raw" }>[];
    assert.deepEqual(raw.map((e) => [e.source, e.position]), [["handleData", 45], ["handleData", 50]]);
  });
});

describe("ProgressTracker: marktime (Plan B §9.3)", () => {
  it("snapshots 60 s and 120 s → two marktime with numbers; the same snapshot again and 20 s → no request", async () => {
    const t = await make();
    load(t);
    player(t, "play", { position: 0, duration: EP.duration });
    snapshot(t, 60);
    await waitFor(t, () => marktimes(t).length === 1, "marktime 60");
    snapshot(t, 120);
    await waitFor(t, () => marktimes(t).length === 2, "marktime 120");
    assert.deepEqual(marktimes(t), [
      { id: EP.item, video: 5, season: 1, time: 60 },
      { id: EP.item, video: 5, season: 1, time: 120 },
    ]);
    snapshot(t, 120.4);
    snapshot(t, 20);
    await pass(t, 5000);
    assert.equal(marktimes(t).length, 2);
    assert.deepEqual(t.ctx.overlay.get(EP.item, 1, 5)?.time, 120);
  });

  it("three snapshots within 1.5 s → one deferred marktime with the last position", async () => {
    const t = await make();
    load(t);
    snapshot(t, 300);
    await t.clock.advance(750);
    snapshot(t, 301);
    await t.clock.advance(750);
    snapshot(t, 302);
    await pass(t, 400);
    assert.equal(marktimes(t).length, 0, "snapshots are coalesced for 2 s");
    await waitFor(t, () => marktimes(t).length === 1, "coalesced marktime");
    await pass(t, 3000);
    assert.deepEqual(times(t), [302]);
  });

  it("video:pause → marktime at once; a pending snapshot is superseded", async () => {
    const t = await make();
    load(t);
    player(t, "play", { position: 0, duration: EP.duration });
    snapshot(t, 400);
    player(t, "pause", { state: 2, position: 405, duration: EP.duration });
    await waitFor(t, () => marktimes(t).length === 1, "pause marktime", 1000);
    await pass(t, 3000);
    assert.deepEqual(times(t), [405]);
    player(t, "pause", { state: 2, position: 405.6, duration: EP.duration });
    await pass(t, 3000);
    assert.deepEqual(times(t), [405], "the same position is not sent again");
  });

  it("a movie: marktime without season", async () => {
    const t = await make();
    load(t, kpProps(MOVIE), 0, MOVIE.duration);
    player(t, "pause", { position: 1300, duration: MOVIE.duration });
    await waitFor(t, () => marktimes(t).length === 1, "movie marktime");
    assert.deepEqual(marktimes(t), [{ id: MOVIE.item, video: 1, season: undefined, time: 1300 }]);
    assert.equal(t.mock.state.watching.get(`${MOVIE.item}:0:1`)?.time, 1300);
  });

  it("5xx after the transport retries → kp.out.m_*; 404 → log.error and nothing is queued", async () => {
    const t = await make();
    const ev = recordEvents(t);
    t.mock.setScenario({ rules: [{ path: "^/v1/watching/marktime$", status: 500, times: 3 }] });
    load(t);
    player(t, "pause", { position: 500, duration: EP.duration });
    await waitFor(t, () => kinds(ev, "marktime").length === 1, "marktime result");
    assert.deepEqual(kinds(ev, "marktime").map((e) => (e as Extract<TrackerEvent, { kind: "marktime" }>).ok), [false]);
    assert.equal(marktimes(t).length, 3);
    assert.equal(t.ctx.outbox.size(), 1);
    assert.ok(t.storage.getItem("kp.out.m_2001_1_5")?.includes("500"));

    const u = await make();
    u.mock.setScenario({ rules: [{ path: "^/v1/watching/marktime$", status: 404 }] });
    load(u);
    player(u, "pause", { position: 500, duration: EP.duration });
    await waitFor(u, () => marktimes(u).length === 1, "404 marktime");
    await pass(u, 1000);
    assert.equal(u.ctx.outbox.size(), 0);
    assert.ok(u.ctx.log.entries().some((e) => e.level === "error" && e.tag === "progress"));
  });
});

describe("ProgressTracker: watched (Plan B §9.4, CNFR-14)", () => {
  it("92 % → exactly one GET /v1/watching + toggle; 95 % → no second toggle; then 50 % → no marktime", async () => {
    const t = await make();
    const ev = recordEvents(t);
    load(t);
    player(t, "play", { position: 0, duration: EP.duration });
    snapshot(t, pct(EP, 92));
    await waitFor(t, () => kinds(ev, "watched").length === 1, "watched");
    assert.deepEqual(kinds(ev, "watched").map((e) => (e as Extract<TrackerEvent, { kind: "watched" }>).result), ["done"]);
    assert.equal(watchingReads(t).length, 1);
    assert.equal(toggles(t).length, 1);
    const calls = t.mock.calls().map((c) => c.path);
    assert.ok(calls.indexOf("/v1/watching") < calls.indexOf("/v1/watching/toggle"), "status check comes first (Р-20)");
    assert.deepEqual([q(toggles(t)[0]!).get("id"), q(toggles(t)[0]!).get("video"), q(toggles(t)[0]!).get("season")], ["2001", "5", "1"]);
    assert.equal(t.mock.state.watching.get("2001:1:5")?.status, 1);
    assert.equal(t.ctx.overlay.get(EP.item, 1, 5)?.status, 1);
    assert.equal(t.ctx.tracker.session()?.watchedDone, true);
    await waitFor(t, () => times(t).includes(pct(EP, 92)), "marktime 92 %");

    snapshot(t, pct(EP, 95));
    await waitFor(t, () => times(t).includes(pct(EP, 95)), "marktime 95 %");
    snapshot(t, pct(EP, 50));
    await pass(t, 5000);
    assert.equal(toggles(t).length, 1);
    assert.equal(watchingReads(t).length, 1);
    assert.deepEqual(times(t), [pct(EP, 92), pct(EP, 95)]);
  });

  it("no toggle on video:load and video:play at 95 %", async () => {
    const t = await make();
    load(t, kpProps(), pct(EP, 95));
    player(t, "play", { state: 1, position: pct(EP, 95), duration: EP.duration });
    await pass(t, 5000);
    assert.equal(toggles(t).length, 0);
    assert.equal(watchingReads(t).length, 0);
    assert.equal(marktimes(t).length, 0);
  });

  it("already watched by the card status → only marktime", async () => {
    const t = await make();
    await t.run(t.ctx.repo.item(EP.item));
    const e1 = kpProps({ ...EP, mid: EP.mid - 4, video: 1 });
    load(t, e1);
    snapshot(t, 2300, e1);
    await waitFor(t, () => marktimes(t).length === 1, "marktime");
    await pass(t, 3000);
    assert.equal(toggles(t).length, 0);
    assert.equal(watchingReads(t).length, 0);
  });
});

describe("ProgressTracker: stop (Plan B §9.2, M-02)", () => {
  it("Back snapshot 600 s, then video:stop without position → marktime(600) once", async () => {
    const t = await make();
    load(t);
    player(t, "play", { position: 0, duration: EP.duration });
    snapshot(t, 600);
    player(t, "stop", { state: 0 });
    await waitFor(t, () => marktimes(t).length === 1, "stop marktime", 1000);
    await pass(t, 5000);
    assert.deepEqual(times(t), [600]);
    assert.equal(t.ctx.tracker.session(), undefined);
  });

  it("stop at the end with kp:n = 1 → no refreshAfterPlayback; a regular stop → after 2 s; the card is marked stale", async () => {
    const t = await make();
    const ev = recordEvents(t);
    await t.run(t.ctx.repo.item(EP.item));
    load(t);
    player(t, "play", { position: 0, duration: EP.duration });
    player(t, "stop", { position: EP.duration - 1, duration: EP.duration, ended: true });
    await pass(t, 5000);
    assert.equal(logged(t, "refresh_after_playback"), 0);
    assert.equal(logged(t, "refresh_skipped_autonext"), 1);
    assert.equal((kinds(ev, "stop")[0] as Extract<TrackerEvent, { kind: "pause" | "stop" }>).s.ended, true);

    load(t, kpProps({ ...EP, mid: EP.mid + 1, video: 6 }));
    player(t, "play", { position: 0, duration: EP.duration });
    player(t, "stop", { position: 1200, duration: EP.duration });
    await pass(t, 1500);
    assert.equal(logged(t, "refresh_after_playback"), 0, "not before 2 s");
    await pass(t, 1000);
    assert.equal(logged(t, "refresh_after_playback"), 1);
    assert.equal(t.ctx.repo.peekItem(EP.item)?.stale, true);
    assert.ok(apiCalls(t, "/v1/watching/marktime").length >= 2);
  });

  it("a new video:load cancels the pending refresh (no redraw under a starting video)", async () => {
    const t = await make();
    load(t);
    player(t, "stop", { position: 1200, duration: EP.duration });
    await t.clock.advance(500);
    load(t, kpProps({ ...EP, mid: EP.mid + 1, video: 6 }));
    await pass(t, 4000);
    assert.equal(logged(t, "refresh_after_playback"), 0);
  });
});
