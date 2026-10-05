import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import type { Flags } from "../../src/config/flags.ts";
import { msgs } from "../../src/router/ids.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

// Префетч карточки по фокусу (спец. §8.3, CD-10, CC-12): сообщения `pf:<id>` идут через маршрутизатор, как от MSX.

const DEBOUNCE_MS = 350;
const ELEVEN_MIN = 11 * 60_000;
const ITEM_PATH = /^\/v1\/items\/(\d+)$/;

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(flags: Partial<Flags> = {}): Promise<TestApp> {
  const t = await createTestApp({ loggedIn: true, flags });
  apps.push(t);
  return t;
}

const focus = (t: TestApp, id: number): void => t.app.handleData({ message: msgs.pf(id) });
const cardCalls = (t: TestApp): number[] =>
  t.mock.calls().flatMap((c) => {
    const m = ITEM_PATH.exec(c.path);
    return m === null ? [] : [Number(m[1])];
  });
const counter = (t: TestApp, name: string): number => t.ctx.metrics.summary().counters[`focus_prefetch:${name}`] ?? 0;
const cached = (t: TestApp, id: number): boolean => t.ctx.repo.peekItem(id)?.stale === false;

/** Загрузка идёт в реальном времени; поддельные часы при этом стоят. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (cond()) return;
    await realSleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("onFocus: debounce and «last focus wins» (CC-12)", () => {
  it("5 pf messages within 200 ms → one request items/<last id> 350 ms after the last one", async () => {
    const t = await make();
    for (const id of [1001, 1002, 1003, 1004]) {
      focus(t, id);
      await t.clock.advance(50);
    }
    focus(t, 1005);
    await t.clock.advance(DEBOUNCE_MS - 1);
    await realSleep(30);
    assert.deepEqual(cardCalls(t), [], "nothing before 350 ms without a new focus");

    await t.clock.advance(1);
    await until(() => cached(t, 1005), "the prefetched card");
    await realSleep(30);
    assert.deepEqual(cardCalls(t), [1005]);
    assert.equal(counter(t, "queued"), 1);
    assert.equal(counter(t, "hit"), 0);
    assert.equal(t.mock.calls().find((c) => c.path === "/v1/items/1005")?.query.includes("nolinks=1"), true);
  });

  it("a fresh card in the cache → no request (hit)", async () => {
    const t = await make();
    await t.run(t.ctx.repo.item(1001));
    focus(t, 1001);
    await t.clock.advance(DEBOUNCE_MS);
    await realSleep(30);
    assert.deepEqual(cardCalls(t), [1001], "only the initial load");
    assert.equal(counter(t, "hit"), 1);
    assert.equal(counter(t, "queued"), 0);
  });

  it("a card older than the TTL is refreshed in the background", async () => {
    const t = await make();
    await t.run(t.ctx.repo.item(1001));
    const first = t.ctx.repo.peekItem(1001)?.fetchedAt;
    await t.clock.advance(ELEVEN_MIN);
    focus(t, 1001);
    await t.clock.advance(DEBOUNCE_MS);
    await until(() => cached(t, 1001), "the refreshed card");
    assert.deepEqual(cardCalls(t), [1001, 1001]);
    assert.notEqual(t.ctx.repo.peekItem(1001)?.fetchedAt, first);
    assert.equal(counter(t, "queued"), 1);
  });

  it("two quick focuses during a flight → at most one prefetch at a time, the latest one runs next", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/items/\\d+$", delayMs: 300 }] });
    focus(t, 1001);
    await t.clock.advance(DEBOUNCE_MS);
    await until(() => cardCalls(t).length === 1, "the first prefetch to leave");
    focus(t, 1002);
    await t.clock.advance(DEBOUNCE_MS);
    focus(t, 1003);
    await t.clock.advance(DEBOUNCE_MS);
    assert.deepEqual(cardCalls(t), [1001], "the second waits for the first");

    await until(() => cached(t, 1003), "the last focused card");
    await realSleep(30);
    assert.deepEqual(cardCalls(t), [1001, 1003], "1002 was displaced by 1003");
    assert.equal(t.mock.stats().maxInFlight, 1);
    assert.equal(counter(t, "queued"), 3);
    assert.equal(counter(t, "dropped"), 1);
  });

  it("a failed prefetch frees the slot for the next focus", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/items/1001$", status: 404 }] });
    focus(t, 1001);
    await t.clock.advance(DEBOUNCE_MS);
    await until(() => t.ctx.log.entries().some((e) => e.tag === "prefetch" && e.msg === "failed"), "the failure");
    focus(t, 1002);
    await t.clock.advance(DEBOUNCE_MS);
    await until(() => cached(t, 1002), "the next card");
    assert.deepEqual(cardCalls(t), [1001, 1002]);
  });

  it("focusPrefetch: off → no request", async () => {
    const t = await make({ focusPrefetch: "off" });
    const timers = t.clock.pending();
    focus(t, 1001);
    assert.equal(t.clock.pending(), timers, "no debounce timer either");
    for (const id of [1002, 1003]) {
      focus(t, id);
      await t.clock.advance(DEBOUNCE_MS * 2);
    }
    await realSleep(30);
    assert.deepEqual(cardCalls(t), []);
  });
});
