import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as realSleep } from "node:timers/promises";
import type { User } from "../../src/api/models.ts";
import { cacheKeys } from "../../src/cache/repo.ts";
import { RETRY_CONTENT } from "../../src/screens/error.ts";
import { chain, commitMsg, contentAction, panelAction, replaceContent } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { encodeListKey, ids, msgs } from "../../src/router/ids.ts";
import { forgetHome, homeScreen, warmHome } from "../../src/screens/home.ts";
import { onOrderAct } from "../../src/screens/order-edit.ts";
import { TILE_STYLE } from "../../src/screens/tiles.ts";
import { MAX_BYTES, bytes } from "../../src/screens/list.ts";
import { refreshAfterPlayback } from "../../src/screens/refresh.ts";
import { FIX, catalog, findItem } from "../../tools/kpmock/fixtures.ts";
import { watchKey } from "../../tools/kpmock/state.ts";
import { FAKE_EPOCH, FakeClock } from "../helpers/fake-clock.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";
import { assertRealMs } from "../helpers/perf.ts";

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

/** Ни один запрос к mock начиная с `from`-го ещё не получил ответа: экран ответил, не дожидаясь KinoPub. */
function unanswered(t: TestApp, from: number): boolean {
  return t.mock.calls().slice(from).every((c) => c.status === 0);
}

/** Фоновая работа идёт в реальном времени; поддельные часы при этом стоят. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await realSleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** То же, но таймеры FakeClock (лимитер, повторы, ожидание 3 с) идут; запросы в полёте, и задержанные на 600 мс, дожидаются. */
function drive(t: TestApp, cond: () => boolean, what: string): Promise<void> {
  t.clock.ioGraceMs = 2000;
  return t.run(until(cond, what));
}

