import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TrackerEvent } from "../../src/progress/tracker.ts";
import { EP, load, marktimes, pass, player, recordEvents, useApps, videoData, waitFor } from "./progress-rig.ts";

const make = useApps();

const videoRequests = (host: { requests: string[] }): number => host.requests.filter((r) => r === "video").length;

describe("HeartbeatTimer (спец. §10.1, CDG-07)", () => {
  it("heartbeat = timer: requestData(\"video\") every 60 s → marktime(70); stopped after video:pause", async () => {
    const t = await make({ flags: { heartbeat: "timer" } });
    const ev = recordEvents(t);
    t.host.responses.set("video", videoData(70));
    load(t);
    player(t, "play", { state: 1, position: 0, duration: EP.duration });
    await pass(t, 59_000);
    assert.equal(videoRequests(t.host), 0);
    await pass(t, 1_000);
    assert.equal(videoRequests(t.host), 1);
    await waitFor(t, () => marktimes(t).length === 1, "heartbeat marktime", 5000);
    assert.deepEqual(marktimes(t).map((m) => m.time), [70]);
    const raw = ev.filter((e): e is Extract<TrackerEvent, { kind: "raw" }> => e.kind === "raw" && e.source === "timer");
    assert.deepEqual(raw.map((e) => e.position), [70]);

    player(t, "pause", { state: 2, position: 75, duration: EP.duration });
    await pass(t, 90_000);
    await pass(t, 90_000);
    assert.equal(videoRequests(t.host), 1);
    assert.deepEqual(marktimes(t).map((m) => m.time), [70, 75]);
  });

  it("heartbeat = ticks (default): video:play does not start the timer", async () => {
    const t = await make();
    t.host.responses.set("video", videoData(70));
    load(t);
    player(t, "play", { state: 1, position: 0, duration: EP.duration });
    await pass(t, 90_000);
    await pass(t, 90_000);
    assert.equal(videoRequests(t.host), 0);
  });

  it("the timer restarts on play after pause; an answer after stop is ignored", async () => {
    const t = await make({ flags: { heartbeat: "timer" } });
    let release: ((v: unknown) => void) | undefined;
    t.host.responses.set("video", () => new Promise((r) => (release = r)));
    load(t);
    player(t, "play", { state: 1, position: 0, duration: EP.duration });
    await pass(t, 60_000);
    assert.equal(videoRequests(t.host), 1);
    player(t, "stop", { state: 0 });
    release?.(videoData(900));
    await pass(t, 5000);
    assert.equal(marktimes(t).length, 0);
    assert.equal(t.ctx.tracker.session(), undefined);

    t.host.responses.set("video", videoData(130));
    load(t);
    player(t, "play", { state: 1, position: 0, duration: EP.duration });
    player(t, "pause", { state: 2 });
    player(t, "play", { state: 1 });
    await pass(t, 60_000);
    assert.equal(videoRequests(t.host), 2);
    await waitFor(t, () => marktimes(t).length === 1, "marktime after restart", 5000);
    assert.deepEqual(marktimes(t).map((m) => m.time), [130]);
  });
});
