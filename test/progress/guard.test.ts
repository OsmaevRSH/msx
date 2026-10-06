import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KpError } from "../../src/core/errors.ts";
import type { TrackerEvent } from "../../src/progress/tracker.ts";
import type { TestApp } from "../helpers/harness.ts";
import { EP, kpProps, load, logged, marktimes, pass, player, recordEvents, snapshot, toggles, useApps, waitFor } from "./progress-rig.ts";

// Этап 33c: прогресс не затирается запоздалыми снимками и откатами позиции. В web MSX один раз пришло
// `video:stop` без Back-снимка, а следом — снимок того же видео с позицией 0, который заново открыл сессию.

const make = useApps();

const kinds = (ev: TrackerEvent[], kind: TrackerEvent["kind"]): TrackerEvent[] => ev.filter((e) => e.kind === kind);
const times = (t: TestApp): number[] => marktimes(t).map((m) => m.time);
const net = (): KpError => new KpError("KP-NET", "network");
const E6 = kpProps({ ...EP, mid: EP.mid + 1, video: 6 });

/** Запрос `marktime`, который завершает тест: так видно, какой запрос ушёл и в каком порядке. */
interface Held { time: number; settle(e?: Error): void }

function holdMarktime(t: TestApp): { calls: number[]; held: Held[] } {
  const calls: number[] = [];
  const held: Held[] = [];
  t.ctx.api.marktime = (_id, _video, time) => new Promise<void>((resolve, reject) => {
    calls.push(time);
    held.push({ time, settle: (e) => (e === undefined ? resolve() : reject(e)) });
  });
  return { calls, held };
}

async function watching(t: TestApp, pos: number): Promise<void> {
  load(t);
  player(t, "play", { state: 1, position: 0, duration: EP.duration });
  snapshot(t, pos);
  await waitFor(t, () => times(t).includes(pos), `marktime ${pos}`);
}

// Здесь и ниже свойства без `kp:r`: так снимки приходят, если MSX не вернул nonce запуска (запасной путь фикса 34b).
describe("after video:stop, without kp:r (fallback window): late snapshots and events do not reopen the session", () => {
  it("stop without a Back snapshot, then late snapshots 0 s and 45 s of the same episode → no session, KinoPub keeps 600", async () => {
    const t = await make();
    const ev = recordEvents(t);
    await watching(t, 600);
    player(t, "stop", { state: 0 });
    assert.equal(t.ctx.tracker.session(), undefined);
    snapshot(t, 0);
    assert.equal(t.ctx.tracker.session(), undefined, "the late snapshot 0 s does not reopen the session");
    snapshot(t, 45);
    await pass(t, 5000);
    assert.equal(t.ctx.tracker.session(), undefined);
    assert.equal(kinds(ev, "load").length, 1);
    assert.deepEqual(times(t), [600]);
    assert.equal(t.mock.state.watching.get("2001:1:5")?.time, 600);
    assert.equal(t.ctx.overlay.get(EP.item, 1, 5)?.time, 600);
  });

  it("a late video:play does not count as a start; after the window a snapshot without video:load still opens nothing", async () => {
    const t = await make();
    await watching(t, 600);
    player(t, "stop", { state: 0 });
    await pass(t, 3000);
    player(t, "play", { state: 1, position: 300, duration: EP.duration });
    snapshot(t, 300);
    await pass(t, 15_000);
    assert.equal(t.ctx.tracker.session(), undefined);
    snapshot(t, 320);
    await pass(t, 5000);
    assert.equal(t.ctx.tracker.session(), undefined);
    assert.deepEqual(times(t), [600]);
  });

  it("video:load opens the next session at once, even of the same episode; late snapshots of the previous run are ignored for 10 s", async () => {
    const t = await make();
    await watching(t, 600);
    player(t, "stop", { position: 610, duration: EP.duration });
    await waitFor(t, () => times(t).includes(610), "stop marktime");
    // Смена качества в плеере: перезапуск того же `mid` с текущей позиции (спец. §9.1).
    load(t, kpProps(EP, { "resume:position": "607" }));
    assert.equal(t.ctx.tracker.session()?.mid, EP.mid);
    snapshot(t, 45);
    await pass(t, 5000);
    assert.deepEqual(times(t), [600, 610], "a late snapshot of the previous run is not attributed to the new one");
    await pass(t, 6000);
    snapshot(t, 680);
    await waitFor(t, () => times(t).includes(680), "a tick of the new run after the window");
  });

  it("autonext: a late snapshot of the finished episode does not touch it after E6 started", async () => {
    const t = await make();
    await watching(t, 2300);
    player(t, "stop", { position: EP.duration - 1, duration: EP.duration, ended: true });
    load(t, E6);
    snapshot(t, 0);
    snapshot(t, 100);
    await pass(t, 5000);
    assert.equal(t.ctx.tracker.session()?.video, 6);
    assert.deepEqual(marktimes(t).filter((m) => m.video === 5).map((m) => m.time), [2300, EP.duration - 1]);
  });
});

