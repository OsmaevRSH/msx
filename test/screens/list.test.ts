import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { ListState } from "../../src/app/context.ts";
import { cacheKeys } from "../../src/cache/repo.ts";
import { KpError } from "../../src/core/errors.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { decodeListKey, encodeListKey, ids, listFlag } from "../../src/router/ids.ts";
import type { ListKey } from "../../src/router/ids.ts";
import { errorScreen } from "../../src/screens/error.ts";
import { MAX_LISTS, SORTS, listScreen, listSource, listTitle, onExtend } from "../../src/screens/list.ts";
import { gridTemplate, posterTiles } from "../../src/screens/tiles.ts";
import { catalog } from "../../tools/kpmock/fixtures.ts";
import { FAKE_EPOCH, FakeClock } from "../helpers/fake-clock.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(o: Omit<TestAppOptions, "loggedIn"> = {}): Promise<TestApp> {
  const t = await createTestApp({ ...o, loggedIn: true });
  apps.push(t);
  return t;
}

const DAY = 86_400_000;
const catalogKey = (type: string, more: Partial<ListKey> = {}): string =>
  encodeListKey({ src: "catalog", type, sort: "-updated", ...more });
const MOVIES = catalogKey("movie");
const CONCERTS = catalogKey("concert");
const visible = (type: string): number => catalog().filter((it) => !it.deleted && it.type === type).length;

const items = (s: MsxContentRoot): MsxContentItem[] => s.items ?? [];
const actions = (t: TestApp): string[] => t.host.actions.map((a) => a.action);
const EXTEND = "interaction:commit:message:extend:";
const live = (key: string, dir: "down" | "up", at: number): MsxContentItem["live"] =>
  ({ type: "setup", action: `${EXTEND}${key}:${dir}:${at}` });
const pageCalls = (t: TestApp, page: number, path = "/v1/items"): number =>
  t.mock.calls().filter((c) => c.path === path && new URLSearchParams(c.query).get("page") === String(page)).length;
const state = (t: TestApp, key: string): ListState => {
  const st = t.ctx.state.lists.get(key);
  assert.ok(st !== undefined, "list state");
  return st;
};
/** Страница источника уже в кэше (фоновый префетч завершился). */
const cached = (t: TestApp, key: string, page: number): boolean =>
  t.ctx.cache.peek(cacheKeys.list(listSource(decodeListKey(key)), page)) !== undefined;

