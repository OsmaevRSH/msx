import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { KpHandler } from "../../src/bridge/tvx-handler.ts";
import type { MsxContentRoot, MsxResolveResponse } from "../../src/msx/types.ts";
import { SCREEN_DEADLINE_MS } from "../../src/router/router.ts";
import { encodeListKey, ids } from "../../src/router/ids.ts";
import { RETRY_CONTENT } from "../../src/screens/error.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import type { Scenario } from "../../tools/kpmock/scenario.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";
import { apiCalls, pass, waitFor } from "../progress/progress-rig.ts";
import { actions, errorCode, follow, pageItems } from "../contract/rig.ts";

// V-40: данных экрана нет за 6 с — экран ошибки `KP-NET` «KinoPub не отвечает», а не спиннер до конца повторов §5.3
// (5xx и `TypeError` — 9 с, зависание после ответов KinoPub — до 15 с). Исходный запрос не отменяется: поздний успех
// заменяет экран, если он ещё текущий; поздняя ошибка ничего не меняет.

const ID = FIX.MOVIE_SIMPLE;
const MID = FIX.MOVIE_SIMPLE * 1000 + 1;
const ITEM = ids.item(ID);
const ITEM_PATH = `/v1/items/${ID}`;
const AUDIO = ids.panel("audio", String(ID), String(MID), "c");
const MOVIES = encodeListKey({ src: "catalog", type: "movie", sort: "-updated" });
const SLOW = /^KinoPub не отвечает\. Проверьте VPN\{br\}Код: KP-NET$/;
const NO_LINK = /^Нет связи с KinoPub\. Проверьте VPN/;
/** Повторы 5xx и `TypeError` по §5.3: попытки в 0, 3 и 9 с. */
const RETRIES_DONE_MS = 9000;
const card = (n?: number): Partial<Scenario> => ({ rules: [{ path: `^${ITEM_PATH}$`, status: 502, ...(n === undefined ? {} : { times: n }) }] });

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(o: TestAppOptions = {}): Promise<TestApp> {
  const t = await createTestApp({ loggedIn: true, ...o });
  apps.push(t);
  return t;
}

async function timed(t: TestApp, dataId: string): Promise<{ s: MsxContentRoot; ms: number }> {
  const t0 = t.clock.perf();
  const s = (await t.request(dataId)) as MsxContentRoot;
  return { s, ms: t.clock.perf() - t0 };
}

const replaces = (t: TestApp): string[] => actions(t).filter((a) => a.startsWith("replace:"));

/** `replace:<slot>:<flag>:request:interaction:<dataId>@P` → dataId; флаг — того экрана, который заменяется. */
function replaced(action: string | undefined, slot: "content" | "panel", flag: string | undefined): string {
  const head = `replace:${slot}:${flag}:`;
  assert.ok(flag !== undefined && action?.startsWith(head) === true, `not ${head}…: ${action}`);
  return follow(action.slice(head.length), "");
}

function assertSlow(s: MsxContentRoot, retry: string, width: number): void {
  const items = pageItems(s);
  assert.equal(errorCode(s), "KP-NET");
  assert.match(items[0]?.text ?? "", SLOW);
  assert.equal(items[0]?.layout, `0,0,${width},4`);
  assert.equal(items[1]?.label, "Повторить");
  assert.equal(items[1]?.action, retry);
  assert.match(s.flag ?? "", /^late_\d+$/, "a unique flag for the late replace");
}

