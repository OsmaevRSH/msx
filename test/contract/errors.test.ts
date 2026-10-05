import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MsxContentRoot, MsxResolveResponse } from "../../src/msx/types.ts";
import type { TrackerEvent } from "../../src/progress/tracker.ts";
import { encodeListKey, ids } from "../../src/router/ids.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import type { Scenario } from "../../tools/kpmock/scenario.ts";
import { FakeClock } from "../helpers/fake-clock.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";
import { apiCalls, load, pass, player, recordEvents, snapshot, toggles, waitFor, watchingReads } from "../progress/progress-rig.ts";
import { assertCleanTraffic, assertNoCorsVerdict, errorCode, follow, pageItems, pick, probes } from "./rig.ts";

// CC-13 сквозной (спец. §5.3, §12, §14.3; CM-01): ошибки без CORS, сеть, «CORS выключен» и потерянный ответ `toggle`
// глазами экранов плагина. После каждого теста — проверка трафика: ни одного preflight, пробы `no-cors` — только
// `GET /v1/types?access_token=x`.

const SERIALS = encodeListKey({ src: "catalog", type: "serial", sort: "-updated" });
const MOVIES = encodeListKey({ src: "catalog", type: "movie", sort: "-updated" });
const PROBE = "GET /v1/types?access_token=x";
const WEEK_MS = 7 * 86_400_000;

let apps: TestApp[] = [];

afterEach(async () => {
  const done = apps;
  apps = [];
  try {
    for (const m of new Set(done.map((t) => t.mock))) assertCleanTraffic(m.calls(), done.filter((t) => t.mock === m));
  } finally {
    // Mock закрывает тот стенд, который его поднял (`createTestApp` без `mock`).
    for (const t of done) await t.close();
  }
});

async function make(o: TestAppOptions = {}): Promise<TestApp> {
  const t = await createTestApp({ loggedIn: true, ...o });
  apps.push(t);
  return t;
}

const logged = (t: TestApp, msg: string): number => t.ctx.log.entries().filter((e) => e.msg === msg).length;

