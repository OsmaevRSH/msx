import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as realSleep } from "node:timers/promises";
import type { User } from "../../src/api/models.ts";
import { cacheKeys } from "../../src/cache/repo.ts";
import { RETRY_CONTENT } from "../../src/screens/error.ts";
import { commitMsg, contentAction, replaceContent } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { encodeListKey, ids, msgs } from "../../src/router/ids.ts";
import { homeScreen, warmHome } from "../../src/screens/home.ts";
import { MAX_BYTES, bytes } from "../../src/screens/list.ts";
import { refreshAfterPlayback } from "../../src/screens/refresh.ts";
import { FIX, catalog } from "../../tools/kpmock/fixtures.ts";
import { FAKE_EPOCH, FakeClock } from "../helpers/fake-clock.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";

// Главная S4 (спец. §8.4, §6.3, §11; Plan B S4; CC-11, CNFR-04/05/16).

const P = TEST_P;
const HOME = ids.home();
const REPLACE = replaceContent("home", P, HOME);
const ALL = [
  "Продолжить просмотр", "Новые фильмы", "Новые сериалы", "Закладки",
  "Популярные фильмы", "Популярные сериалы", "Горячее: фильмы", "Горячее: сериалы",
];
const [MIN, RECHECK_MS, DEADLINE_MS] = [60_000, 3000, 1500];

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps.reverse()) await t.close();
  apps = [];
});

async function make(o: TestAppOptions = {}): Promise<TestApp> {
  const t = await createTestApp({ loggedIn: true, ...o });
  apps.push(t);
  return t;
}

const open = async (t: TestApp): Promise<MsxContentRoot> => (await t.request(HOME)) as MsxContentRoot;
const items = (s: MsxContentRoot): MsxContentItem[] => (s.pages ?? []).flatMap((p) => p.items);
const headers = (s: MsxContentRoot): string[] =>
  items(s).filter((i) => i.type === "space" && /^0,[04],16,1$/.test(i.layout ?? "")).map((i) => i.headline ?? "");
const actions = (t: TestApp): string[] => t.host.actions.map((a) => a.action);
const counter = (t: TestApp, name: string): number => t.ctx.metrics.summary().counters[name] ?? 0;
const calls = (t: TestApp, path: string): number => t.mock.calls().filter((c) => c.path === path).length;

/** Элементы полки: заголовок `0,y,16,1` и плитки `x,y+1,2,3` той же страницы. */
function shelf(s: MsxContentRoot, title: string): MsxContentItem[] {
  for (const p of s.pages ?? []) {
    const h = p.items.find((i) => i.type === "space" && i.headline === title);
    if (h === undefined) continue;
    const y = Number((h.layout ?? "").split(",")[1]);
    return p.items.filter((i) => i !== h && Number((i.layout ?? "").split(",")[1]) === y + 1);
  }
  assert.fail(`no shelf ${title}`);
}

/** Фоновая работа идёт в реальном времени; поддельные часы при этом стоят. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await realSleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** То же, но таймеры FakeClock (лимитер, повторы, ожидание 3 с) идут; запросы в полёте mock дожидаются. */
function drive(t: TestApp, cond: () => boolean, what: string): Promise<void> {
  t.clock.ioGraceMs = 2000;
  return t.run(until(cond, what));
}

/** Таймеры FakeClock идут до первого действия плагина: проверка стоит ровно на нём, время дальше не убегает. */
function driveToAction(t: TestApp): Promise<void> {
  t.clock.ioGraceMs = 2000;
  return t.run(new Promise<void>((resolve) => {
    const exec = t.host.executeAction.bind(t.host);
    t.host.executeAction = (action: string, data?: unknown): void => {
      exec(action, data);
      resolve();
    };
  }));
}

/** Персональные записи кэша обновлены по сети после `advance` (а не отданы из кэша). */
const refreshed = (t: TestApp, key: string): boolean => {
  const got = t.ctx.cache.peek(key);
  return got !== undefined && got.fetchedAt === t.clock.now() && !got.stale;
};

