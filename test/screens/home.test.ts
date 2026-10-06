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
import { TILE_STYLE } from "../../src/screens/tiles.ts";
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
  items(s).filter((i) => i.type === "space" && i.layout === "0,0,12,1").map((i) => i.headline ?? "");
const actions = (t: TestApp): string[] => t.host.actions.map((a) => a.action);
const counter = (t: TestApp, name: string): number => t.ctx.metrics.summary().counters[name] ?? 0;
const calls = (t: TestApp, path: string): number => t.mock.calls().filter((c) => c.path === path).length;

/** Плитки полки: заголовок `0,0,12,1` и плитки `x,1,2,4` той же страницы (стражи — в рядах 0 и 5). */
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

/**
 * Таймеры FakeClock идут до первого действия плагина: проверка стоит ровно на нём, время дальше не убегает. `graceMs` —
 * сколько реального времени ждать запросы в полёте перед каждым таймером; при висящих запросах (этап 33b) — меньше.
 */
function driveToAction(t: TestApp, graceMs = 2000): Promise<void> {
  t.clock.ioGraceMs = graceMs;
  return t.run(new Promise<void>((resolve) => {
    const exec = t.host.executeAction.bind(t.host);
    t.host.executeAction = (action: string, data?: unknown): void => {
      exec(action, data);
      resolve();
    };
  }));
}

/**
 * V-07: «Загружаю главную…» — сам фокусируемый элемент без действия (`[]`); «Обновить» — только после срока ответа,
 * когда пришла ошибка или пустая главная.
 */
