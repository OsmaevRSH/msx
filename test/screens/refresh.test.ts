import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import { replaceContent } from "../../src/msx/actions.ts";
import { ids } from "../../src/router/ids.ts";
import { personalHash, refreshAfterPlayback, scheduleRefresh, trackScreen } from "../../src/screens/refresh.ts";
import type { RefreshSpec } from "../../src/screens/refresh.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { watchKey } from "../../tools/kpmock/state.ts";
import { EP, load, player } from "../progress/progress-rig.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

// Перерисовка персональных данных (спец. §6.3, CC-11): `replace:content` только для текущего экрана и с его флагом.

const P = TEST_P;
const A = FIX.SERIAL_BIG;
const B = FIX.MOVIE_SIMPLE;
const ELEVEN_MIN = 11 * 60_000;
const OUTCOMES = ["replaced", "unchanged", "not_current", "failed"];

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(): Promise<TestApp> {
  const t = await createTestApp({ loggedIn: true });
  apps.push(t);
  return t;
}

const actions = (t: TestApp): string[] => t.host.actions.map((a) => a.action);
const count = (t: TestApp, name: string): number => t.ctx.metrics.summary().counters[`refresh:${name}`] ?? 0;
const finished = (t: TestApp): number => OUTCOMES.reduce((n, k) => n + count(t, k), 0);

