import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import type { User } from "../../src/api/models.ts";
import { cacheKeys } from "../../src/cache/repo.ts";
import { resolveAction } from "../../src/msx/actions.ts";
import type { MsxResolveResponse } from "../../src/msx/types.ts";
import { NO_START_TEXT, NO_SUBSCRIPTION_TEXT, onTrackerEvent } from "../../src/playback/resolve.ts";
import { sessionFromProps } from "../../src/progress/session.ts";
import { ids } from "../../src/router/ids.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

const P = TEST_P;
const BIG = FIX.SERIAL_BIG;
const mid = (item: number, ordinal: number): number => item * 1000 + ordinal;
const BIG_S1E4 = mid(BIG, 4);
const BIG_S1E5 = mid(BIG, 5);
const LINKS_PATH = "/v1/items/media-links";

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

const play = async (t: TestApp, dataId: string): Promise<MsxResolveResponse> => (await t.request(dataId)) as MsxResolveResponse;
const props = (r: MsxResolveResponse): Record<string, string> => {
  assert.equal(r.error, undefined, `resolve failed: ${r.error}`);
  return r.properties ?? {};
};
const linkCalls = (t: TestApp, m?: number): number =>
  t.mock.calls().filter((c) => c.path === LINKS_PATH && (m === undefined || new URLSearchParams(c.query).get("mid") === String(m))).length;