describe("a snapshot opens a session only after an explicit start", () => {
  it("video:load without kp:* (CDG-06 fallback): the first snapshot with kp:* opens the session", async () => {
    const t = await make();
    const ev = recordEvents(t);
    snapshot(t, 45);
    assert.equal(t.ctx.tracker.session(), undefined, "no start sign — no session");
    load(t, {});
    snapshot(t, 45);
    assert.equal(t.ctx.tracker.session()?.mid, EP.mid);
    assert.equal(kinds(ev, "started").length, 1);
    await waitFor(t, () => times(t).includes(45), "marktime 45");
  });

  it("a snapshot of another video during a session is ignored", async () => {
    const t = await make();
    await watching(t, 600);
    snapshot(t, 50, E6);
    await pass(t, 5000);
    assert.equal(t.ctx.tracker.session()?.video, 5);
    assert.deepEqual(marktimes(t).map((m) => m.video), [5]);
  });

  it("events = triggers (player events do not reach handleEvent): snapshots open and switch sessions; a late one of the previous video is ignored", async () => {
    const t = await make({ flags: { events: "triggers" } });
    snapshot(t, 600);
    await waitFor(t, () => times(t).includes(600), "marktime 600");
    snapshot(t, 40, E6);
    assert.equal(t.ctx.tracker.session()?.video, 6);
    snapshot(t, 100);
    await pass(t, 5000);
    assert.equal(t.ctx.tracker.session()?.video, 6);
    assert.deepEqual(marktimes(t).filter((m) => m.video === 5).map((m) => m.time), [600]);
    assert.deepEqual(marktimes(t).filter((m) => m.video === 6).map((m) => m.time), [40]);
  });
});

describe("inside a session: no marktime far below the session maximum without confirmation", () => {
  it("a stray snapshot 540 s back is held: no marktime, overlay and lastPos keep 660; the next tick goes as usual", async () => {
    const t = await make();
    await watching(t, 600);
    snapshot(t, 660);
    await waitFor(t, () => times(t).includes(660), "marktime 660");
    snapshot(t, 120);
    await pass(t, 5000);
    assert.deepEqual(times(t), [600, 660]);
    assert.equal(t.ctx.overlay.get(EP.item, 1, 5)?.time, 660);
    assert.equal(t.ctx.tracker.session()?.lastPos, 660);
    snapshot(t, 720);
    await waitFor(t, () => times(t).includes(720), "marktime 720");
  });

  it("a stray snapshot before video:stop without position (M-02): stop falls back to the last trusted position", async () => {
    const t = await make();
    await watching(t, 600);
    snapshot(t, 100);
    player(t, "stop", { state: 0 });
    await pass(t, 5000);
    assert.deepEqual(times(t), [600]);
    assert.equal(t.mock.state.watching.get("2001:1:5")?.time, 600);
  });

  it("a real seek-back is confirmed by the next tick", async () => {
    const t = await make();
    await watching(t, 600);
    snapshot(t, 100);
    await pass(t, 5000);
    assert.deepEqual(times(t), [600]);
    snapshot(t, 160);
    await waitFor(t, () => times(t).includes(160), "marktime 160");
    assert.equal(t.ctx.overlay.get(EP.item, 1, 5)?.time, 160);
  });

  it("a real seek-back right before Back: the Back snapshot and the stop position agree → marktime", async () => {
    const t = await make();
    await watching(t, 600);
    snapshot(t, 100);
    player(t, "stop", { position: 101, duration: EP.duration });
    await waitFor(t, () => times(t).includes(101), "marktime 101");
    assert.deepEqual(times(t), [600, 101]);
  });

  it("pause after a long rewind waits for confirmation (stop at the same place); a short rewind goes at once", async () => {
    const t = await make();
    await watching(t, 600);
    player(t, "pause", { state: 2, position: 560, duration: EP.duration });
    await waitFor(t, () => times(t).includes(560), "marktime 560", 1000);
    player(t, "pause", { state: 2, position: 100, duration: EP.duration });
    await pass(t, 3000);
    assert.deepEqual(times(t), [600, 560]);
    player(t, "stop", { position: 100, duration: EP.duration });
    await waitFor(t, () => times(t).includes(100), "marktime 100");
  });
});