describe("V-40: an error screen within 6 s when nothing is cached", () => {
  it("SCREEN_DEADLINE_MS is 6 s", () => {
    assert.equal(SCREEN_DEADLINE_MS, 6000);
  });

  it("5xx: KP-NET «KinoPub не отвечает» after 6 s, not after the retries at 9 s; the late failure changes nothing", async () => {
    const t = await make();
    t.mock.setScenario(card());
    const { s, ms } = await timed(t, ITEM);
    assert.equal(ms, SCREEN_DEADLINE_MS);
    assertSlow(s, RETRY_CONTENT, 12);
    assert.equal(apiCalls(t, ITEM_PATH).length, 2, "the request is not cancelled: attempts at 0 and 3 s so far");

    await pass(t, 10_000);
    assert.equal(apiCalls(t, ITEM_PATH).length, 3, "the third attempt at 9 s still went out");
    assert.deepEqual(actions(t), [], "the screen already shows an error");
  });

  it("TypeError (connection dropped): KP-NET after 6 s instead of 9 s", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: ".*", drop: true }] });
    const { s, ms } = await timed(t, ITEM);
    assert.equal(ms, SCREEN_DEADLINE_MS);
    assertSlow(s, RETRY_CONTENT, 12);
    await pass(t, 10_000);
    assert.deepEqual(actions(t), []);
  });

  it("the API hangs after KinoPub has answered (live link): KP-NET after 6 s instead of the 8–15 s timeouts", async () => {
    const t = await make();
    const list = (await t.request(ids.list(MOVIES))) as MsxContentRoot;
    assert.equal(errorCode(list), undefined, "KinoPub answered: the link is alive");
    t.mock.setScenario({ rules: [{ path: ".*", hang: true }] });
    t.clock.ioGraceMs = 20;
    const { s, ms } = await timed(t, ITEM);
    assert.equal(ms, SCREEN_DEADLINE_MS);
    assertSlow(s, RETRY_CONTENT, 12);
    await pass(t, 20_000);
    assert.deepEqual(actions(t), []);
  });

  it("the API hangs on a dead link: the transport verdict of the same 6 s wins — «Нет связи», no flag", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: ".*", hang: true }] });
    t.clock.ioGraceMs = 20;
    const { s, ms } = await timed(t, ITEM);
    assert.equal(ms, SCREEN_DEADLINE_MS);
    assert.equal(errorCode(s), "KP-NET");
    assert.match(pageItems(s)[0]?.text ?? "", NO_LINK);
    assert.equal(s.flag, undefined);
  });

  it("MSX gets exactly one answer per handleRequest, also when the late answer comes", async () => {
    const t = await make();
    t.mock.setScenario(card(2));
    const answers: unknown[] = [];
    new KpHandler(t.app).handleRequest(ITEM, {}, (r) => answers.push(r));
    await pass(t, 20_000);
    assert.equal(answers.length, 1);
    assert.equal(errorCode(answers[0] as MsxContentRoot), "KP-NET");
    assert.equal(replaces(t).length, 1, "the late card comes as replace:content, not as a second answer");
  });
});

describe("V-40: the late answer", () => {
  it("success while the error screen is current → replace:content by its flag; the replace gets the card without a new request", async () => {
    const t = await make();
    t.mock.setScenario(card(2));
    const t0 = t.clock.perf();
    const { s } = await timed(t, ITEM);
    assertSlow(s, RETRY_CONTENT, 12);
    assert.deepEqual(actions(t), []);

    await waitFor(t, () => replaces(t).length > 0, "the late replace");
    assert.equal(t.clock.perf() - t0, RETRIES_DONE_MS, "the original request succeeded at 9 s");
    assert.equal(apiCalls(t, ITEM_PATH).at(-1)?.status, 200);
    const [action, ...rest] = replaces(t);
    assert.deepEqual(rest, []);
    assert.equal(replaced(action, "content", s.flag), ITEM);

    const calls = t.mock.calls().length;
    const late = await timed(t, ITEM);
    assert.equal(late.ms, 0);
    assert.equal(errorCode(late.s), undefined);
    assert.equal(late.s.flag, `item_${ID}`);
    assert.equal(t.mock.calls().length, calls, "the replace is answered with the late data");
  });

  it("success after the user moved on → no replace; the card lands in the cache", async () => {
    const t = await make();
    t.mock.setScenario(card(2));
    const { s } = await timed(t, ITEM);
    assertSlow(s, RETRY_CONTENT, 12);
    const list = (await t.request(ids.list(MOVIES))) as MsxContentRoot;
    assert.equal(errorCode(list), undefined);

    await pass(t, 10_000);
    assert.equal(apiCalls(t, ITEM_PATH).at(-1)?.status, 200);
    assert.deepEqual(replaces(t), []);

    const calls = apiCalls(t, ITEM_PATH).length;
    const back = await timed(t, ITEM);
    assert.equal(back.ms, 0);
    assert.equal(back.s.flag, `item_${ID}`);
    assert.equal(apiCalls(t, ITEM_PATH).length, calls, "the card comes from the cache");
  });

  it("«Повторить» on the error screen → its own answer replaces it; the late original sends no replace", async () => {
    const t = await make();
    t.mock.setScenario(card(2));
    const { s } = await timed(t, ITEM);
    assertSlow(s, RETRY_CONTENT, 12);
    const retry = await timed(t, ITEM);
    assert.equal(retry.s.flag, `item_${ID}`);
    await pass(t, 10_000);
    assert.deepEqual(replaces(t), [], "the error screen is gone: its late data is not needed");
  });
});