/** Ждать в поддельном времени (через `t.run`), пока условие не выполнится. */
async function until(pred: () => boolean): Promise<void> {
  while (!pred()) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("listScreen (S5, CC-05)", () => {
  it("«Фильмы»: 48 tiles, live setup → extend on the last one, unique flag, cache:false", async () => {
    const t = await make();
    const s: MsxContentRoot = await t.request(ids.list(MOVIES));
    const { items: _items, template, options, ...root } = s;
    assert.deepEqual(root, {
      type: "list", compress: true, flag: listFlag(MOVIES), cache: false, reuse: false,
      headline: "Фильмы · Обновлённые", extension: "{ico:msx-red:stop} Сортировка и жанр",
    });
    assert.deepEqual(template, gridTemplate(t.ctx, "0,0,2,4"));
    assert.deepEqual(options?.items?.map((i) => i.action), [
      `panel:request:interaction:panel:sort:${MOVIES}@${TEST_P}`,
      `panel:request:interaction:panel:genre:${MOVIES}@${TEST_P}`,
    ]);
    const tiles = items(s);
    assert.equal(tiles.length, 48);
    assert.deepEqual(tiles.at(-1)?.live, live(MOVIES, "down", 48));
    assert.equal(tiles.filter((i) => i.live !== undefined).length, 1);
    const page = await t.run(t.ctx.repo.listPage(listSource(decodeListKey(MOVIES)), 1));
    assert.deepEqual(tiles.map(({ live: _l, ...tile }) => tile), posterTiles(t.ctx, page.value.items));
    const first = t.mock.calls().find((c) => c.path === "/v1/items");
    const q = new URLSearchParams(first?.query);
    assert.deepEqual([q.get("type"), q.get("sort"), q.get("page"), q.get("perpage")], ["movie", "-updated", "1", "48"]);
    assert.deepEqual(t.ctx.current.get(), ids.list(MOVIES));
  });

  it("the JSON of a 48-tile page fits 32 KB (CNFR-16)", async () => {
    const t = await make();
    const s = await t.request(ids.list(MOVIES));
    assert.ok(Buffer.byteLength(JSON.stringify(s), "utf8") <= 32 * 1024);
  });

  it("«Концерты» (30 titles): 30 tiles, no live, done, no prefetch", async () => {
    const t = await make();
    assert.equal(visible("concert"), 30);
    const s = await t.request(ids.list(CONCERTS));
    assert.equal(items(s).length, 30);
    assert.ok(items(s).every((i) => i.live === undefined));
    assert.equal(state(t, CONCERTS).done, true);
    assert.equal(pageCalls(t, 2), 0);
  });

  it("page 2 is prefetched in the background after the answer; extend then needs no request", async () => {
    const t = await make();
    await t.request(ids.list(MOVIES));
    await t.run(until(() => cached(t, MOVIES, 2)));
    assert.equal(pageCalls(t, 2), 1);
    assert.ok(t.ctx.log.entries().some((e) => e.tag === "api" && /^GET \/v1\/items 200 \d+ms bg$/.test(e.msg)));
    await t.run(onExtend(t.ctx, MOVIES));
    assert.equal(pageCalls(t, 2), 1);
    assert.equal(state(t, MOVIES).items.length, 96);
  });

  it("first page fails (network down) → error screen KP-NET with retry", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: ".*", drop: true }] });
    const s = await t.request(ids.list(MOVIES));
    assert.deepEqual(s, errorScreen(t.ctx, new KpError("KP-NET", "network"), ids.list(MOVIES)));
    assert.ok(t.ctx.state.lists.get(MOVIES) === undefined);
  });

  it("first page fails but L2 has it → the list with «нет связи»", async () => {
    const a = await make();
    await a.request(ids.list(MOVIES));
    a.ctx.l2.flush();
    // Через неделю запись L2 старше stale-max: SWR идёт в сеть, а при сбое отдаёт её с пометкой offline.
    const b = await make({ mock: a.mock, storage: a.storage, clock: new FakeClock(FAKE_EPOCH + 8 * DAY) });
    b.mock.setScenario({ rules: [{ path: ".*", drop: true }] });
    const s = await b.request(ids.list(MOVIES));
    assert.equal(items(s).length, 48);
    assert.equal(s.extension, "{ico:msx-red:stop} Сортировка и жанр  {ico:msx-yellow:history} нет связи");
    assert.deepEqual(items(s).at(-1)?.live, live(MOVIES, "down", 48));
  });

  it("an empty list: «Ничего не найдено» and a focusable «Назад», no live", async () => {
    const t = await make();
    const key = catalogKey("movie", { genre: "99999" });
    const s: MsxContentRoot = await t.request(ids.list(key));
    assert.equal(s.items, undefined);
    assert.equal(s.template, undefined);
    const page = s.pages?.[0]?.items ?? [];
    assert.deepEqual(page.map((i) => [i.type, i.text ?? i.label, i.action]), [
      ["space", "Ничего не найдено", undefined],
      ["button", "Назад", "back"],
    ]);
    assert.equal(s.flag, listFlag(key));
    assert.equal(state(t, key).done, true);
  });

  it("similar: one portion, «Похожие», no sort and genre options", async () => {
    const t = await make();
    const key = encodeListKey({ src: "similar", id: 2006 });
    const s: MsxContentRoot = await t.request(ids.list(key));
    assert.equal(s.headline, "Похожие");
    assert.equal(s.extension, undefined);
    assert.equal(s.options, undefined);
    assert.ok(items(s).length > 0 && items(s).length < 48);
    assert.ok(items(s).every((i) => i.live === undefined));
  });

  it("shelf: «Новинки · Фильмы» from /v1/items/fresh, only the genre option", async () => {
    const t = await make();
    const key = encodeListKey({ src: "fresh", type: "movie" });
    const s: MsxContentRoot = await t.request(ids.list(key));
    assert.equal(s.headline, "Новинки · Фильмы");
    assert.equal(s.extension, "{ico:msx-red:stop} Жанр");
    assert.deepEqual(s.options?.items?.map((i) => i.action), [`panel:request:interaction:panel:genre:${key}@${TEST_P}`]);
    assert.equal(items(s).length, 48);
    assert.equal(pageCalls(t, 1, "/v1/items/fresh"), 1);
  });

  it("headline: genre title from /v1/genres, «Мультфильмы» for genre 23, sort title", async () => {
    const t = await make();
    const drama = await t.request(ids.list(catalogKey("movie", { genre: "9" })));
    assert.equal(drama.headline, "Фильмы · Обновлённые · Драма");
    const cartoons = await t.request(ids.list(catalogKey("movie,serial", { genre: "23" })));
    assert.equal(cartoons.headline, "Мультфильмы · Обновлённые");
    const top = await t.request(ids.list(catalogKey("serial", { sort: "-kinopoisk_rating" })));
    assert.equal(top.headline, "Сериалы · Рейтинг КП");
  });

  it("a bad key → error screen KP-BAD", async () => {
    const t = await make();
    for (const key of ["!!!", encodeListKey({ src: "folder" })]) {
      assert.deepEqual(await listScreen(t.ctx, key), errorScreen(t.ctx, new KpError("KP-BAD", "bad"), ids.list(key)));
    }
  });

  it(`keeps at most ${MAX_LISTS} lists in memory, the least recently used goes first`, async () => {
    const t = await make();
    for (let i = 0; i < MAX_LISTS; i++) {
      const key = `old${i}`;
      t.ctx.state.lists.set(key, { key, items: [], page: 1, totalPages: 1, done: true });
    }
    await t.request(ids.list(CONCERTS));
    assert.equal(t.ctx.state.lists.size, MAX_LISTS);
    assert.ok(!t.ctx.state.lists.has("old0"));
    assert.ok(t.ctx.state.lists.has("old1") && t.ctx.state.lists.has(CONCERTS));
  });
});