/** Все записи, из которых собирается главная, и `user` (его запрос главная не ждёт). */
const HOME_KEYS = [
  cacheKeys.history(), cacheKeys.serials(), cacheKeys.bookmarks(), cacheKeys.user(),
  ...["fresh", "popular", "hot"].flatMap((kind) => ["movie", "serial"].map((type) => cacheKeys.shelf(kind, type))),
];

/** Загрузки главной дошли до кэша, и отложенная запись L2 (1 с, спец. §7.3) ушла в хранилище. */
async function persisted(t: TestApp): Promise<void> {
  await drive(t, () => HOME_KEYS.every((k) => t.ctx.cache.peek(k) !== undefined), "home loads");
  await t.clock.advance(1000);
}

describe("homeScreen: layout (Plan B S4, спец. §8.4)", () => {
  it("16×8 list, flag home, not cached by MSX, eight shelves two per page in the Plan B order", async () => {
    const t = await make();
    const s = await open(t);
    assert.equal(s.type, "list");
    assert.equal(s.compress, true);
    assert.equal(s.flag, "home");
    assert.equal(s.cache, false);
    assert.equal(s.reuse, false);
    assert.equal(s.headline, "Главная");
    assert.deepEqual(headers(s), ALL);
    assert.equal(s.pages?.length, 4);
    for (const p of s.pages ?? []) {
      assert.deepEqual(p.items.filter((i) => i.type === "space").map((i) => i.layout), ["0,0,16,1", "0,4,16,1"]);
    }
  });

  it("catalog shelf: 7 posters x = 0…12 with explicit numeric pf selection, «Ещё →» at 14 to the full list", async () => {
    const t = await make();
    const s = await open(t);
    const tiles = shelf(s, "Новые фильмы");
    assert.deepEqual(tiles.map((i) => i.layout), [0, 2, 4, 6, 8, 10, 12, 14].map((x) => `${x},5,2,3`));
    const more = tiles.pop();
    assert.equal(more?.title, "Ещё →");
    assert.equal(more?.action, contentAction(P, ids.list(encodeListKey({ src: "fresh", type: "movie" }))));
    for (const tile of tiles) {
      const id = Number(/^content:request:interaction:item:(\d+)@/.exec(tile.action ?? "")?.[1]);
      assert.ok(id > 0, `tile action ${tile.action}`);
      assert.deepEqual(tile.selection, { action: commitMsg(msgs.pf(id)) });
      assert.ok(tile.image !== undefined && tile.title !== undefined);
    }
    assert.equal(shelf(s, "Горячее: сериалы").at(-1)?.action, contentAction(P, ids.list(encodeListKey({ src: "hot", type: "serial" }))));
  });

  it("no {context:…} anywhere, element ids unique, JSON ≤ 32 KB (CNFR-16)", async () => {
    const t = await make();
    const s = await open(t);
    const json = JSON.stringify(s);
    assert.doesNotMatch(json, /\{context:/);
    const idsOnScreen = items(s).flatMap((i) => (i.id === undefined ? [] : [i.id]));
    assert.equal(new Set(idsOnScreen).size, idsOnScreen.length);
    assert.ok(bytes(s) <= MAX_BYTES, `${bytes(s)} bytes`);
  });

  it("«Продолжить»: progress, tag, badge and stamp, tiles to the card; no «Ещё» (Р-22)", async () => {
    const t = await make();
    const tiles = shelf(await open(t), "Продолжить просмотр");
    assert.deepEqual(tiles.map((i) => i.layout), ["0,1,2,3", "2,1,2,3", "4,1,2,3"]);
    const [big, movie] = tiles;
    assert.equal(big?.action, contentAction(P, ids.item(FIX.SERIAL_BIG)));
    assert.deepEqual(big?.selection, { action: commitMsg(msgs.pf(FIX.SERIAL_BIG)) });
    assert.equal(big?.tag, "S1E4");
    assert.equal(big?.badge, "+2");
    assert.equal(big?.progressColor, "msx-blue");
    assert.equal(movie?.action, contentAction(P, ids.item(FIX.MOVIE_SIMPLE)));
    assert.equal(movie?.stamp, "осталось 1 ч 10 мин");
    assert.equal(movie?.progress, 0.22);
  });

  it("«Продолжить» holds up to 8 titles, x = 0…14", async () => {
    const t = await make();
    const now = Math.floor(Date.now() / 1000);
    const films = catalog().filter((it) => it.type === "movie" && it.videos?.[0] !== undefined && it.deleted !== true).slice(0, 10);
    films.forEach((it, i) => t.mock.state.history.push({ item: it.id, season: 0, video: 1, time: 60, lastSeen: now - 86_400 - i }));
    const tiles = shelf(await open(t), "Продолжить просмотр");
    assert.deepEqual(tiles.map((i) => i.layout), [0, 2, 4, 6, 8, 10, 12, 14].map((x) => `${x},1,2,3`));
    assert.ok(tiles.every((i) => i.title !== "Ещё →"));
  });

  it("«Закладки»: folder tiles to the folder list, «Ещё →» to bookmarks", async () => {
    const t = await make();
    const tiles = shelf(await open(t), "Закладки");
    assert.equal(tiles.length, 2);
    assert.equal(tiles[0]?.title, "Избранное");
    assert.equal(tiles[0]?.titleFooter, "2 шт.");
    assert.equal(tiles[0]?.icon, "bookmark");
    assert.equal(tiles[0]?.action, contentAction(P, ids.list(encodeListKey({ src: "folder", folder: 1 }))));
    assert.equal(tiles[1]?.layout, "2,5,2,3");
    assert.equal(tiles[1]?.action, contentAction(P, ids.bookmarks()));
  });

  it("focus prefetch off — no selection on tiles", async () => {
    const t = await make({ flags: { focusPrefetch: "off" } });
    assert.ok(items(await open(t)).every((i) => i.selection === undefined));
  });

  it("inactive subscription from the cache → warning headline with the end date", async () => {
    const t = await make();
    const user: User = { username: "u", subscription: { active: false, endTime: Date.UTC(2026, 2, 15, 12) / 1000, days: 0 } };
    await t.run(t.ctx.cache.get(cacheKeys.user(), { ttlMs: 3_600_000, staleMaxMs: 0, persist: false }, async () => user));
    const s = await open(t);
    assert.equal(s.headline, "{ico:msx-yellow:warning} Подписка KinoPub неактивна (до 15.03.2026)");
    assert.deepEqual(headers(s), ALL);
  });

  it("a long plugin address: shelves are dropped from the end to stay ≤ 32 KB", async () => {
    const t = await make({ P: `https://example.github.io/${"x".repeat(400)}/app/index.html` });
    const s = await open(t);
    assert.ok(bytes(s) <= MAX_BYTES, `${bytes(s)} bytes`);
    const h = headers(s);
    assert.ok(h.length >= 1 && h.length < ALL.length);
    assert.deepEqual(h, ALL.slice(0, h.length));
  });
});

describe("homeScreen: empty and failing shelves", () => {
  it("all shelves empty → text and «Повторить», still flag home", async () => {
    const t = await make();
    const empty = { ttlMs: 3_600_000, staleMaxMs: 0, persist: false };
    const keys = [cacheKeys.history(), cacheKeys.serials(), cacheKeys.movies(), cacheKeys.bookmarks()];
    for (const kind of ["fresh", "popular", "hot"]) for (const type of ["movie", "serial"]) keys.push(cacheKeys.shelf(kind, type));
    for (const k of keys) await t.run(t.ctx.cache.get(k, empty, async () => []));
    const s = await open(t);
    assert.equal(s.flag, "home");
    assert.deepEqual(headers(s), []);
    const retry = items(s).find((i) => i.type === "button");
    assert.equal(retry?.label, "Повторить");
    assert.equal(retry?.action, RETRY_CONTENT);
    assert.equal(t.mock.calls().filter((c) => c.path !== "/v1/user").length, 0);
  });

  it("KinoPub fails after the deadline: «loading» at 1.5 s, the error by replace, then no redraw loop", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/(items|history|watching|bookmarks)", status: 502 }] });
    const p0 = t.clock.perf();
    const first = await open(t);
    assert.ok(t.clock.perf() - p0 <= DEADLINE_MS);
    assert.deepEqual(headers(first), []);
    assert.equal(items(first).find((i) => i.type === "button")?.action, RETRY_CONTENT);
    await driveToAction(t);
    assert.deepEqual(actions(t), [REPLACE]);
    const second = await open(t);
    assert.match(JSON.stringify(second), /\{br\}Код: KP-(5XX|NET)"/);
    assert.equal(items(second).find((i) => i.type === "button")?.action, RETRY_CONTENT);
    assert.equal(second.flag, "home");
    await drive(t, () => counter(t, "refresh:unchanged") === 1, "recheck of the error screen");
    assert.deepEqual(actions(t), [REPLACE]);
    // KinoPub ожил: полки снова выводятся (часть может ждать закрытия circuit breaker).
    t.mock.setScenario({ rules: [] });
    await t.clock.advance(60_000);
    assert.ok(headers(await open(t)).length > 0);
  });
});

describe("homeScreen: L2 cache (CNFR-04, CC-11)", () => {
  it("a new app on the same storage answers from L2 within 50 ms without waiting for KinoPub", async () => {
    const first = await make();
    assert.deepEqual(headers(await open(first)), ALL);
    await persisted(first);
    first.mock.setScenario({ delayMs: 600 });
    const n = first.mock.calls().length;
    const t = await make({ mock: first.mock, storage: first.storage, loggedIn: false });
    const real0 = performance.now();
    const fake0 = t.clock.perf();
    const s = (await t.app.handleRequest(HOME, {})) as MsxContentRoot;
    const realMs = performance.now() - real0;
    assert.ok(t.clock.perf() - fake0 <= 50);
    assert.ok(realMs <= 50, `home from L2 took ${realMs.toFixed(1)} ms`);
    assert.deepEqual(headers(s), ALL);
    assert.equal(shelf(s, "Продолжить просмотр")[0]?.tag, "S1E4");
    await realSleep(20);
    assert.equal(t.mock.calls().length, n);
    console.log(`# home from L2: ${realMs.toFixed(1)} ms, ${bytes(s)} bytes`);
  });

  it("stale L2 two hours later: still at once, refresh in the background", async () => {
    const first = await make();
    await open(first);
    await persisted(first);
    const n0 = first.mock.calls().length;
    first.mock.setScenario({ delayMs: 600 });
    const clock = new FakeClock(FAKE_EPOCH + 120 * MIN);
    const t = await make({ mock: first.mock, storage: first.storage, loggedIn: false, clock });
    const real0 = performance.now();
    const s = (await t.app.handleRequest(HOME, {})) as MsxContentRoot;
    const realMs = performance.now() - real0;
    assert.ok(realMs <= 50, `stale home from L2 took ${realMs.toFixed(1)} ms`);
    assert.deepEqual(headers(s), ALL);
    await until(() => t.mock.calls().length > n0, "background refresh");
  });
});

/** В KinoPub MOVIE_SIMPLE досмотрен дальше: 3000 с из 5400 вместо 1200. */
function slower(t: TestApp): void {
  const simple = t.mock.state.history.find((h) => h.item === FIX.MOVIE_SIMPLE);
  assert.ok(simple);
  simple.time = 3000;
}

describe("homeScreen: conditional redraw (спец. §6.3, D-40)", () => {
  /** Главная открыта, затем `change` в KinoPub; через минуту персональное устарело и обновлено фоном. */
  async function staleHome(t: TestApp, change: () => void = () => undefined): Promise<void> {
    await open(t);
    assert.deepEqual(actions(t), []);
    change();
    await t.clock.advance(MIN + 1000);
    await open(t);
    await until(() => refreshed(t, cacheKeys.history()) && refreshed(t, cacheKeys.serials()), "personal refresh");
  }

  it("history changed in KinoPub → replace:content:home after the background refresh", async () => {
    const t = await make();
    await staleHome(t, () => slower(t));
    assert.deepEqual(actions(t), []);
    await t.clock.advance(RECHECK_MS);
    await until(() => actions(t).length > 0, "replace");
    assert.deepEqual(actions(t), [REPLACE]);
    assert.equal(shelf(await open(t), "Продолжить просмотр")[1]?.progress, 0.56);
  });

  it("nothing changed → no actions", async () => {
    const t = await make();
    await staleHome(t);
    await t.clock.advance(RECHECK_MS);
    await until(() => counter(t, "refresh:unchanged") === 1, "recheck");
    assert.deepEqual(actions(t), []);
  });

  it("the user moved on to item:1 → no actions", async () => {
    const t = await make();
    await staleHome(t, () => slower(t));
    t.ctx.current.onRequest(ids.item(1));
    await t.clock.advance(RECHECK_MS);
    await until(() => counter(t, "refresh:not_current") === 1, "recheck");
    assert.deepEqual(actions(t), []);
  });

  it("fresh personal data → nothing scheduled", async () => {
    const t = await make();
    await open(t);
    await open(t);
    await t.clock.advance(RECHECK_MS);
    await realSleep(50);
    assert.equal(counter(t, "refresh:unchanged") + counter(t, "refresh:replaced"), 0);
  });

  it("after playback the home under the player is redrawn with the TV overlay (trackScreen)", async () => {
    const t = await make({ clock: new FakeClock(Date.now()) });
    await open(t);
    await t.clock.advance(1000);
    t.ctx.overlay.set(FIX.MOVIE_SIMPLE, 0, 1, { time: 4000, status: 0 });
    refreshAfterPlayback(t.ctx, FIX.MOVIE_SIMPLE);
    await until(() => refreshed(t, cacheKeys.history()), "history refresh");
    await t.clock.advance(RECHECK_MS);
    await until(() => actions(t).length > 0, "replace");
    assert.deepEqual(actions(t), [REPLACE]);
    assert.equal(shelf(await open(t), "Продолжить просмотр")[1]?.progress, 0.74);
  });
});

describe("homeScreen: cold start (CNFR-05, спец. §8.4 п. 2)", () => {
  it("slow popular and hot: answer by 1.5 s with what arrived, then replace with all shelves", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/items/(popular|hot)$", delayMs: 600 }] });
    const p0 = t.clock.perf();
    const s = await open(t);
    assert.ok(t.clock.perf() - p0 <= DEADLINE_MS, `answered at ${t.clock.perf() - p0} ms`);
    assert.deepEqual(headers(s), ALL.slice(0, 4));
    await driveToAction(t);
    assert.deepEqual(actions(t), [REPLACE]);
    assert.deepEqual(headers(await open(t)), ALL);
  });

  it("everything 600 ms late: «loading» by 1.5 s, then replace with all shelves", async () => {
    const t = await make();
    t.mock.setScenario({ delayMs: 600 });
    const p0 = t.clock.perf();
    const s = await open(t);
    assert.ok(t.clock.perf() - p0 <= DEADLINE_MS);
    assert.equal(s.flag, "home");
    assert.deepEqual(headers(s), []);
    await driveToAction(t);
    assert.deepEqual(actions(t), [REPLACE]);
    assert.deepEqual(headers(await open(t)), ALL);
  });
});