describe("V-40: fast answers and other requests", () => {
  it("a card within 6 s (one 5xx, the retry at 3 s answers) → the card, no deadline later", async () => {
    const t = await make();
    t.mock.setScenario(card(1));
    const { s, ms } = await timed(t, ITEM);
    assert.equal(ms, 3000);
    assert.equal(s.flag, `item_${ID}`);
    await pass(t, 20_000);
    assert.deepEqual(replaces(t), []);
    assert.equal(t.ctx.metrics.summary().counters["screen:deadline"], undefined);
  });

  it("SWR: a cached card is answered at once while KinoPub hangs", async () => {
    const t = await make();
    await t.request(ITEM);
    t.mock.setScenario({ rules: [{ path: ".*", hang: true }] });
    t.clock.ioGraceMs = 20;
    const { s, ms } = await timed(t, ITEM);
    assert.equal(ms, 0);
    assert.equal(s.flag, `item_${ID}`);
  });

  it("a panel: the error inside the panel (8 wide, «Повторить» — reload:panel) after 6 s; the late answer replaces the panel by its flag", async () => {
    const t = await make();
    await t.request(ids.list(MOVIES));
    t.mock.setScenario(card(2));
    const { s, ms } = await timed(t, AUDIO);
    assert.equal(ms, SCREEN_DEADLINE_MS);
    assertSlow(s, "reload:panel", 8);
    assert.equal(t.ctx.current.get(), ids.list(MOVIES), "a panel does not change the current screen");

    await waitFor(t, () => replaces(t).length > 0, "the late replace");
    const [action, ...rest] = replaces(t);
    assert.deepEqual(rest, []);
    assert.equal(replaced(action, "panel", s.flag), AUDIO);
    const calls = t.mock.calls().length;
    const panel = (await t.request(AUDIO)) as MsxContentRoot;
    assert.equal(panel.headline, "Озвучка");
    assert.equal(errorCode(panel), undefined);
    assert.equal(t.mock.calls().length, calls);
  });

  it("video:resolve is not cut by the deadline: its answer comes after the retries", async () => {
    const t = await make();
    t.mock.setScenario(card(2));
    const t0 = t.clock.perf();
    const res = (await t.request(ids.playStart(ID))) as MsxResolveResponse;
    assert.ok(t.clock.perf() - t0 >= RETRIES_DONE_MS);
    assert.equal(res.error, undefined);
    assert.equal(typeof res.url, "string");
  });

  it("«Диагностика» has no screen deadline: it opens when KinoPub is down, with the failure in its own row", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/", status: 502 }] });
    const { s, ms } = await timed(t, ids.probe());
    assert.ok(ms >= RETRIES_DONE_MS, `answered after ${ms} ms`);
    assert.equal(s.flag, "probe");
    assert.equal(errorCode(s), undefined);
  });

  it("logged out: the login screen keeps its own 6 s verdict (KP-NET «Нет связи»), no deadline flag", async () => {
    const t = await make({ loggedIn: false });
    t.mock.setScenario({ rules: [{ path: ".*", hang: true }] });
    t.clock.ioGraceMs = 20;
    const { s, ms } = await timed(t, ITEM);
    assert.equal(ms, SCREEN_DEADLINE_MS);
    assert.match(pageItems(s)[0]?.text ?? "", NO_LINK);
    assert.equal(s.flag, "login");
  });
});