/** Обновление идёт в реальном времени; поддельные часы стоят, поэтому ожидание свежей карточки (3 с) не истекает. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await realSleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function spec(dataId: string, flag: string, recompute: () => Promise<string>): RefreshSpec & { calls: number } {
  const out = { dataId, flag, hash: "h0", calls: 0, recompute: () => {
    out.calls += 1;
    return recompute();
  } };
  return out;
}

describe("scheduleRefresh (спец. §6.3)", () => {
  it("the hash changed and the screen is still current → replace:content with its flag", async () => {
    const t = await make();
    t.ctx.current.onRequest(ids.item(A));
    scheduleRefresh(t.ctx, spec(ids.item(A), "item_2001", async () => "h1"));
    await until(() => finished(t) === 1, "the refresh");
    assert.deepEqual(actions(t), [`replace:content:item_2001:request:interaction:item:2001@${P}`]);
    assert.equal(actions(t)[0], replaceContent("item_2001", P, ids.item(A)));
    assert.equal(count(t, "replaced"), 1);
  });

  it("another screen became current while recomputing → no replace (M-01)", async () => {
    const t = await make();
    const d = deferred<string>();
    t.ctx.current.onRequest(ids.item(A));
    scheduleRefresh(t.ctx, spec(ids.item(A), "item_2001", () => d.promise));
    t.ctx.current.onRequest(ids.item(B));
    d.resolve("h1");
    await until(() => finished(t) === 1, "the refresh");
    assert.deepEqual(actions(t), []);
    assert.equal(count(t, "not_current"), 1);
  });

  it("panels and resolve over the screen do not change the current one", async () => {
    const t = await make();
    const d = deferred<string>();
    t.ctx.current.onRequest(ids.season(A, 1));
    scheduleRefresh(t.ctx, spec(ids.season(A, 1), "ep_2001_1", () => d.promise));
    t.ctx.current.onRequest(ids.panel("audio", A, 2001001, "c"));
    t.ctx.current.onRequest(ids.playEp(A, 2001001, 1, 1));
    d.resolve("h1");
    await until(() => finished(t) === 1, "the refresh");
    assert.deepEqual(actions(t), [replaceContent("ep_2001_1", P, ids.season(A, 1))]);
  });

  it("the same hash → nothing", async () => {
    const t = await make();
    t.ctx.current.onRequest(ids.item(A));
    scheduleRefresh(t.ctx, spec(ids.item(A), "item_2001", async () => "h0"));
    await until(() => finished(t) === 1, "the refresh");
    assert.deepEqual(actions(t), []);
    assert.equal(count(t, "unchanged"), 1);
  });

  it("a second schedule for the same dataId while the first runs is ignored; afterwards it runs again", async () => {
    const t = await make();
    const d = deferred<string>();
    t.ctx.current.onRequest(ids.item(A));
    const s = spec(ids.item(A), "item_2001", () => d.promise);
    scheduleRefresh(t.ctx, s);
    scheduleRefresh(t.ctx, s);
    assert.equal(s.calls, 1);
    assert.equal(count(t, "busy"), 1);
    d.resolve("h0");
    await until(() => finished(t) === 1, "the refresh");
    scheduleRefresh(t.ctx, s);
    await until(() => finished(t) === 2, "the second refresh");
    assert.equal(s.calls, 2);
  });

  it("a failed recompute changes nothing and frees the dataId", async () => {
    const t = await make();
    t.ctx.current.onRequest(ids.item(A));
    scheduleRefresh(t.ctx, spec(ids.item(A), "item_2001", async () => {
      throw new Error("boom");
    }));
    await until(() => finished(t) === 1, "the refresh");
    assert.deepEqual(actions(t), []);
    assert.equal(count(t, "failed"), 1);
    scheduleRefresh(t.ctx, spec(ids.item(A), "item_2001", async () => "h1"));
    await until(() => finished(t) === 2, "the second refresh");
    assert.equal(actions(t).length, 1);
  });
});

describe("conditional redraw of real screens (CC-11)", () => {
  it("a stale card A, progress of A changed in KinoPub → replace:content:item_A after the update", async () => {
    const t = await make();
    await t.request(ids.item(A));
    await t.clock.advance(ELEVEN_MIN);
    t.mock.state.watching.set(watchKey(A, 1, 4), { time: 2440, status: 1, updated: 0 });
    await t.request(ids.item(A));
    await until(() => finished(t) === 1, "the refresh of A");
    assert.deepEqual(actions(t), [`replace:content:item_${A}:request:interaction:item:${A}@${P}`]);
  });

  it("a stale card A, then card B at once (same screen type within 3 s) → no replace after A is updated", async () => {
    const t = await make();
    await t.request(ids.item(A));
    await t.request(ids.item(B));
    await t.clock.advance(ELEVEN_MIN);
    t.mock.state.watching.set(watchKey(A, 1, 4), { time: 2440, status: 1, updated: 0 });
    t.mock.setScenario({ rules: [{ path: `^/v1/items/${A}$`, delayMs: 200 }] });
    await t.request(ids.item(A));
    await t.request(ids.item(B));
    await until(() => finished(t) === 2, "the refreshes of A and B");
    assert.deepEqual(actions(t), []);
    assert.equal(count(t, "not_current"), 1, "A changed, but B is current");
    assert.equal(count(t, "unchanged"), 1, "B did not change");
  });

  it("a stale card whose personal part did not change → no actions", async () => {
    const t = await make();
    await t.request(ids.item(A));
    await t.clock.advance(ELEVEN_MIN);
    await t.request(ids.item(A));
    await until(() => finished(t) === 1, "the refresh");
    assert.deepEqual(actions(t), []);
    assert.equal(count(t, "unchanged"), 1);
  });
});

describe("refreshAfterPlayback", () => {
  it("current season:2001:1, an episode changed in KinoPub → replace:content:ep_2001_1", async () => {
    const t = await make();
    await t.request(ids.season(A, 1));
    t.mock.state.watching.set(watchKey(A, 1, 5), { time: 900, status: 0, updated: 0 });
    refreshAfterPlayback(t.ctx, A);
    await until(() => finished(t) === 1, "the refresh");
    assert.deepEqual(actions(t), [`replace:content:ep_${A}_1:request:interaction:season:${A}:1@${P}`]);
  });

  it("current item:<id> → its card is updated and replaced with item_<id>", async () => {
    const t = await make();
    await t.request(ids.item(A));
    t.mock.state.watching.set(watchKey(A, 1, 4), { time: 2440, status: 1, updated: 0 });
    refreshAfterPlayback(t.ctx, A);
    await until(() => finished(t) === 1, "the refresh");
    assert.deepEqual(actions(t), [replaceContent(`item_${A}`, P, ids.item(A))]);
  });

  it("nothing changed → no replace", async () => {
    const t = await make();
    await t.request(ids.season(A, 1));
    refreshAfterPlayback(t.ctx, A);
    await until(() => finished(t) === 1, "the refresh");
    assert.deepEqual(actions(t), []);
  });

  it("another title is current → no refresh, but the card of the played title is marked stale", async () => {
    const t = await make();
    await t.request(ids.item(A));
    await t.request(ids.item(B));
    refreshAfterPlayback(t.ctx, A);
    await realSleep(30);
    assert.equal(finished(t), 0);
    assert.deepEqual(actions(t), []);
    assert.equal(t.ctx.repo.peekItem(A)?.stale, true);
  });

  it("home is current: the spec registered by the home screen decides (stage 30)", async () => {
    const t = await make();
    t.ctx.current.onRequest(ids.home());
    refreshAfterPlayback(t.ctx, A);
    await realSleep(30);
    assert.equal(finished(t), 0, "no home spec yet — nothing to recompute");

    trackScreen(t.ctx, spec(ids.home(), "home", async () => "h1"));
    refreshAfterPlayback(t.ctx, A);
    await until(() => finished(t) === 1, "the refresh of home");
    assert.deepEqual(actions(t), [replaceContent("home", P, ids.home())]);
  });

  it("player stop over the season screen → after 2 s replace:content:ep_2001_1 (tracker)", async () => {
    const t = await make();
    await t.request(ids.season(A, 1));
    load(t);
    player(t, "play", { position: 0, duration: EP.duration });
    player(t, "stop", { position: 1200, duration: EP.duration });
    await until(() => t.ctx.log.entries().some((e) => e.tag === "progress" && e.msg === "marktime"), "the stop marktime");
    assert.equal(t.mock.state.watching.get(watchKey(A, 1, EP.video))?.time, 1200);
    await t.clock.advance(1999);
    await realSleep(30);
    assert.equal(finished(t), 0, "not before 2 s");
    await t.clock.advance(1);
    await until(() => finished(t) === 1, "the refresh");
    assert.deepEqual(actions(t), [replaceContent(`ep_${A}_1`, P, ids.season(A, 1))]);
  });
});

describe("personalHash", () => {
  it("is fnv1a of the JSON: equal for equal values, different otherwise", () => {
    assert.equal(personalHash({ a: 1 }), personalHash({ a: 1 }));
    assert.notEqual(personalHash({ a: 1 }), personalHash({ a: 2 }));
    assert.match(personalHash(undefined), /^[0-9a-f]{8}$/);
  });
});