/**
 * Таймеры FakeClock идут до первого действия плагина: проверка стоит ровно на нём, время дальше не убегает. `graceMs` —
 * порог `ioGraceMs`: ответ, задержанный mock не дольше него, FakeClock дожидается; при задержке длиннее — нет.
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
    const [big, movie, small] = tiles;
    assert.equal(big?.action, contentAction(P, ids.item(FIX.SERIAL_BIG)));
    assert.deepEqual(big?.selection, { headline: "Тестовый сериал «Большой»", action: commitMsg(msgs.pf(FIX.SERIAL_BIG)) });
    assert.equal(big?.tag, "1×4");
    // QA-API-2: «+N» — только при остатке 1–5: у «Большого» осталось 197 серий из 200, у «Короткого» — 5 из 6.
    assert.equal(big?.badge, undefined);
    assert.equal(small?.badge, "+5");
    assert.equal(big?.progressColor, "msx-blue");
    // Тег, бейдж и прогресс — на постере (`imageBoundary`), под ним название и год с рейтингом.
    assert.deepEqual([big?.imageBoundary, big?.titleHeader], [true, "{col:msx-white}Тестовый{br}сериал «Большой»"]);
    assert.match(big?.titleFooter ?? "", /^\d{4} · \d,\d$/);
    assert.equal(movie?.action, contentAction(P, ids.item(FIX.MOVIE_SIMPLE)));
    // V-05: короткий остаток, который MSX не режет до «ОСТАЛО…».
    assert.equal(movie?.stamp, "1 ч 10 м");
    assert.equal(movie?.progress, 0.22);
  });

  it("«Продолжить»: a serial episode marked on this TV after the history was loaded gives the tag (Р-21)", async () => {
    // Часы ТВ (FakeClock, 2026-01-01) отстают от KinoPub (mock, сейчас): сравнение — с загрузкой истории, по часам ТВ.
    const t = await make();
    const big = (s: MsxContentRoot): MsxContentItem | undefined => shelf(s, "Продолжить просмотр").find((i) => i.id === `c${FIX.SERIAL_BIG}`);
    const before = big(await open(t));
    assert.equal(before?.tag, "1×4");
    await t.clock.advance(1000);
    t.ctx.overlay.set(FIX.SERIAL_BIG, 1, 5, { time: 0, status: 1 });
    // Прогресс — 4 из 200 серий вместо 3: после округления до сотых те же 0,02, его проверяет continue.test.ts.
    const after = big(await open(t));
    assert.deepEqual([after?.tag, after?.badge], ["1×5", undefined]);
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
    assertRealMs(realMs, 50, "home from L2");
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
    const n = first.mock.calls().length;
    const t = await make({ mock: first.mock, storage: first.storage, loggedIn: false });
    const real0 = performance.now();
    const fake0 = t.clock.perf();
    const s = (await t.app.handleRequest(HOME, {})) as MsxContentRoot;
    const realMs = performance.now() - real0;
    assert.equal(t.clock.perf(), fake0, "answered without waiting for KinoPub");
    assert.ok(unanswered(t, n), "answered before KinoPub");
    assertRealMs(realMs, 50, "partial home from L2");
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
    assert.ok(unanswered(t, n0), "answered before KinoPub");
    assertRealMs(realMs, 50, "stale home from L2");
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

  it("«Секции главной» changed while the home is shown → the background recheck replaces it (the hash covers the shelves)", async () => {
    const t = await make();
    await staleHome(t);
    t.ctx.store.set("cfg", "home", { hidden: ["b"] });
    await t.clock.advance(RECHECK_MS);
    await until(() => actions(t).length > 0, "replace");
    assert.deepEqual(actions(t), [REPLACE]);
    assert.deepEqual(headers(await open(t)), ALL.filter((h) => h !== "Закладки"));
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

  it("after playback the home under the player is redrawn with the new position (trackScreen)", async () => {
    const t = await make({ clock: new FakeClock(Date.now()) });
    await open(t);
    await t.clock.advance(1000);
    t.ctx.overlay.set(FIX.MOVIE_SIMPLE, 0, 1, { time: 4000, status: 0 });
    // Трекер сверяет экраны после того, как `marktime` дошёл до KinoPub: история, загруженная после записи оверлея, —
    // уже с этой позицией (оверлей главнее только загруженной раньше истории).
    const h = t.mock.state.history.find((x) => x.item === FIX.MOVIE_SIMPLE);
    assert.ok(h);
    Object.assign(h, { time: 4000, lastSeen: Math.floor(Date.now() / 1000) });
    refreshAfterPlayback(t.ctx, FIX.MOVIE_SIMPLE);
    await until(() => refreshed(t, cacheKeys.history()), "history refresh");
    await t.clock.advance(RECHECK_MS);
    await until(() => actions(t).length > 0, "replace");
    assert.deepEqual(actions(t), [REPLACE]);
    assert.equal(shelf(await open(t), "Продолжить просмотр").find((i) => i.id === `c${FIX.MOVIE_SIMPLE}`)?.progress, 0.74);
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
    // Всё висит: ответы не ждать, поддельные таймеры идут сразу.
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

describe("homeScreen: «Секции главной» (kp.cfg.home; спец. §11 S4, S12)", () => {
  const asked = (t: TestApp, re: RegExp): string[] => t.mock.calls().map((c) => c.path).filter((p) => re.test(p));
  const SHELF_API = /^\/v1\/(items\/(fresh|popular|hot)|history|bookmarks|watching\/)/;

  it("the stored order: «Закладки» moved first, the rest in the default order", async () => {
    const t = await make();
    t.ctx.store.set("cfg", "home", { order: ["b", "c", "fm", "fs", "pm", "ps", "hm", "hs"] });
    const s = await open(t);
    assert.deepEqual(headers(s), ["Закладки", ...ALL.filter((h) => h !== "Закладки")]);
    // Стражи края — у новой первой полки.
    assert.ok(s.pages?.[0]?.items.some((i) => i.selection?.action === "focus:b1"));
  });

  it("hidden shelves are neither shown nor asked from KinoPub: no history and watching without «Продолжить», no popular and hot", async () => {
    const t = await make();
    // `v: 2` — настройка этой версии (выбор пользователя); без неё «Продолжить» вернула бы миграция (фикс 2026-10-22).
    t.ctx.store.set("cfg", "home", { hidden: ["c", "pm", "ps", "hm", "hs"], v: 2 });
    const s = await t.run(homeScreen(t.ctx));
    assert.deepEqual(headers(s), ["Новые фильмы", "Новые сериалы", "Закладки"]);
    assert.deepEqual(asked(t, /^\/v1\/(history|watching\/|items\/(popular|hot))/), []);
    assert.deepEqual([...new Set(asked(t, SHELF_API))].sort(), ["/v1/bookmarks", "/v1/items/fresh"]);
  });

  it("warmHome warms only the shown shelves", async () => {
    const t = await make();
    t.ctx.store.set("cfg", "home", { hidden: ["fm", "fs", "b", "pm", "ps"] });
    warmHome(t.ctx);
    await drive(t, () => ["movie", "serial"].every((type) => t.ctx.cache.peek(cacheKeys.shelf("hot", type)) !== undefined), "hot shelves");
    assert.deepEqual(asked(t, /^\/v1\/(bookmarks|items\/(fresh|popular))/), []);
    assert.ok(asked(t, /^\/v1\/history$/).length > 0, "«Продолжить» is shown");
  });

  it("every shelf hidden: no shelf asked, a hint and the «Секции главной» button instead of «Пусто»", async () => {
    const t = await make();
    t.ctx.store.set("cfg", "home", { hidden: ["c", "fm", "fs", "b", "pm", "ps", "hm", "hs"], v: 2 });
    const s = await t.run(homeScreen(t.ctx));
    assert.deepEqual(asked(t, SHELF_API), []);
    const all = items(s);
    assert.deepEqual(all.map((i) => [i.type, i.text ?? i.label]), [["space", "Все секции главной скрыты"], ["button", "Секции главной"]]);
    assert.equal(all[1]?.action, panelAction(P, ids.panel("home")));
  });

  it("red button over the home: «Секции главной» closes the options and opens panel:home", async () => {
    const t = await make();
    const s = await open(t);
    assert.deepEqual(s.options?.items?.map((i) => [i.label, i.action]), [["Секции главной", chain(["back", panelAction(P, ids.panel("home"))])]]);
  });
});

describe("homeScreen: «Продолжить просмотр» is not lost silently (отзыв с ТВ 2026-10-22)", () => {
  const C = "Продолжить просмотр";
  const RETRY_ID = "c_retry";
  /** История пуста или не ответила — `watching/movies` встаёт в очередь лимитера последним: полка может прийти заменой. */
  async function withFilms(t: TestApp): Promise<MsxContentRoot> {
    if (!headers(await open(t)).includes(C)) await driveToAction(t);
    return open(t);
  }
  const ALL3 = "^/v1/(history|watching/(serials|movies))$";

  it("no kp.cfg.home: «Продолжить просмотр» is the first shelf", async () => {
    const t = await make();
    assert.equal(headers(await open(t))[0], C);
    assert.equal(t.ctx.store.get("cfg", "home"), undefined);
  });

  it("kp.cfg.home of v1.13–v1.20 with «Продолжить» hidden (red button → OK → OK): shown again in its place, the rest kept, v: 2", async () => {
    const t = await make();
    t.ctx.store.set("cfg", "home", { order: ["b", "c", "fm", "fs", "pm", "ps", "hm", "hs"], hidden: ["c", "hs"] });
    const s = await open(t);
    assert.deepEqual(headers(s), ["Закладки", C, ...ALL.slice(1).filter((h) => h !== "Закладки" && h !== "Горячее: сериалы")]);
    assert.deepEqual(t.ctx.store.get("cfg", "home"), { order: ["b", "c", "fm", "fs", "pm", "ps", "hm", "hs"], hidden: ["hs"], v: 2 });
    // Скрыть снова — уже выбор: настройка с `v` больше не мигрирует, полка не показывается и не запрашивается.
    onOrderAct(t.ctx, "home", "hide", ["c"]);
    const n = calls(t, "/v1/history");
    assert.ok(!headers(await open(t)).includes(C));
    assert.equal(calls(t, "/v1/history"), n);
  });

  it("history and both watching lists fail without a cache: the shelf stays first with «Не удалось загрузить», OK reloads the home", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: ALL3, status: 400 }] });
    const s = await open(t);
    assert.deepEqual(headers(s), ALL);
    const tiles = shelf(s, C);
    assert.deepEqual(tiles.map((i) => [i.id, i.action]), [[RETRY_ID, RETRY_CONTENT]]);
    assert.match(String(tiles[0]?.titleHeader), /Не удалось.*загрузить/);
    assert.equal(tiles[0]?.titleFooter, "Повторить");
    // Ошибка сама сверку не заказывает (повторы уже сделал транспорт); KinoPub ожил — OK на плитке (`reload:content`).
    await t.clock.advance(RECHECK_MS);
    await realSleep(20);
    assert.deepEqual(actions(t), []);
    t.mock.setScenario({ rules: [] });
    const again = shelf(await open(t), C);
    assert.deepEqual(again.map((i) => i.id), [`c${FIX.SERIAL_BIG}`, `c${FIX.MOVIE_SIMPLE}`, `c${FIX.SERIAL_SMALL}`]);
  });

  it("only watching/serials fails: serials of the history stay — the tag without progress; the film with its progress", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/watching/serials$", status: 400 }] });
    const tiles = shelf(await open(t), C);
    assert.deepEqual(tiles.map((i) => [i.id, i.tag, i.progress === undefined]), [
      [`c${FIX.SERIAL_BIG}`, "1×4", true], [`c${FIX.MOVIE_SIMPLE}`, undefined, false], [`c${FIX.SERIAL_SMALL}`, "1×1", true],
    ]);
  });

  it("only the history fails and the watching lists have nothing: an error, not an empty shelf", async () => {
    const t = await make();
    t.mock.state.watching.clear();
    t.mock.setScenario({ rules: [{ path: "^/v1/history$", status: 400 }] });
    assert.deepEqual(shelf(await withFilms(t), C).map((i) => i.id), [RETRY_ID]);
  });

  it("only the history fails: «Продолжить» from the watching lists (serials by fewer episodes left, then films)", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/history$", status: 400 }] });
    assert.deepEqual(shelf(await withFilms(t), C).map((i) => i.id), [`c${FIX.SERIAL_SMALL}`, `c${FIX.SERIAL_BIG}`, `c${FIX.MOVIE_SIMPLE}`]);
  });

  it("a slow failure after the deadline: first without the shelf, then the error by replace; opened again — the error at once, no redraw loop", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: ALL3, status: 400, delayMs: 600 }] });
    const first = await open(t);
    assert.deepEqual(headers(first), ALL.slice(1), "«Продолжить» is still loading");
    await driveToAction(t);
    assert.deepEqual(actions(t), [REPLACE]);
    // Новая загрузка снова дольше срока: на экране — прошлая ошибка полки, а не показ без неё.
    t.clock.ioGraceMs = 250;
    const second = await open(t);
    assert.deepEqual(headers(second), ALL);
    assert.deepEqual(shelf(second, C).map((i) => i.id), [RETRY_ID]);
    await drive(t, () => counter(t, "refresh:unchanged") >= 1, "recheck of the error shelf");
    assert.deepEqual(actions(t), [REPLACE], "the same error is not redrawn again");
  });

  it("a failing catalog shelf shows its error tile too (its own id), the other shelves as usual", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/items/fresh$", status: 400 }] });
    const s = await open(t);
    assert.deepEqual(headers(s), ALL);
    assert.deepEqual(shelf(s, "Новые фильмы").map((i) => [i.id, i.action]), [["fm_retry", RETRY_CONTENT]]);
  });
});

