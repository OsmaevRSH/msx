import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import { cacheKeys } from "../../src/cache/repo.ts";
import { encodeListKey, ids } from "../../src/router/ids.ts";
import { warmHome } from "../../src/screens/home.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";
import { apiCalls } from "../progress/progress-rig.ts";

// CNFR-18, M-6 (QA-API-5): не больше 3 запросов к API одновременно, фоновые — 1 из них; после 429 — по одному 30 с.
// Счёт ведёт kpmock (`maxApiInFlight`: только `/v1/*` и `/oauth2/*`, без постеров и CDN). Задержка ответа mock нужна,
// чтобы запросы и правда шли внахлёст.

const SERIALS = encodeListKey({ src: "catalog", type: "serial", sort: "-updated" });
const MOVIES = encodeListKey({ src: "catalog", type: "movie", sort: "-updated" });
const DELAY_MS = 40;
const SLOW_MS = 30_000;
/** Прогрев главной (`warmHome`, фон) дошёл до последней полки. */
const WARM_KEY = cacheKeys.shelf("hot", "serial");

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

/** Поддельные часы идут, пока `cond` не станет истиной; ответы mock — в реальном времени. */
async function until(t: TestApp, cond: () => boolean, what: string): Promise<void> {
  const wait = async (): Promise<void> => {
    for (let i = 0; i < 1000 && !cond(); i++) await realSleep(10);
    assert.ok(cond(), `timed out waiting for ${what}`);
  };
  await t.run(wait());
}

const warmed = (t: TestApp): boolean => t.ctx.cache.peek(WARM_KEY) !== undefined;
/** Запросы фонового класса по журналу транспорта (`GET /v1/… 200 40ms bg`). */
const bgCalls = (t: TestApp): string[] => t.ctx.log.entries().filter((e) => e.tag === "api" && / bg$/.test(e.msg)).map((e) => e.msg);

describe("M-6: the client keeps the API limits (contract)", () => {
  it("a cold home, a list and the warm-up of home at once → never more than 3 API requests in flight", async () => {
    const t = await make();
    t.mock.setScenario({ delayMs: DELAY_MS });
    warmHome(t.ctx);
    await t.run(Promise.all([t.app.handleRequest(ids.home(), {}), t.app.handleRequest(ids.list(SERIALS), {})]));
    await until(t, () => warmed(t), "the warm-up of home");
    const { maxApiInFlight } = t.mock.stats();
    assert.ok(apiCalls(t, "/v1/items").length > 0 && apiCalls(t, "/v1/history").length > 0, "home and the list did load");
    assert.equal(maxApiInFlight, 3, "requests overlapped up to the limit, never above it");
  });

  it("after a 429: one API request at a time for 30 s — a screen, a list and the warm-up wait their turn; then 3 again", async () => {
    const t = await make();
    t.mock.setScenario({ delayMs: DELAY_MS, rules: [{ path: "^/v1/genres$", status: 429, times: 1 }] });
    const t0 = t.clock.perf();
    await t.run(t.ctx.api.genres("movie"));
    assert.deepEqual(apiCalls(t, "/v1/genres").map((c) => c.status), [429, 200]);

    warmHome(t.ctx);
    await t.run(Promise.all([t.app.handleRequest(ids.home(), {}), t.app.handleRequest(ids.list(SERIALS), {})]));
    assert.ok(t.clock.perf() - t0 < SLOW_MS, "the screens were answered within the slow window");
    assert.ok(apiCalls(t, "/v1/items").length > 0 && apiCalls(t, "/v1/history").length > 0, "home and the list did load");
    assert.equal(t.mock.stats().maxApiInFlight, 1);
    assert.deepEqual(bgCalls(t), [], "no bg request while the limiter is slow");

    await t.clock.advance(SLOW_MS);
    await t.run(Promise.all([t.app.handleRequest(ids.list(MOVIES), {}), t.ctx.api.genres("serial"), t.ctx.api.user(), t.ctx.api.serverLocations()]));
    assert.equal(t.mock.stats().maxApiInFlight, 3, "after 30 s the limit is 3 again");
  });
});