function assertLoading(s: MsxContentRoot): void {
  const all = items(s);
  assert.deepEqual(all.map((i) => [i.type ?? "default", i.headline, i.action]), [["default", "{ico:hourglass-empty} Загружаю главную…", "[]"]]);
  assert.ok(all.every((i) => i.action !== RETRY_CONTENT));
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
  it("12×6 list of large tiles, flag home, not cached by MSX, a shelf per page in the Plan B order, next page preloaded", async () => {
    const t = await make();
    const s = await open(t);
    assert.equal(s.type, "list");
    assert.equal(s.compress, undefined);
    assert.equal(s.preload, "next");
    assert.equal(s.flag, "home");
    assert.equal(s.cache, false);
    assert.equal(s.reuse, false);
    assert.equal(s.headline, "Главная");
    assert.equal(s.extension, undefined, "«нет связи» only when KinoPub did not answer");
    assert.deepEqual(headers(s), ALL);
    assert.equal(s.pages?.length, 8);
    s.pages?.forEach((p, i) => {
      assert.deepEqual(p.items.filter((it) => it.type === "space").map((it) => [it.layout, it.offset]), [["0,0,12,1", "0,0,0,-0.5"]]);
      // Полка поднята на полряда: страница ниже на полряда, у последней — ещё и ряд стражей.
      assert.equal(p.offset, i === 7 ? "0,0,0,-1.5" : "0,0,0,-0.5");
    });
  });

  it("guards over the first shelf and under the last one bring the focus back: no wrap-around at the edges", async () => {
    const t = await make();
    const s = await open(t);
    const guards = (i: number): MsxContentItem[] => (s.pages?.[i]?.items ?? []).filter((it) => /^focus:/.test(String(it.selection?.action)));
    const first = shelf(s, "Продолжить просмотр");
    assert.deepEqual(guards(0).map((g) => [g.layout, g.offset, g.selection?.action]), first.map((tile, k) => [`${2 * k},0,2,1`, "0,0.5,0,3", `focus:${tile.id}`]));
    const last = shelf(s, "Горячее: сериалы");
    assert.deepEqual(guards(7).map((g) => [g.layout, g.offset, g.selection?.action]), last.map((tile, k) => [`${2 * k},5,2,1`, "0,-4.5,0,3", `focus:${tile.id}`]));
    for (let i = 1; i < 7; i++) assert.deepEqual(guards(i), []);
    assert.ok([...guards(0), ...guards(7)].every((g) => g.color === "transparent" && g.action === undefined && g.id === undefined));
  });

  it("catalog shelf: 5 posters x = 0…8 with the full name and numeric pf in selection, «Показать все» at 10 to the full list", async () => {
    const t = await make();
    const s = await open(t);
    const tiles = shelf(s, "Новые фильмы");
    assert.deepEqual(tiles.map((i) => [i.layout, i.offset]), [0, 2, 4, 6, 8, 10].map((x) => [`${x},1,2,4`, "0,-0.5,0,0"]));
    const more = tiles.pop();
    assert.deepEqual([more?.icon, more?.titleHeader, more?.titleFooter], ["arrow-forward", "{col:msx-white}Показать все{br} ", "Новые фильмы"]);
    assert.equal(more?.action, contentAction(P, ids.list(encodeListKey({ src: "fresh", type: "movie" }))));
    for (const tile of tiles) {
      const id = Number(/^content:request:interaction:item:(\d+)@/.exec(tile.action ?? "")?.[1]);
      assert.ok(id > 0, `tile action ${tile.action}`);
      assert.equal(tile.selection?.action, commitMsg(msgs.pf(id)));
      assert.match(String(tile.selection?.headline), /^Тестовый /);
      assert.ok(tile.image !== undefined && tile.titleHeader !== undefined);
      // Шаблон корня MSX к `pages` не применяет — вид крупной плитки в самой плитке, как у сетки каталога.
      for (const [k, v] of Object.entries(TILE_STYLE)) assert.deepEqual(tile[k], v, k);
      assert.match(tile.titleFooter ?? "", /^\d{4} · \d,\d$/);
    }
    assert.equal(tiles[0]?.titleHeader, "{col:msx-white}Тестовый{br}фильм 1000");
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
    assert.deepEqual(tiles.map((i) => i.layout), ["0,1,2,4", "2,1,2,4", "4,1,2,4"]);
    const [big, movie] = tiles;
    assert.equal(big?.action, contentAction(P, ids.item(FIX.SERIAL_BIG)));
    assert.deepEqual(big?.selection, { headline: "Тестовый сериал «Большой»", action: commitMsg(msgs.pf(FIX.SERIAL_BIG)) });
    assert.equal(big?.tag, "1×4");
    assert.equal(big?.badge, "+2");
    assert.equal(big?.progressColor, "msx-blue");
    // Тег, бейдж и прогресс — на постере (`imageBoundary`), под ним название и год с рейтингом.
    assert.deepEqual([big?.imageBoundary, big?.titleHeader], [true, "{col:msx-white}Тестовый{br}сериал «Большой»"]);
    assert.match(big?.titleFooter ?? "", /^\d{4} · \d,\d$/);
    assert.equal(movie?.action, contentAction(P, ids.item(FIX.MOVIE_SIMPLE)));
    // V-05: короткий остаток, который MSX не режет до «ОСТАЛО…».
    assert.equal(movie?.stamp, "1 ч 10 м");
    assert.equal(movie?.progress, 0.22);
  });

  it("«Продолжить»: a serial episode marked on this TV after the history entry gives the tag (Р-21)", async () => {
    const t = await make({ clock: new FakeClock(Date.now()) });
    const big = (s: MsxContentRoot): MsxContentItem | undefined => shelf(s, "Продолжить просмотр").find((i) => i.id === `c${FIX.SERIAL_BIG}`);
    const before = big(await open(t));
    assert.equal(before?.tag, "1×4");
    t.ctx.overlay.set(FIX.SERIAL_BIG, 1, 5, { time: 0, status: 1 });
    // Прогресс — 4 из 200 серий вместо 3: после округления до сотых те же 0,02, его проверяет continue.test.ts.
    const after = big(await open(t));
    assert.deepEqual([after?.tag, after?.badge], ["1×5", "+2"]);
  });

  it("«Продолжить» holds a row of 6 titles, x = 0…10", async () => {
    const t = await make();
    const now = Math.floor(Date.now() / 1000);
    const films = catalog().filter((it) => it.type === "movie" && it.videos?.[0] !== undefined && it.deleted !== true).slice(0, 10);
    films.forEach((it, i) => t.mock.state.history.push({ item: it.id, season: 0, video: 1, time: 60, lastSeen: now - 86_400 - i }));
    const tiles = shelf(await open(t), "Продолжить просмотр");
    assert.deepEqual(tiles.map((i) => i.layout), [0, 2, 4, 6, 8, 10].map((x) => `${x},1,2,4`));
    assert.ok(tiles.every((i) => i.icon === undefined));
  });

  it("«Закладки»: a folder tile of the same size, a large icon in place of the poster (V-30), no «Показать все» for up to 6 folders (V-06)", async () => {
    const t = await make();
    const tiles = shelf(await open(t), "Закладки");
    assert.equal(tiles.length, 1);
    const [fav] = tiles;
    assert.deepEqual([fav?.icon, fav?.iconSize, fav?.titleHeader, fav?.titleFooter], ["bookmark", "large", "{col:msx-white}Избранное{br} ", "2 шт."]);
    assert.equal(fav?.action, contentAction(P, ids.list(encodeListKey({ src: "folder", folder: 1 }))));
  });

  it("«Закладки»: 6 folders fit without «Показать все»; the 7th brings it to the bookmarks screen in place of the 6th", async () => {
    const t = await make();
    for (let id = 2; id <= 6; id++) t.mock.state.folders.set(id, { title: `Смотреть с детьми ${id}`, items: [], created: id });
    const six = shelf(await open(t), "Закладки");
    assert.equal(six.length, 6);
    assert.ok(six.every((i) => i.icon === "bookmark"));
    assert.equal(six[1]?.titleHeader, "{col:msx-white}Смотреть с{br}детьми 2");
    t.mock.state.folders.set(7, { title: "Седьмая", items: [], created: 7 });
    t.ctx.cache.markStale(cacheKeys.bookmarks());
    await open(t);
    await driveToAction(t);
    const seven = shelf(await open(t), "Закладки");
    assert.equal(seven.length, 6);
    assert.deepEqual([seven[5]?.icon, seven[5]?.layout, seven[5]?.action], ["arrow-forward", "10,1,2,4", contentAction(P, ids.bookmarks())]);
  });

  it("focus prefetch off — tiles only name themselves in the headline, no pf messages", async () => {
    const t = await make({ flags: { focusPrefetch: "off" } });
    assert.ok(items(await open(t)).every((i) => !String(i.selection?.action ?? "").startsWith("interaction:commit:message:pf:")));
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
  it("all shelves empty → text and «Обновить», still flag home (V-07)", async () => {
    const t = await make();
    const empty = { ttlMs: 3_600_000, staleMaxMs: 0, persist: false };
    const keys = [cacheKeys.history(), cacheKeys.serials(), cacheKeys.movies(), cacheKeys.bookmarks()];
    for (const kind of ["fresh", "popular", "hot"]) for (const type of ["movie", "serial"]) keys.push(cacheKeys.shelf(kind, type));
    for (const k of keys) await t.run(t.ctx.cache.get(k, empty, async () => []));
    const s = await open(t);
    assert.equal(s.flag, "home");
    assert.deepEqual(headers(s), []);
    const retry = items(s).find((i) => i.type === "button");
    assert.equal(retry?.label, "Обновить");
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
    assertLoading(first);
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
    assert.equal(shelf(s, "Продолжить просмотр")[0]?.tag, "1×4");
    await realSleep(20);
    assert.equal(t.mock.calls().length, n);
    console.log(`# home from L2: ${realMs.toFixed(1)} ms, ${bytes(s)} bytes`);
  });

  it("L2 has 3 of 8 shelves, KinoPub 600 ms late: those 3 at once, the rest by a single replace (спец. §8.4 п. 1)", async () => {
    const first = await make();
    await open(first);
    await persisted(first);
    // В L2 остаются «Продолжить просмотр» (история, сериалы), «Новые фильмы» и «Новые сериалы».
    const gone = [cacheKeys.bookmarks(), ...["popular", "hot"].flatMap((kind) => ["movie", "serial"].map((type) => cacheKeys.shelf(kind, type)))];
    for (const k of gone) first.ctx.l2.remove(k);
    first.mock.setScenario({ delayMs: 600 });
    const t = await make({ mock: first.mock, storage: first.storage, loggedIn: false });
    const real0 = performance.now();
    const fake0 = t.clock.perf();
    const s = (await t.app.handleRequest(HOME, {})) as MsxContentRoot;
    const realMs = performance.now() - real0;
    assert.equal(t.clock.perf(), fake0, "answered without waiting for KinoPub");
    assert.ok(realMs <= 50, `partial home from L2 took ${realMs.toFixed(1)} ms`);
    assert.deepEqual(headers(s), ALL.slice(0, 3));
    await driveToAction(t);
    assert.deepEqual(actions(t), [REPLACE]);
    assert.deepEqual(headers(await open(t)), ALL);
    await t.clock.advance(RECHECK_MS);
    await realSleep(50);
    assert.deepEqual(actions(t), [REPLACE]);
    assert.equal(counter(t, "refresh:replaced"), 1);
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

const ENDED = "{ico:msx-yellow:warning} Подписка KinoPub неактивна (до 15.03.2026)";

/** Mock всегда отдаёт активную подписку: `active: false` подменяет её в ответе `/v1/user` на истёкшую. */
function subscription(t: TestApp): { active: boolean } {
  const sub = { active: true };
  const user = t.ctx.api.user.bind(t.ctx.api);
  const ended = { active: false, endTime: Date.UTC(2026, 2, 15, 12) / 1000, days: 0 };
  t.ctx.api.user = async (cls) => {
    const u = await user(cls);
    return sub.active ? u : { ...u, subscription: ended };
  };
  return sub;
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

  it("subscription expired, then renewed in KinoPub → replace:content:home with the new headline each time", async () => {
    const t = await make();
    const sub = subscription(t);
    assert.equal((await open(t)).headline, "Главная");
    await persisted(t);
    for (const [active, headline] of [[false, ENDED], [true, "Главная"]] as const) {
      sub.active = active;
      // Устарел только `user`: полки свежие, их вклад в хеш прежний.
      t.ctx.cache.markStale(cacheKeys.user());
      const n = actions(t).length;
      assert.notEqual((await open(t)).headline, headline, "the cached subscription is shown first");
      await driveToAction(t);
      assert.deepEqual(actions(t).slice(n), [REPLACE]);
      assert.equal((await open(t)).headline, headline);
    }
  });

  it("first launch: the subscription line arrives after the shelves → replace:content:home with the warning", async () => {
    const t = await make();
    subscription(t).active = false;
    t.mock.setScenario({ rules: [{ path: "^/v1/user$", delayMs: 600 }] });
    const s = await open(t);
    assert.deepEqual([s.headline, headers(s)], ["Главная", ALL]);
    await driveToAction(t);
    assert.deepEqual(actions(t), [REPLACE]);
    assert.equal((await open(t)).headline, ENDED);
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

// Этап 33b: API заблокирован по SNI или упал VPN — ни один запрос не отвечает ничем. Раньше ошибка приходила заменой
// через 27 с: таймауты 8 с волнами по 3 запроса, повторы 3 и 6 с, затем circuit breaker.
describe("homeScreen: KinoPub hangs (stage 33b)", () => {
  const NO_ANSWER_MS = 6000;
  const HANG = { rules: [{ path: "^/v1/", hang: true }] };

  it("no cache: «loading» at 1.5 s, the KP-NET error by replace at 6 s; opened again — the error at once", async () => {
    const t = await make();
    t.mock.setScenario(HANG);
    // Всё висит: ждать ответы в реальном времени перед каждым поддельным таймером незачем.
    t.clock.ioGraceMs = 20;
    const p0 = t.clock.perf();
    const first = await open(t);
    assert.equal(t.clock.perf() - p0, DEADLINE_MS);
    assertLoading(first);
    await driveToAction(t, 20);
    assert.deepEqual(actions(t), [REPLACE]);
    assert.equal(t.clock.perf() - p0, NO_ANSWER_MS);
    const second = await open(t);
    assert.match(JSON.stringify(second), /Нет связи с KinoPub\. Проверьте VPN\{br\}Код: KP-NET"/);
  });

  it("L2 from two hours ago: all shelves at once; the failed background refresh leaves them on the screen", async () => {
    const first = await make();
    await open(first);
    await persisted(first);
    first.mock.setScenario(HANG);
    const t = await make({ mock: first.mock, storage: first.storage, loggedIn: false, clock: new FakeClock(FAKE_EPOCH + 120 * MIN) });
    const fake0 = t.clock.perf();
    const s = (await t.app.handleRequest(HOME, {})) as MsxContentRoot;
    assert.equal(t.clock.perf(), fake0, "answered from L2 without waiting for KinoPub");
    assert.deepEqual(headers(s), ALL);
    t.clock.ioGraceMs = 250;
    await t.run(until(() => counter(t, "refresh:unchanged") === 1, "the D-40 recheck"));
    await t.clock.advance(NO_ANSWER_MS);
    assert.ok(t.ctx.log.entries().some((e) => e.tag === "api" && / no-answer 6000ms /.test(e.msg)), "the refresh went out and got the verdict");
    await t.clock.advance(60_000);
    await realSleep(20);
    assert.deepEqual(actions(t), [], "nothing to redraw: the shelves from L2 stay");
  });

  /**
   * MSX на `replace:content:home` снова запрашивает главную. Поддельное время идёт шагами по 250 мс, между ними —
   * реальная пауза: сбои соединения (`drop`) приходят по реальному вводу-выводу.
   */
  async function msxFor(t: TestApp, ms: number): Promise<MsxContentRoot[]> {
    const shown: MsxContentRoot[] = [];
    const exec = t.host.executeAction.bind(t.host);
    t.host.executeAction = (action: string, data?: unknown): void => {
      exec(action, data);
      if (action === REPLACE) void t.app.handleRequest(HOME, {}).then((s) => shown.push(s as MsxContentRoot));
    };
    const p0 = t.clock.perf();
    while (t.clock.perf() - p0 < ms) {
      await t.clock.advance(250);
      await realSleep(3);
    }
    return shown;
  }

  for (const [name, rules] of [["hangs", HANG.rules], ["drops the connection", [{ path: "^/v1/", drop: true }]]] as const) {
    it(`X-1: L2 older than a week, KinoPub ${name} → all shelves at once with «нет связи», ≤ 1 replace in 60 s`, async () => {
      const first = await make();
      await open(first);
      await persisted(first);
      first.mock.setScenario({ rules: [...rules] });
      const t = await make({ mock: first.mock, storage: first.storage, loggedIn: false, clock: new FakeClock(FAKE_EPOCH + 8 * 24 * 60 * MIN) });
      t.clock.ioGraceMs = 20;
      const fake0 = t.clock.perf();
      const s = (await t.run(t.app.handleRequest(HOME, {}))) as MsxContentRoot;
      assert.ok(t.clock.perf() - fake0 <= DEADLINE_MS, "answered by the deadline");
      assert.deepEqual(headers(s), ALL, "what L2 has is shown by the deadline, not «loading»");
      const shown = [s, ...(await msxFor(t, 60_000))];
      assert.ok(actions(t).filter((a) => a === REPLACE).length <= 1, actions(t).join("\n"));
      const last = shown.at(-1);
      assert.ok(last !== undefined);
      assert.deepEqual(headers(last), ALL);
      assert.match(last.extension ?? "", /нет связи/);
      // KinoPub ожил: следующая сверка заменяет главную свежими полками без пометки.
      first.mock.setScenario({ rules: [] });
      first.mock.release();
      t.host.clearActions();
      await t.run(t.app.handleRequest(HOME, {}));
      await driveToAction(t);
      assert.deepEqual(actions(t), [REPLACE]);
      const back = (await t.run(t.app.handleRequest(HOME, {}))) as MsxContentRoot;
      assert.deepEqual([headers(back), back.extension], [ALL, undefined]);
    });
  }
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

describe("homeScreen: request class (спец. §8.3, §8.5)", () => {
  /** Класс запросов к API по журналу транспорта: `GET /v1/… 200 12ms bg`. */
  const classes = (t: TestApp): string[] =>
    t.ctx.log.entries().filter((e) => e.tag === "api" && e.msg.startsWith("GET /v1/")).map((e) => e.msg.slice(e.msg.lastIndexOf(" ") + 1));

  it("the home the user waits for goes fg; its background recheck goes bg", async () => {
    const t = await make();
    await open(t);
    await persisted(t);
    const shown = classes(t);
    assert.ok(shown.length >= HOME_KEYS.length, shown.join());
    assert.deepEqual([...new Set(shown)], ["fg"]);
    refreshAfterPlayback(t.ctx, FIX.MOVIE_SIMPLE);
    await until(() => refreshed(t, cacheKeys.history()) && refreshed(t, cacheKeys.serials()), "recheck loads");
    assert.deepEqual([...new Set(classes(t).slice(shown.length))], ["bg"]);
  });

  it("from a stale L2 the catalog shelves refresh bg, «Продолжить» and «Закладки» fg (спец. §8.4 п. 1)", async () => {
    const first = await make();
    await open(first);
    await persisted(first);
    const t = await make({ mock: first.mock, storage: first.storage, loggedIn: false, clock: new FakeClock(FAKE_EPOCH + 120 * MIN) });
    await open(t);
    await drive(t, () => classes(t).length >= HOME_KEYS.length, "refresh of every home key");
    const of = (re: RegExp): string[] => [...new Set(t.ctx.log.entries()
      .filter((e) => e.tag === "api" && re.test(e.msg)).map((e) => e.msg.slice(e.msg.lastIndexOf(" ") + 1)))];
    assert.deepEqual(of(/^GET \/v1\/items\/(fresh|popular|hot) /), ["bg"]);
    assert.deepEqual(of(/^GET \/v1\/(history|watching\/serials|bookmarks) /), ["fg"]);
  });

  it("warmHome goes bg", async () => {
    const t = await make();
    warmHome(t.ctx);
    await persisted(t);
    assert.ok(classes(t).length >= HOME_KEYS.length);
    assert.deepEqual([...new Set(classes(t))], ["bg"]);
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