// QA-SET-8: после выхода главная следующего аккаунта не показывает полки прежнего. Кэш при выходе чистит пакет D
// (здесь — `cache.delete`), память сборок полок — `forgetHome` (вызов при выходе — в `create-app.ts`, пакет F).
describe("forgetHome (QA-SET-8, logout)", () => {
  const forgetCache = (t: TestApp): void => {
    for (const k of [...HOME_KEYS, cacheKeys.movies()]) t.ctx.cache.delete(k);
  };

  it("forgets the last shelf builds: without a cache and with KinoPub slow — «loading», not the previous account's shelves", async () => {
    const t = await make();
    assert.deepEqual(headers(await open(t)), ALL);
    forgetCache(t);
    forgetHome(t.ctx);
    t.mock.setScenario({ delayMs: 600 });
    const s = await open(t);
    assertLoading(s);
    assert.ok(!JSON.stringify(s).includes(`c${FIX.SERIAL_BIG}`));
  });

  it("forgets the failure of the last build: the next home waits for its own data instead of the previous error", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/(items|history|watching|bookmarks)", status: 400 }] });
    assert.match(JSON.stringify(await open(t)), /Код: KP-/);
    forgetCache(t);
    forgetHome(t.ctx);
    t.mock.setScenario({ rules: [], delayMs: 600 });
    assertLoading(await open(t));
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

  it("watching/movies on the cold home only when the history is empty; then «Продолжить» comes from watching", async () => {
    const t = await make();
    assert.deepEqual(headers(await t.run(homeScreen(t.ctx))), ALL);
    assert.equal(calls(t, "/v1/watching/movies"), 0);
    // История и сериалы «Продолжить» — первыми, до полок каталога.
    assert.deepEqual(t.mock.calls().slice(0, 2).map((c) => c.path).sort(), ["/v1/history", "/v1/watching/serials"]);

    const empty = await make();
    empty.mock.state.history = [];
    // Лишний запрос встаёт в очередь лимитера последним: на холодном старте полка может прийти заменой экрана.
    if (!headers(await open(empty)).includes(ALL[0] ?? "")) await driveToAction(empty);
    const tiles = shelf(await open(empty), "Продолжить просмотр");
    assert.equal(calls(empty, "/v1/watching/movies"), 1);
    // Сериалы — с меньшим остатком серий первыми (QA-API-1), затем фильмы.
    assert.deepEqual(tiles.map((i) => i.action), [FIX.SERIAL_SMALL, FIX.SERIAL_BIG, FIX.MOVIE_SIMPLE].map((id) => contentAction(P, ids.item(id))));
    assert.ok(tiles.every((i) => i.progress === undefined && i.tag === undefined));
    assert.deepEqual(tiles.map((i) => i.badge), ["+5", undefined, undefined]);
  });

  it("warmHome warms watching/movies too: the started films of the cache follow the history titles without a request", async () => {
    const t = await make();
    t.mock.state.watching.set(watchKey(FIX.MOVIE_AUDIO12, 0, 1), { time: 600, status: 0, updated: Math.floor(Date.now() / 1000) - 7200 });
    warmHome(t.ctx);
    await drive(t, () => t.ctx.cache.peek(cacheKeys.movies()) !== undefined && HOME_KEYS.every((k) => t.ctx.cache.peek(k) !== undefined), "warm-up");
    const n = calls(t, "/v1/watching/movies");
    assert.deepEqual(shelf(await open(t), "Продолжить просмотр").map((i) => i.id), [
      FIX.SERIAL_BIG, FIX.MOVIE_SIMPLE, FIX.SERIAL_SMALL, FIX.MOVIE_AUDIO12,
    ].map((id) => `c${id}`));
    assert.equal(calls(t, "/v1/watching/movies"), n, "from the cache");
  });

  /**
   * QA-API-1: неделя одного сериала — 50 последних строк истории (одна страница), прежние тайтлы — на второй странице.
   * `finished` — сериал досмотрен до конца: раньше полка оставалась пустой и пропадала с главной целиком.
   */
  function binge(t: TestApp, finished: boolean): void {
    const it = findItem(FIX.SERIAL_LONG);
    assert.ok(it?.seasons);
    const units = it.seasons.flatMap((x) => x.episodes.map((e) => ({ season: x.number, e })));
    const now = Math.floor(Date.now() / 1000);
    const watched = finished ? units : units.slice(0, 50);
    for (const u of watched) t.mock.state.watching.set(watchKey(it.id, u.season, u.e.number), { time: u.e.duration, status: 1, updated: now - 60 });
    const rows = watched.slice(-50).map((u, i) => ({ item: it.id, season: u.season, video: u.e.number, time: u.e.duration, lastSeen: now - 600 + i }));
    t.mock.state.history = [...rows.reverse(), ...t.mock.state.history];
  }

  it("QA-API-1: 50 episodes of one serial in a row — the other started serials stay after it; the films — after warmHome", async () => {
    const t = await make();
    binge(t, false);
    const cold = shelf(await open(t), "Продолжить просмотр");
    assert.deepEqual(cold.map((i) => i.id), [FIX.SERIAL_LONG, FIX.SERIAL_SMALL, FIX.SERIAL_BIG].map((id) => `c${id}`));
    assert.equal(cold[0]?.tag, "1×50");
    const warm = await make({ mock: t.mock });
    warmHome(warm.ctx);
    await drive(warm, () => warm.ctx.cache.peek(cacheKeys.movies()) !== undefined, "warm-up");
    assert.deepEqual(shelf(await open(warm), "Продолжить просмотр").map((i) => i.id), [
      FIX.SERIAL_LONG, FIX.SERIAL_SMALL, FIX.SERIAL_BIG, FIX.MOVIE_SIMPLE,
    ].map((id) => `c${id}`));
  });

  it("QA-API-1: the binge serial watched to the end — «Продолжить» is still on the home with the other titles (it vanished before)", async () => {
    const t = await make();
    binge(t, true);
    const s = await open(t);
    assert.equal(headers(s)[0], "Продолжить просмотр");
    assert.deepEqual(shelf(s, "Продолжить просмотр").map((i) => i.id), [FIX.SERIAL_SMALL, FIX.SERIAL_BIG].map((id) => `c${id}`));
  });

  it("QA-API-7 / M-2: a serial started without a watched episode comes from watching/serials — first, the tag of the history, 0 of 300", async () => {
    const t = await make();
    const now = Math.floor(Date.now() / 1000);
    t.mock.state.watching.set(watchKey(FIX.SERIAL_LONG, 1, 1), { time: 600, status: 0, updated: now });
    t.mock.state.history.unshift({ item: FIX.SERIAL_LONG, season: 1, video: 1, time: 600, lastSeen: now });
    const tiles = shelf(await open(t), "Продолжить просмотр");
    // Прогресс 0 — доля из строки списка (без неё, по истории, прогресса нет: эту ветку держит continue.test.ts).
    assert.deepEqual(tiles.map((i) => [i.id, i.tag, i.progress]), [
      [`c${FIX.SERIAL_LONG}`, "1×1", 0], [`c${FIX.SERIAL_BIG}`, "1×4", 0.02], [`c${FIX.MOVIE_SIMPLE}`, undefined, 0.22], [`c${FIX.SERIAL_SMALL}`, "1×1", 0.17],
    ]);
  });
});