describe("a session continued from resume:position", () => {
  it("snapshots 0, 5 and 45 s before the resume seek never reach KinoPub; stop without position sends nothing", async () => {
    const t = await make();
    const props = kpProps(EP, { "resume:position": "1287" });
    load(t, props);
    player(t, "play", { state: 1, position: 0, duration: EP.duration });
    for (const pos of [0, 5, 45]) snapshot(t, pos, props);
    await pass(t, 5000);
    assert.deepEqual(times(t), []);
    assert.equal(t.ctx.overlay.get(EP.item, 1, 5), undefined);
    snapshot(t, 1350, props);
    await waitFor(t, () => times(t).includes(1350), "marktime 1350");
    snapshot(t, 40, props);
    player(t, "stop", { state: 0 });
    await pass(t, 5000);
    assert.deepEqual(times(t), [1350]);
  });

  it("a session from the start (resume:position none) sends 45 s as before", async () => {
    const t = await make();
    const props = kpProps(EP, { "resume:position": "none" });
    load(t, props);
    snapshot(t, 45, props);
    await waitFor(t, () => times(t).includes(45), "marktime 45");
  });
});

describe("marktime of one episode goes one request at a time", () => {
  it("a newer position waits for the older request; the older one failing later is not queued over it", async () => {
    const t = await make();
    const { calls, held } = holdMarktime(t);
    load(t);
    player(t, "play", { state: 1, position: 0, duration: EP.duration });
    snapshot(t, 600);
    await pass(t, 2500);
    assert.deepEqual(calls, [600]);
    player(t, "pause", { state: 2, position: 2000, duration: EP.duration });
    await pass(t, 100);
    assert.deepEqual(calls, [600], "2000 waits for the request with 600");
    held[0]!.settle(net());
    await pass(t, 100);
    assert.deepEqual(calls, [600, 2000]);
    held[1]!.settle();
    await pass(t, 100);
    assert.equal(t.ctx.outbox.size(), 0, "600 failed before 2000 was delivered — its record is obsolete");
  });

  it("an outbox retry in flight delays a direct marktime of the same episode until it settles", async () => {
    const t = await make();
    const { calls, held } = holdMarktime(t);
    t.ctx.outbox.putMarktime(EP.item, 1, 5, 600);
    const flushing = t.ctx.outbox.flush();
    await pass(t, 100);
    assert.deepEqual(calls, [600]);
    load(t);
    player(t, "pause", { state: 2, position: 2000, duration: EP.duration });
    await pass(t, 100);
    assert.deepEqual(calls, [600], "the direct 2000 waits for the outbox request with 600");
    held[0]!.settle();
    await pass(t, 100);
    assert.deepEqual(calls, [600, 2000]);
    held[1]!.settle();
    await t.run(flushing);
    assert.equal(t.ctx.outbox.size(), 0);
  });
});