describe("CC-13 end to end: errors without CORS and the network (contract)", () => {
  it("no_cors_errors + 429 on /v1/items → 3 attempts, one no-cors probe, list screen KP-429 (never KP-CORS), parallelism 1 for 30 s", async () => {
    const t = await make();
    t.mock.setScenario({ noCorsErrors: true, rules: [{ path: "^/v1/items$", status: 429 }] });
    const list = (await t.request(ids.list(SERIALS))) as MsxContentRoot;
    assert.equal(errorCode(list), "KP-429");
    assert.match(pageItems(list)[0]?.text ?? "", /^KinoPub перегружен, повторите через минуту/);
    assertNoCorsVerdict([list]);
    assert.deepEqual(apiCalls(t, "/v1/items").map((c) => c.status), [429, 429, 429], "auto retries 3 s, 6 s");
    assert.deepEqual(probes(t), [PROBE]);
    assert.equal(logged(t, "api_no_cors"), 1);

    // Как 429 (спец. §12): передний план — по одному 30 с.
    t.mock.setScenario({ noCorsErrors: false, rules: [], delayMs: 40 });
    const burst = (): Promise<unknown> => t.run(Promise.all([t.ctx.api.genres("movie"), t.ctx.api.serverLocations(), t.ctx.api.user()]));
    await burst();
    assert.equal(t.mock.stats().maxInFlight, 1);
    await pass(t, 30_000);
    await burst();
    assert.equal(t.mock.stats().maxInFlight, 3, "after 30 s the limiter is back to 3");
  });

  it("network down (every path dropped): no cache → KP-NET screen; a list kept in L2 → the list with «нет связи»", async () => {
    const storage = new MemoryStorage();
    const a = await make({ storage });
    const fresh = (await a.request(ids.list(SERIALS))) as MsxContentRoot;
    assert.equal(fresh.items?.length, 48);
    await waitFor(a, () => (a.storage.writes.some((k) => k.startsWith("kp.l2.list:"))), "first page in L2");

    // Следующий запуск через 8 дней, VPN выключен. Запись L2 старше stale-max (7 суток), поэтому SWR идёт в сеть и после
    // её отказа отдаёт кэш с `offline`; в пределах недели устаревший список отдаётся сразу, без сети (спец. §8.2).
    const b = await make({ mock: a.mock, storage, loggedIn: false, clock: new FakeClock(a.clock.now() + WEEK_MS + 86_400_000) });
    b.mock.setScenario({ rules: [{ path: ".*", drop: true }] });
    const none = (await b.request(ids.list(MOVIES))) as MsxContentRoot;
    assert.equal(errorCode(none), "KP-NET");
    assert.match(pageItems(none)[0]?.text ?? "", /^Нет связи с KinoPub\. Проверьте VPN/);
    assert.deepEqual(probes(b), [PROBE], "3 TypeErrors → one probe, it fails too → KP-NET");

    const cached = (await b.request(ids.list(SERIALS))) as MsxContentRoot;
    assert.equal(errorCode(cached), undefined);
    assert.deepEqual(cached.items?.map((i) => i.kid), fresh.items?.map((i) => i.kid));
    assert.match(cached.extension ?? "", /нет связи/);
    assertNoCorsVerdict([none, cached]);
  });

  it("cors_off: after 3 TypeErrors the no-cors probe passes → the screen shows KP-429; no screen says KP-CORS, only CDG-01 does", async () => {
    const t = await make();
    t.mock.setScenario({ corsOff: true });
    const list = (await t.request(ids.list(SERIALS))) as MsxContentRoot;
    assert.equal(errorCode(list), "KP-429", "«ответ без CORS» is handled as 429 (§5.3 п. 2)");
    assert.equal(logged(t, "api_no_cors"), 1);
    assert.deepEqual(probes(t), [PROBE]);

    // Код второго экрана подряд — см. todo-тест BUG-29-1 ниже; здесь только «не KP-CORS».
    const card = (await t.request(ids.item(FIX.SERIAL_SMALL))) as MsxContentRoot;
    assert.notEqual(errorCode(card), undefined);
    assertNoCorsVerdict([list, card]);

    const cdg01 = await t.run(t.ctx.probe.run("CDG-01"));
    assert.equal(cdg01.ok, false);
    assert.equal(cdg01.values.code, "KP-CORS");
    assert.match(cdg01.summary, /^KP-CORS/);
    assert.equal(cdg01.values.noCorsOk, 3);
    assert.ok(probes(t).length === 4 && probes(t).every((p) => p === PROBE), "CDG-01 probes the same fixed URL");
  });

  // BUG-29-1 (src/api/transport.ts, этап 11): TypeError, который проба признала «ответом без CORS», обрабатывается
  // «как 429» для повторов и лимитера, но всё равно считается сбоем circuit breaker (настоящий 429 зовёт
  // `breaker.success()`). Три попытки первого экрана и две второго открывают breaker, третья попытка второго экрана —
  // `KP-NET breaker-open`: пользователь видит «Нет связи … Проверьте VPN» вместо KP-429 (спец. §5.3 п. 2, §12, стр. 1).
  const bug1: [string, Partial<Scenario>][] = [
    ["cors_off", { corsOff: true }],
    ["no_cors_errors + 429 everywhere", { noCorsErrors: true, rules: [{ path: "^/v1/(?!types)", status: 429 }] }],
  ];
  for (const [name, scenario] of bug1) {
    it(`${name}: the second screen in a row is still KP-429, not KP-NET from an open breaker`, { todo: "BUG-29-1: CORS-less errors open the circuit breaker" }, async () => {
      const t = await make();
      t.mock.setScenario(scenario);
      const list = (await t.request(ids.list(SERIALS))) as MsxContentRoot;
      assert.equal(errorCode(list), "KP-429");
      const card = (await t.request(ids.item(FIX.SERIAL_SMALL))) as MsxContentRoot;
      assert.equal(errorCode(card), "KP-429", `log: ${t.ctx.log.entries().filter((e) => e.tag === "api").map((e) => e.msg).join("; ")}`);
    });
  }

  it("toggle_lost_response on «просмотрено» from a real resolve → queued, no blind retry; flush reconciles: one toggle in total, status 1", async () => {
    const t = await make();
    t.mock.setScenario({ toggleLostResponse: 1 });
    const card = (await t.request(ids.item(FIX.SERIAL_SMALL))) as MsxContentRoot;
    const main = pick(pageItems(card), (i) => i.id === "b_main", "main button");
    const res = (await t.request(follow(main.action, "video:resolve"))) as MsxResolveResponse;
    const props = res.properties ?? {};
    assert.equal(props["kp:e"], "2");

    const ev = recordEvents(t);
    const watched = (): string[] => ev.flatMap((e: TrackerEvent) => (e.kind === "watched" ? [e.result] : []));
    load(t, props, 0, 60);
    player(t, "play", { state: 1, position: 0, duration: 60 });
    await pass(t, 55_000);
    snapshot(t, 55, props, 60);
    await waitFor(t, () => watched().length === 1, "watched result");
    assert.deepEqual(watched(), ["queued"]);
    assert.deepEqual(toggles(t).map((c) => c.status), [0], "the toggle was applied, its answer lost; no automatic repeat");
    assert.equal(t.ctx.store.get<{ desired: number }>("out", `w_${FIX.SERIAL_SMALL}_1_2`)?.desired, 1);
    assert.deepEqual(probes(t), [], "a lost toggle is one TypeError — no probe, and never a probe of /watching/toggle");

    // Отметка видна сразу: экран показывает ✓ из оверлея, хотя ответа KinoPub не было (спец. §12).
    const season = (await t.request(ids.season(FIX.SERIAL_SMALL, 1))) as MsxContentRoot;
    assert.equal(pick(season.items, (i) => i.id === `e${FIX.SERIAL_SMALL * 1000 + 2}`, "S1E2").badge, "✓");

    await t.run(t.ctx.outbox.flush());
    assert.equal(watchingReads(t).length, 2, "status check before the toggle and again before the outbox retry");
    assert.equal(toggles(t).length, 1, "the status already equals the desired one — no second toggle");
    assert.equal(t.ctx.outbox.size(), 0);
    assert.equal(t.mock.state.watching.get(`${FIX.SERIAL_SMALL}:1:2`)?.status, 1);
  });

  it("a refresh failing without CORS is the 3rd TypeError in a row: the probe is GET /v1/types, never /oauth2/token; no retry, tokens kept", async () => {
    const t = await make();
    const pair = t.storage.getItem("kp.auth.pair");
    // Токен истекает через 10 мин: resolve сериала (60 с + запас 600 с) продлевает его заранее (спец. §7.3).
    await t.clock.advance(3000_000);
    t.mock.setScenario({ rules: [{ path: "^/oauth2/token$", status: 502 }] });
    const card = (await t.request(ids.item(FIX.SERIAL_SMALL))) as MsxContentRoot;
    const playId = follow(pick(pageItems(card), (i) => i.id === "b_main", "main button").action, "video:resolve");
    const warm = (await t.request(playId)) as MsxResolveResponse;
    assert.equal(warm.error, undefined, "502 on refresh does not block the start");
    assert.equal(apiCalls(t, "/oauth2/token").length, 1);

    // Карточка и ссылки в L1: каждый resolve делает ровно один сетевой запрос — refresh, и он падает без CORS.
    t.mock.setScenario({ noCorsErrors: true });
    for (let i = 0; i < 3; i++) {
      const res = (await t.request(playId)) as MsxResolveResponse;
      assert.equal(res.error, undefined);
    }
    assert.equal(apiCalls(t, "/oauth2/token").length, 4, "one refresh per resolve, no automatic retry (CM-01)");
    assert.ok(apiCalls(t, "/oauth2/token").every((c) => c.origin !== undefined), "refresh is never sent as no-cors");
    assert.deepEqual(probes(t), [PROBE], "the 3rd TypeError probes the fixed URL");
    assert.equal(logged(t, "api_no_cors"), 1);
    assert.ok(t.ctx.auth.isLoggedIn());
    assert.equal(t.storage.getItem("kp.auth.pair"), pair, "a network failure of refresh does not touch the pair");
  });
});
