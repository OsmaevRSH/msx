import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveAction } from "../../src/msx/actions.ts";
import type { MsxResolveResponse } from "../../src/msx/types.ts";
import { pickTestTitle } from "../../src/probe/checks-api.ts";
import type { CheckId, CheckResult } from "../../src/probe/runner.ts";
import type { TestTitle, UnitRef } from "../../src/probe/store.ts";
import { encodeListKey, ids } from "../../src/router/ids.ts";
import type { TestApp } from "../helpers/harness.ts";
import { TEST_P } from "../helpers/harness.ts";
import { EP, kpProps, load, pass, player, snapshot, useApps } from "../progress/progress-rig.ts";

// Проверки уровня ТВ по событиям трекера (спец. §16.2): CDG-05…07, 11, 12.

const make = useApps();

function check(t: TestApp, id: CheckId): CheckResult {
  const r = t.ctx.probe!.results().find((x) => x.id === id);
  assert.ok(r !== undefined, `${id} not recorded`);
  return r;
}

const recorded = (t: TestApp, id: CheckId): boolean => t.ctx.probe!.results().some((x) => x.id === id);

async function title(t: TestApp): Promise<TestTitle> {
  const tt = await t.run(pickTestTitle(t.ctx));
  assert.ok(tt !== undefined);
  return tt;
}

async function probePlay(t: TestApp, v: string, tt: TestTitle, u: UnitRef): Promise<Record<string, string>> {
  const res = (await t.request(ids.probePlay(v, tt.id, u.mid, u.s, u.e))) as MsxResolveResponse;
  assert.equal(res.error, undefined, res.error ?? "");
  return res.properties ?? {};
}

describe("CDG-07: player events, ticks, Back snapshot, requestData(\"video\")", () => {
  const ticks = kpProps(EP, { "kp:p": "ticks" });

  it("load → play → 2 tick snapshots → Back snapshot → pause → stop with positions → ✓", async () => {
    const t = await make();
    t.host.responses.set("video", { video: { data: { position: 15, duration: EP.duration } } });
    load(t, ticks, 0);
    player(t, "play", { position: 0, duration: EP.duration });
    await pass(t, 10_000);
    snapshot(t, 10, ticks);
    await pass(t, 10_000);
    snapshot(t, 20, ticks);
    await pass(t, 2_000);
    snapshot(t, 22, ticks);
    player(t, "pause", { position: 22 });
    player(t, "stop", { position: 22 });
    await pass(t, 100);

    const r = check(t, "CDG-07");
    assert.equal(r.ok, true, r.summary);
    assert.deepEqual(r.values, {
      events: "load,play,pause,stop", withPos: "load,play,pause,stop", ticks: 2, back: true, requestDataVideo: true,
    });
    assert.deepEqual(t.host.requests.filter((d) => d === "video"), ["video"], "one requestData(\"video\") 15 s after start");
  });

  it("stop before 15 s: requestData is not asked; one tick and no Back snapshot → ✗", async () => {
    const t = await make();
    load(t, ticks, 0);
    player(t, "play", { position: 0, duration: EP.duration });
    await pass(t, 8_000);
    snapshot(t, 8, ticks);
    await pass(t, 6_000);
    player(t, "stop");
    await pass(t, 20_000);
    const r = check(t, "CDG-07");
    assert.equal(r.ok, false);
    assert.equal(r.values.ticks, 1);
    assert.equal(r.values.back, false);
    assert.equal(r.values.withPos, "load,play");
    assert.equal(r.values.requestDataVideo, undefined);
    assert.deepEqual(t.host.requests.filter((d) => d === "video"), []);
  });

  it("an ordinary session (no kp:p) records nothing", async () => {
    const t = await make();
    load(t);
    player(t, "play", { position: 0, duration: EP.duration });
    snapshot(t, 10);
    player(t, "stop", { position: 10 });
    await pass(t, 100);
    assert.deepEqual(t.ctx.probe!.results(), []);
  });
});

describe("CDG-05: a1, a2, hls2 start with TTFF", () => {
  it("three starts → ✓ with TTFF of each and p50/p95; partial — not decided yet", async () => {
    const t = await make();
    const tt = await title(t);
    const u = tt.s1e1;
    const delays: [string, number][] = [["a1", 1900], ["a2", 2000], ["hls2", 2400]];
    for (const [v, delay] of delays) {
      const props = await probePlay(t, v, tt, u);
      assert.equal(props["kp:p"], v);
      await pass(t, delay);
      load(t, props, 0, u.duration);
      player(t, "play", { position: 0, duration: u.duration });
      player(t, "stop", { position: 3 });
      if (v === "a1") assert.equal(check(t, "CDG-05").ok, null, "a2 and hls2 have not started yet");
    }
    const r = check(t, "CDG-05");
    assert.equal(r.ok, true, r.summary);
    assert.deepEqual(r.values, { a1: 1900, a2: 2000, hls2: 2400, p50: 2000, p95: 2400 });
    assert.match(r.summary, /^TTFF p50 2,0 с p95 2,4 с/);
  });

  it("a1 stopped before it started → ✗; a later Back before start does not undo a success", async () => {
    const t = await make();
    const tt = await title(t);
    // Каждый запуск плитки — свой resolve: MSX приносит в `video:load` его свойства с новым nonce `kp:r` (фикс 34b).
    const launch = async (): Promise<void> => load(t, await probePlay(t, "a1", tt, tt.s1e1), 0, tt.s1e1.duration);
    await launch();
    player(t, "stop");
    assert.equal(check(t, "CDG-05").ok, false);
    assert.equal(check(t, "CDG-05").values.a1, false);

    await launch();
    player(t, "play", { position: 0 });
    player(t, "stop", { position: 5 });
    await launch();
    player(t, "stop");
    assert.equal(typeof check(t, "CDG-05").values.a1, "number");
  });
});