describe("onExtend (spec §3.4, §6.3, CD-16)", () => {
  it("the list is current → 96 tiles and reload:content", async () => {
    const t = await make();
    await t.request(ids.list(MOVIES));
    await t.run(onExtend(t.ctx, MOVIES));
    assert.deepEqual(actions(t), ["reload:content"]);
    const s = await t.request(ids.list(MOVIES));
    const tiles = items(s);
    assert.equal(tiles.length, 96);
    assert.equal(new Set(tiles.map((i) => i.id)).size, 96);
    assert.deepEqual(tiles.at(-1)?.live, live(MOVIES, "down", 96));
    assert.equal(tiles.filter((i) => i.live !== undefined).length, 1);
  });

  it("the edge message goes through the router; a bare extend:<key> extends down from the current end", async () => {
    const t = await make();
    await t.request(ids.list(MOVIES));
    t.app.handleData({ message: `extend:${MOVIES}:down:48` });
    await t.run(until(() => actions(t).includes("reload:content")));
    assert.equal(state(t, MOVIES).items.length, 96);
    t.app.handleData({ message: `extend:${MOVIES}` });
    await t.run(until(() => actions(t).length === 2));
    assert.equal(state(t, MOVIES).items.length, 144);
  });

  it("the card became current → no reload; back to the list: 96 tiles from memory, no requests, ≤ 50 ms (CE-06)", async () => {
    const t = await make();
    await t.request(ids.list(MOVIES));
    t.ctx.current.onRequest(ids.item(1));
    await t.run(onExtend(t.ctx, MOVIES));
    assert.deepEqual(actions(t), []);
    assert.equal(state(t, MOVIES).items.length, 96);
    await t.run(until(() => cached(t, MOVIES, 3)));
    const before = t.mock.calls().length;
    const t0 = performance.now();
    const s = await t.app.handleRequest(ids.list(MOVIES), {});
    const ms = performance.now() - t0;
    assert.equal(items(s as MsxContentRoot).length, 96);
    assert.equal(t.mock.calls().length, before);
    assert.ok(ms <= 50, `${ms.toFixed(1)} ms`);
    assert.equal(t.ctx.current.get(), ids.list(MOVIES));
  });

  it("to the end: the short last page finishes the list; a clamped page is not appended again (A-13)", async () => {
    const t = await make();
    await t.request(ids.list(MOVIES));
    const st = state(t, MOVIES);
    while (!st.done) await t.run(onExtend(t.ctx, MOVIES));
    const total = visible("movie");
    assert.equal(st.items.length, total);
    assert.deepEqual([st.page, st.totalPages], [Math.ceil(total / 48), Math.ceil(total / 48)]);
    const s = await t.request(ids.list(MOVIES));
    assert.equal(items(s).at(-1)?.id, `i${st.items.at(-1)?.id}`);
    assert.ok(items(s).every((i) => !i.live?.action?.includes(":down:")));

    // Список, конец которого не был замечен: KinoPub отдаёт последнюю страницу вместо пустой.
    st.done = false;
    await t.run(onExtend(t.ctx, MOVIES));
    assert.equal(pageCalls(t, st.page), 1);
    assert.equal(st.items.length, total);
    assert.equal(new Set(st.items.map((i) => i.id)).size, total);
    assert.equal(st.done, true);
  });

  it("concurrent extends load one page", async () => {
    const t = await make();
    await t.request(ids.list(MOVIES));
    await t.run(Promise.all([onExtend(t.ctx, MOVIES), onExtend(t.ctx, MOVIES)]));
    assert.equal(state(t, MOVIES).items.length, 96);
    assert.deepEqual(actions(t), ["reload:content"]);
  });

  it("a failed extend: warning, live stays, no reload; the next extend succeeds", async () => {
    const t = await make();
    await t.request(ids.list(MOVIES));
    await t.run(until(() => cached(t, MOVIES, 2)));
    t.ctx.cache.delete(cacheKeys.list(listSource(decodeListKey(MOVIES)), 2));
    t.mock.setScenario({ rules: [{ path: ".*", drop: true }] });
    await t.run(onExtend(t.ctx, MOVIES));
    assert.ok(t.ctx.log.entries().some((e) => e.tag === "list" && e.level === "warn" && e.msg === "extend_failed"));
    assert.deepEqual(actions(t), []);
    assert.deepEqual([state(t, MOVIES).page, state(t, MOVIES).done], [1, false]);
    assert.deepEqual(items(await t.request(ids.list(MOVIES))).at(-1)?.live, live(MOVIES, "down", 48));

    t.mock.setScenario({ rules: [] });
    await t.run(onExtend(t.ctx, MOVIES));
    assert.equal(state(t, MOVIES).items.length, 96);
    assert.deepEqual(actions(t), ["reload:content"]);
  });

  it("unknown or finished lists are ignored", async () => {
    const t = await make();
    await t.run(onExtend(t.ctx, MOVIES));
    await t.request(ids.list(CONCERTS));
    await t.run(onExtend(t.ctx, CONCERTS));
    assert.deepEqual(actions(t), []);
    assert.equal(pageCalls(t, 2), 0);
  });
});