// Фикс 34b: запуск — это ответ resolve с nonce `kp:r`. Перезапуск того же `mid` из панели озвучки или качества
// (`[cleanup|player:eject|video:resolve…:at<pos>]`) — новый nonce: его снимки слушаются сразу, а снимки закрытого
// запуска не слушаются никогда. Найдено e2e E-09: 90 % и конец серии в первые 10 с после перезапуска терялись.
describe("launch nonce kp:r (fix 34b): a session is its resolve, not a 10 s window", () => {
  const R1 = kpProps(EP, { "kp:r": "r1" });
  const R2 = kpProps(EP, { "kp:r": "r2", "resume:position": "300" });
  const E6R = kpProps({ ...EP, mid: EP.mid + 1, video: 6 }, { "kp:r": "r3" });
  const e5 = (t: TestApp): number[] => marktimes(t).filter((m) => m.video === 5).map((m) => m.time);

  it("E-09: audio restart from the panel → seek past 90 % → autonext without stop: toggle and the last marktime go", async () => {
    const t = await make();
    const ev = recordEvents(t);
    load(t, R1);
    player(t, "play", { state: 1, position: 0, duration: EP.duration });
    snapshot(t, 300, R1);
    await waitFor(t, () => times(t).includes(300), "marktime 300");
    // `player:eject` из цепочки панели закрывает плеер, `video:resolve…:at300` запускает ту же серию заново.
    player(t, "stop", { position: 300, duration: EP.duration });
    load(t, R2);
    player(t, "play", { state: 1, position: 300, duration: EP.duration });
    snapshot(t, 2200, R2);
    snapshot(t, 2210, R2);
    // `trigger:complete` → следующая серия; `stop` при автопереходе MSX не шлёт.
    load(t, E6R);
    await waitFor(t, () => kinds(ev, "watched").length === 1 && e5(t).includes(2210), "toggle and marktime 2210");
    assert.equal(toggles(t).length, 1);
    assert.deepEqual(e5(t), [300, 2210]);
    assert.deepEqual([t.mock.state.watching.get("2001:1:5")?.status, t.mock.state.watching.get("2001:1:5")?.time], [1, 2210]);
    assert.equal(logged(t, "late_snapshot_ignored"), 0);
    assert.equal(t.ctx.tracker.session()?.video, 6);
  });

  it("a restart without video:stop: the new load closes the previous run of the same mid with its last position", async () => {
    const t = await make();
    load(t, R1);
    player(t, "play", { state: 1, position: 0, duration: EP.duration });
    snapshot(t, 600, R1);
    load(t, R2);
    await waitFor(t, () => times(t).includes(600), "the final marktime of the previous run");
    snapshot(t, 640, R2);
    await waitFor(t, () => times(t).includes(640), "a snapshot of the new run at once");
    assert.deepEqual(times(t), [600, 640]);
  });

  it("a late snapshot of the closed run is ignored after the new load — during the window and after it", async () => {
    const t = await make();
    const r0 = kpProps(EP, { "kp:r": "r0" });
    load(t, r0);
    player(t, "play", { state: 1, position: 0, duration: EP.duration });
    snapshot(t, 600, r0);
    await waitFor(t, () => times(t).includes(600), "marktime 600");
    player(t, "stop", { position: 610, duration: EP.duration });
    await waitFor(t, () => times(t).includes(610), "stop marktime");
    load(t, kpProps(EP, { "kp:r": "r2", "resume:position": "607" }));
    // 590 и 595 — в пределах 60 с от максимума: `judgePosition` их пропустил бы, отбрасывает только nonce.
    snapshot(t, 590, r0);
    snapshot(t, 640, kpProps(EP, { "kp:r": "r2" }));
    await waitFor(t, () => times(t).includes(640), "a tick of the new run inside the window");
    await pass(t, 15_000);
    snapshot(t, 595, r0);
    await pass(t, 5000);
    assert.deepEqual(times(t), [600, 610, 640]);
    assert.equal(logged(t, "late_snapshot_ignored"), 2);
    assert.equal(t.ctx.tracker.session()?.lastPos, 640);
  });

  it("video:load of a closed run does not reopen it; a repeated load of the current run keeps the session", async () => {
    const t = await make();
    load(t, R1);
    snapshot(t, 600, R1);
    await waitFor(t, () => times(t).includes(600), "marktime 600");
    const s = t.ctx.tracker.session();
    load(t, R1);
    assert.equal(t.ctx.tracker.session(), s, "the same session");
    snapshot(t, 600, R1);
    await pass(t, 3000);
    assert.deepEqual(times(t), [600], "600 is not sent again");
    player(t, "stop", { state: 0 });
    load(t, R1);
    assert.equal(t.ctx.tracker.session(), undefined, "a late load of the closed run");
    snapshot(t, 650, R1);
    await pass(t, 3000);
    assert.deepEqual(times(t), [600]);
  });

  it("events = triggers: a new kp:r of the same episode opens a new session at once; the old run stays closed", async () => {
    const t = await make({ flags: { events: "triggers" } });
    snapshot(t, 600, R1);
    snapshot(t, 300, R2);
    assert.equal(t.ctx.tracker.session()?.run, "r2");
    snapshot(t, 610, R1);
    await pass(t, 5000);
    assert.deepEqual(times(t), [600, 300]);
  });

  it("load with kp:r but snapshots without it: the window as before (MSX did not return kp:r)", async () => {
    const t = await make();
    load(t, R1);
    snapshot(t, 600);
    await waitFor(t, () => times(t).includes(600), "marktime 600");
    player(t, "stop", { position: 610, duration: EP.duration });
    load(t, R2);
    snapshot(t, 640);
    await pass(t, 5000);
    assert.deepEqual(times(t), [600, 610], "a snapshot without kp:r inside the window is not attributed");
    await pass(t, 6000);
    snapshot(t, 680);
    await waitFor(t, () => times(t).includes(680), "after the window");
  });
});