describe("warmHome and the history fallback", () => {
  it("loads every shelf into L2: the next app answers home without KinoPub", async () => {
    const first = await make();
    warmHome(first.ctx);
    await persisted(first);
    const n = first.mock.calls().length;
    const t = await make({ mock: first.mock, storage: first.storage, loggedIn: false });
    assert.deepEqual(headers((await t.app.handleRequest(HOME, {})) as MsxContentRoot), ALL);
    assert.equal(first.mock.calls().length, n);
  });

  it("watching/movies is asked only when the history is empty; then «Продолжить» comes from watching", async () => {
    const t = await make();
    assert.deepEqual(headers(await t.run(homeScreen(t.ctx))), ALL);
    assert.equal(calls(t, "/v1/watching/movies"), 0);

    const empty = await make();
    empty.mock.state.history = [];
    // Лишний запрос встаёт в очередь лимитера последним: на холодном старте полка может прийти заменой экрана.
    if (!headers(await open(empty)).includes(ALL[0] ?? "")) await driveToAction(empty);
    const tiles = shelf(await open(empty), "Продолжить просмотр");
    assert.equal(calls(empty, "/v1/watching/movies"), 1);
    assert.deepEqual(tiles.map((i) => i.action), [FIX.SERIAL_BIG, FIX.SERIAL_SMALL, FIX.MOVIE_SIMPLE].map((id) => contentAction(P, ids.item(id))));
    assert.ok(tiles.every((i) => i.progress === undefined && i.tag === undefined));
    assert.equal(tiles[0]?.badge, "+2");
  });
});