/** Ждать фоновую работу в реальном времени, не двигая поддельные часы. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await realSleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const user = (active: boolean): User => ({ username: "tester", subscription: { active, endTime: 0, days: 0 } });

describe("resolvePlay: «Продолжить» и свойства (CC-08)", () => {
  it("play:2001:continue → S1E4 hls1 master-v1aN, resume 597, next is S1E5", async () => {
    const t = await make();
    const res = await play(t, ids.playContinue(BIG));
    const p = props(res);
    assert.match(res.url ?? "", /\/kp2001004_1080p\.mp4\/master-v1a1\.m3u8\?loc=nl$/);
    assert.equal(res.label, "Тестовый сериал «Большой» · S1E4");
    assert.equal(p["resume:position"], "597");
    assert.equal(p["kp:i"], String(BIG));
    assert.equal(p["kp:m"], String(BIG_S1E4));
    assert.equal(p["kp:s"], "1");
    assert.equal(p["kp:e"], "4");
    assert.equal(p["kp:n"], "1");
    assert.equal(p["button:next:action"], resolveAction(P, ids.playEp(BIG, BIG_S1E5, 1, 5)));
    assert.equal(p["button:prev:action"], resolveAction(P, ids.playEp(BIG, mid(BIG, 3), 1, 3)));
    assert.equal(p["label:extension"], "1080p · Студия Бета · HLS1");
    assert.equal(p["trigger:load"], undefined);
    assert.equal(typeof t.ctx.state.resolveAt.get(BIG_S1E4), "number");
    assert.equal(t.ctx.metrics.summary().values.resolve?.n, 1);
  });

  it("the audio index follows TV preferences: English → master-v1a2", async () => {
    const t = await make();
    t.ctx.prefs.update({ audioLang: "eng" });
    const res = await play(t, ids.playEp(BIG, BIG_S1E4, 1, 4));
    assert.match(res.url ?? "", /master-v1a2\.m3u8/);
  });

  it("MOVIE_AUDIO12: preferred author of row 7 → a7; loc=ru; subtitles by language with loc", async () => {
    const t = await make();
    t.ctx.prefs.update({ audioAuthors: [13], loc: "ru", subsLang: "eng" });
    const res = await play(t, ids.playContinue(FIX.MOVIE_AUDIO12));
    const p = props(res);
    assert.match(res.url ?? "", /\/master-v1a7\.m3u8\?loc=ru$/);
    assert.ok(!(res.url ?? "").includes("loc=nl"));
    assert.equal(res.label, "Тестовый фильм «12 озвучек»");
    assert.equal(p["label:extension"], "1080p · Студия Гамма · HLS1");
    assert.match(p["tizen:subtitle:url"] ?? "", /\/2004001\.eng\.srt\?loc=ru$/);
    assert.equal(p["resume:position"], "none");
  });

  it("a forced track chosen in the panel (titleSubs <lang>.forced) survives the next start", async () => {
    const t = await make();
    t.ctx.prefs.setTitle("subs", FIX.MOVIE_AUDIO12, "eng.forced");
    const p = props(await play(t, ids.playContinue(FIX.MOVIE_AUDIO12)));
    assert.match(p["tizen:subtitle:url"] ?? "", /\/2004001\.eng\.forced\.srt$/);
  });

  it("S1E20 of SERIAL_BIG → button:next goes over the season boundary to S2E1", async () => {
    const t = await make();
    const p = props(await play(t, ids.playEp(BIG, mid(BIG, 20), 1, 20)));
    assert.equal(p["kp:e"], "20");
    assert.equal(p["button:next:action"], resolveAction(P, ids.playEp(BIG, mid(BIG, 21), 2, 1)));
    assert.equal(p["trigger:complete"], "player:button:next:execute");
  });

  it("a movie → no button:next, trigger:complete ejects, season 0", async () => {
    const t = await make();
    const res = await play(t, ids.playContinue(FIX.MOVIE_SIMPLE));
    const p = props(res);
    assert.equal(res.label, "Тестовый фильм «Простой»");
    assert.equal(p["resume:position"], "1197");
    assert.equal(p["kp:s"], "0");
    assert.equal(p["kp:n"], "0");
    assert.equal(p["button:next:action"], undefined);
    assert.equal(p["trigger:complete"], "player:eject");
  });

  it("a movie in parts → «Часть N», next part", async () => {
    const t = await make();
    const res = await play(t, ids.playStart(FIX.MOVIE_MULTI));
    const p = props(res);
    assert.equal(res.label, "Тестовый фильм «Из частей» · Часть 1");
    assert.equal(p["button:next:action"], resolveAction(P, ids.playEp(FIX.MOVIE_MULTI, mid(FIX.MOVIE_MULTI, 2), 0, 2)));
    assert.equal(p["resume:position"], "none");
  });

  it("play:<id>:start → the first unit from the beginning", async () => {
    const t = await make();
    const p = props(await play(t, ids.playStart(BIG)));
    assert.equal(p["kp:m"], String(mid(BIG, 1)));
    assert.equal(p["resume:position"], "none");
  });

  it("explicit position: :at120 → 120, :start → none, none of them → from progress", async () => {
    const t = await make();
    assert.equal(props(await play(t, ids.playEp(BIG, BIG_S1E4, 1, 4, { at: 120 })))["resume:position"], "120");
    assert.equal(props(await play(t, ids.playEp(BIG, BIG_S1E4, 1, 4, { start: true })))["resume:position"], "none");
    assert.equal(props(await play(t, ids.playEp(BIG, BIG_S1E4, 1, 4)))["resume:position"], "597");
  });

  it("an unknown mid of a known title → { error }", async () => {
    const t = await make();
    const res = await play(t, ids.playEp(BIG, 999_999, 1, 4));
    assert.equal(typeof res.error, "string");
    assert.equal(res.url, undefined);
  });
});

describe("resolvePlay: «Продолжить» по свежим данным (CC-07, D-41)", () => {
  it("the card is cached and older than 10 min, another device marked S1E4 watched → S1E5 from the start", async () => {
    const t = await make();
    await t.run(t.ctx.repo.item(BIG));
    await t.clock.advance(11 * 60_000);
    const other = t.mock.issueToken();
    const r = await fetch(`${t.mock.url}/v1/watching/toggle?id=${BIG}&video=4&season=1&access_token=${other.access}`);
    assert.equal(r.status, 200);
    const p = props(await play(t, ids.playContinue(BIG)));
    assert.equal(p["kp:e"], "5");
    assert.equal(p["kp:m"], String(BIG_S1E5));
    assert.equal(p["resume:position"], "none");
  });

  it("a fresh card is not reloaded", async () => {
    const t = await make();
    await t.run(t.ctx.repo.item(BIG));
    await play(t, ids.playContinue(BIG));
    assert.equal(t.mock.calls().filter((c) => c.path === `/v1/items/${BIG}`).length, 1);
  });
});

describe("resolvePlay: links and the fallback chain", () => {
  it("links prefetched before resolve → one media-links in the mock journal", async () => {
    const t = await make();
    await t.run(t.ctx.repo.links(BIG_S1E4, { cls: "bg" }));
    props(await play(t, ids.playContinue(BIG)));
    assert.equal(linkCalls(t), 1);
  });

  it("no start for 9 s → step 2 with fresh links; then hls2; then the error", async () => {
    const t = await make();
    props(await play(t, ids.playContinue(BIG)));
    assert.equal(linkCalls(t), 1);

    await t.clock.advance(9_000);
    const p2 = props(await play(t, ids.playContinue(BIG)));
    assert.equal(linkCalls(t), 2);
    assert.equal(p2["label:extension"], "1080p · Студия Бета · HLS1 (новые ссылки)");
    assert.equal(p2["trigger:load"], "info:Предыдущий запуск не удался — пробую HLS1");

    await t.clock.advance(9_000);
    const r3 = await play(t, ids.playContinue(BIG));
    const p3 = props(r3);
    assert.equal(linkCalls(t), 3);
    assert.match(r3.url ?? "", /\/cdn\/hls2\/[^/]+\/2001004\.m3u8\?loc=nl$/);
    assert.equal(p3["tizen:stream:ADAPTIVE_INFO"], "STARTBITRATE=HIGHEST");
    assert.equal(p3["label:extension"], "Авто · HLS2 (резерв, озвучка по умолчанию)");
    assert.equal(p3["trigger:load"], "info:Предыдущий запуск не удался — пробую HLS2");

    await t.clock.advance(9_000);
    assert.deepEqual(await play(t, ids.playContinue(BIG)), { error: NO_START_TEXT });
    assert.equal(linkCalls(t), 3);
  });

  it("an impatient second press within 8 s → the same step, links from the cache", async () => {
    const t = await make();
    props(await play(t, ids.playContinue(BIG)));
    await t.clock.advance(3_000);
    const p = props(await play(t, ids.playContinue(BIG)));
    assert.equal(p["trigger:load"], undefined);
    assert.equal(linkCalls(t), 1);
  });

  it("media-links 500 → the next step without the user (fresh links)", async () => {
    const t = await make();
    // Транспорт сам повторяет 5xx дважды (спец. §5.3): три ответа 500 исчерпывают шаг 1.
    t.mock.setScenario({ rules: [{ path: `^${LINKS_PATH}$`, status: 500, times: 3 }] });
    const p = props(await play(t, ids.playContinue(BIG)));
    assert.equal(linkCalls(t), 4);
    assert.equal(p["label:extension"], "1080p · Студия Бета · HLS1 (новые ссылки)");
    assert.ok(t.ctx.log.entries().some((e) => e.tag === "resolve" && e.msg === "links_failed"));
  });

  it("media-links without stream URLs every time → { error } after two automatic steps", async () => {
    const t = await make();
    // 200 без `files`: ответ разобран, но ссылки на поток нет — это тоже ошибка API (Plan B §5.11).
    t.mock.setScenario({ rules: [{ path: `^${LINKS_PATH}$`, status: 200 }] });
    const res = await play(t, ids.playContinue(BIG));
    assert.equal(typeof res.error, "string");
    assert.equal(res.url, undefined);
    assert.equal(linkCalls(t), 3, "step 1, then fresh links for steps 2 and 3");
    assert.equal(t.ctx.log.entries().filter((e) => e.tag === "resolve" && e.msg === "links_failed").length, 3);
  });

  it("a network failure of media-links is not an API error: no automatic step", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: `^${LINKS_PATH}$`, drop: true, times: 3 }] });
    const res = await play(t, ids.playContinue(BIG));
    assert.equal(typeof res.error, "string");
    assert.equal(linkCalls(t), 3, "one step with the transport's own retries");
  });

  it("a manual stream mode for the title disables the automatic chain", async () => {
    const t = await make();
    t.ctx.prefs.setTitle("mode", BIG, "hls2");
    const res = await play(t, ids.playContinue(BIG));
    assert.match(res.url ?? "", /\/cdn\/hls2\//);
    assert.equal(props(res)["label:extension"], "Авто · HLS2");
  });
});

describe("resolvePlay: subscription and token", () => {
  it("inactive subscription in the cache → { error } without network", async () => {
    const t = await make();
    await t.run(t.ctx.cache.get(cacheKeys.user(), { ttlMs: 3_600_000, staleMaxMs: 0, persist: false }, async () => user(false)));
    assert.deepEqual(await play(t, ids.playContinue(BIG)), { error: NO_SUBSCRIPTION_TEXT });
    assert.equal(t.mock.calls().length, 0);
  });

  it("an hour-old inactive subscription does not block; the user is refreshed in the background", async () => {
    const t = await make();
    await t.run(t.ctx.cache.get(cacheKeys.user(), { ttlMs: 3_600_000, staleMaxMs: 0, persist: false }, async () => user(false)));
    await t.clock.advance(61 * 60_000);
    props(await play(t, ids.playContinue(BIG)));
    await until(() => t.mock.calls().some((c) => c.path === "/v1/user"), "GET /v1/user");
  });

  it("a long movie refreshes a token that would expire during playback", async () => {
    const t = await make();
    props(await play(t, ids.playContinue(FIX.MOVIE_SIMPLE)));
    assert.equal(t.mock.calls().filter((c) => c.path === "/oauth2/token").length, 1);
  });

  it("a network failure of that refresh does not prevent playback", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/oauth2/token$", drop: true }] });
    props(await play(t, ids.playContinue(FIX.MOVIE_SIMPLE)));
  });
});

describe("onTrackerEvent", () => {
  const session = (m: number, e: number, hasNext: boolean) =>
    sessionFromProps({ "kp:i": String(BIG), "kp:m": String(m), "kp:s": "1", "kp:e": String(e), "kp:n": hasNext ? "1" : "0" }, 0)!;

  it("started → the chain of that mid starts over and links of the next episode are prefetched", async () => {
    const t = await make();
    props(await play(t, ids.playContinue(BIG)));
    await t.clock.advance(9_000);
    assert.equal(props(await play(t, ids.playContinue(BIG)))["trigger:load"], "info:Предыдущий запуск не удался — пробую HLS1");

    onTrackerEvent(t.ctx, { kind: "started", s: session(BIG_S1E4, 4, true) });
    await until(() => linkCalls(t, BIG_S1E5) === 1, "prefetch of S1E5 links");
    const bg = t.mock.calls().find((c) => c.path === LINKS_PATH && c.query.includes(`mid=${BIG_S1E5}`));
    assert.ok(bg);

    await t.clock.advance(9_000);
    const p = props(await play(t, ids.playContinue(BIG)));
    assert.equal(p["trigger:load"], undefined, "step 1 again");
    assert.equal(p["label:extension"], "1080p · Студия Бета · HLS1");
  });

  it("the last episode or other events → no prefetch", async () => {
    const t = await make();
    await t.run(t.ctx.repo.item(BIG));
    const last = mid(BIG, 200);
    onTrackerEvent(t.ctx, { kind: "started", s: session(last, 20, false) });
    onTrackerEvent(t.ctx, { kind: "load", s: session(BIG_S1E4, 4, true) });
    onTrackerEvent(t.ctx, { kind: "raw", source: "handleEvent", name: "video:play" });
    await realSleep(100);
    assert.equal(linkCalls(t), 0);
  });
});