describe("CDG-06: player properties from resolve only", () => {
  it("video:load carries kp:* and a trigger snapshot arrives → ✓", async () => {
    const t = await make();
    const props = kpProps(EP, { "kp:p": "props" });
    load(t, props, 0);
    player(t, "play", { position: 0 });
    assert.equal(recorded(t, "CDG-06"), false);
    snapshot(t, 10, props);
    const r = check(t, "CDG-06");
    assert.equal(r.ok, true, r.summary);
    assert.deepEqual(r.values, { loadProps: true, snapshots: 1 });
  });

  it("only snapshots carry kp:* (video:load without them) → ✗ after stop", async () => {
    const t = await make();
    const props = kpProps(EP, { "kp:p": "props" });
    load(t, {}, 0);
    snapshot(t, 10, props);
    player(t, "stop", { position: 12 });
    const r = check(t, "CDG-06");
    assert.equal(r.ok, false);
    assert.equal(r.values.loadProps, false);
  });
});

describe("CDG-11: autonext to the next season", () => {
  it("«Автопереход» starts the last S1 episode 20 s before the end; S2E1 load → ✓", async () => {
    const t = await make();
    const tt = await title(t);
    const last = tt.s1Last;
    const props = await probePlay(t, "autonext", tt, last);
    assert.equal(props["resume:position"], String(last.duration - 20));
    assert.equal(props["trigger:complete"], "player:button:next:execute");
    const next = tt.s2e1;
    assert.equal(props["button:next:action"], resolveAction(TEST_P, ids.playEp(tt.id, next.mid, next.s, next.e)));
    load(t, props, last.duration - 20, last.duration);
    player(t, "play", { position: last.duration - 20 });

    const res = (await t.request(ids.playEp(tt.id, next.mid, next.s, next.e))) as MsxResolveResponse;
    load(t, res.properties, 0, next.duration);
    const r = check(t, "CDG-11");
    assert.equal(r.ok, true, r.summary);
    assert.equal(r.values.mid, next.mid);
    assert.equal(r.values.autonext, "button");
  });

  it("the episode ended and nothing started within 30 s → ✗", async () => {
    const t = await make();
    const tt = await title(t);
    const last = tt.s1Last;
    const props = await probePlay(t, "autonext", tt, last);
    load(t, props, last.duration - 20, last.duration);
    player(t, "play", { position: last.duration - 20 });
    player(t, "stop", { position: last.duration, ended: true });
    await pass(t, 29_000);
    assert.equal(recorded(t, "CDG-11"), false);
    await pass(t, 2_000);
    assert.equal(check(t, "CDG-11").ok, false);
  });
});

describe("CDG-12: «Сетка 150» — {context:kid} and extend by router counters", () => {
  const key = encodeListKey({ src: "catalog", type: "movie", sort: "-updated" });

  async function grid(t: TestApp, messages: string[]): Promise<CheckResult> {
    await t.request(ids.list(key));
    t.app.handleData({ message: "act:probe:grid" });
    for (const m of messages) t.app.handleData({ message: m });
    await pass(t, 1000);
    await t.request(ids.probe());
    return check(t, "CDG-12");
  }

  it("pf:1001, pf:1002 and 2 × extend → ✓", async () => {
    const t = await make();
    t.app.handleData({ message: "pf:7" });
    const r = await grid(t, ["pf:1001", "pf:1002", `extend:${key}`, `extend:${key}`]);
    assert.equal(r.ok, true, r.summary);
    assert.deepEqual(r.values, { pf: 2, pfRaw: 0, extend: 2, kidNumeric: true, focusPrefetch: "on" });
  });

  it("an unexpanded pf:{context:kid} → ✗ kidNumeric false", async () => {
    const t = await make();
    const r = await grid(t, ["pf:{context:kid}", "pf:1001", `extend:${key}`, `extend:${key}`]);
    assert.equal(r.ok, false);
    assert.equal(r.values.kidNumeric, false);
    assert.equal(r.values.pfRaw, 1);
  });

  it("without the «Сетка 150» button nothing is recorded", async () => {
    const t = await make();
    t.app.handleData({ message: "pf:1001" });
    await t.request(ids.probe());
    assert.equal(recorded(t, "CDG-12"), false);
  });
});