describe("SORTS and listTitle (for the S6 panels)", () => {
  it("six sorts in the Plan B order", () => {
    assert.deepEqual(SORTS, [
      { id: "-updated", title: "Обновлённые" }, { id: "-created", title: "Новые на сайте" },
      { id: "-kinopoisk_rating", title: "Рейтинг КП" }, { id: "-imdb_rating", title: "IMDb" },
      { id: "-views", title: "Популярные" }, { id: "-year", title: "Год" },
    ]);
  });

  it("titles by source", () => {
    assert.equal(listTitle({ src: "catalog", type: "concert", sort: "-year" }), "Концерты · Год");
    assert.equal(listTitle({ src: "catalog", type: "documovie,docuserial" }), "Документальное · Обновлённые");
    assert.equal(listTitle({ src: "popular", type: "serial" }), "Популярное · Сериалы");
    assert.equal(listTitle({ src: "hot", type: "movie" }), "Горячее · Фильмы");
    assert.equal(listTitle({ src: "folder", folder: 7 }), "Закладки");
    assert.equal(listTitle({ src: "similar", id: 1 }), "Похожие");
  });

  it("listSource maps the key; catalog sort defaults to -updated", () => {
    assert.deepEqual(listSource({ src: "catalog", type: "movie" }), { kind: "catalog", type: "movie", sort: "-updated" });
    assert.deepEqual(listSource({ src: "hot", type: "serial", genre: "9" }), { kind: "shelf", shelf: "hot", type: "serial", genre: "9" });
    assert.deepEqual(listSource({ src: "folder", folder: 7 }), { kind: "folder", folder: 7 });
    assert.deepEqual(listSource({ src: "similar", id: 5 }), { kind: "similar", id: 5 });
    assert.throws(() => listSource({ src: "similar" }), KpError);
  });
});
