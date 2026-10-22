import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { encodeListKey, ids, listFlag } from "../../src/router/ids.ts";
import { expandContext, rootIssues, splitChain } from "../../tools/crawl-rules.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";
import { waitFor } from "../progress/progress-rig.ts";
import { actions, assertCleanTraffic, follow, pick } from "./rig.ts";

// Contract действий над плиткой (спец. §11.4): только по действиям из ответов, как MSX — экран → опции плитки в фокусе
// (`template.options` с `{context:kid}`) → сообщение `act:tile:…` → запрос KinoPub → замена текущего экрана своим флагом
// с фокусом на соседней плитке, `info:`, пометки кэша. «Я смотрю» — `togglewatchlist` со сверкой (CM-01).

const HISTORY = encodeListKey({ src: "history" });
const FOLDER = 1;
const FOLDER_KEY = encodeListKey({ src: "folder", folder: FOLDER });
const COMMIT = "interaction:commit:message:";

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function app(): Promise<TestApp> {
  const t = await createTestApp({ loggedIn: true });
  apps.push(t);
  return t;
}

const tile = (s: MsxContentRoot, id: number): MsxContentItem => pick(s.items, (i) => i.id === `i${id}`, `tile ${id}`);
const tileIds = (s: MsxContentRoot): string[] => (s.items ?? []).filter((i) => typeof i.kid === "string").map((i) => i.id as string);

/** Опции плитки, как их покажет MSX: свои у плитки или шаблона с `{context:…}` этой плитки; `false` — системные. */
function optionsOf(s: MsxContentRoot, it: MsxContentItem): MsxContentRoot | false {
  const own = it.options as MsxContentRoot | false | undefined;
  if (own !== undefined) return own;
  const tpl = s.template?.options;
  assert.ok(tpl !== undefined, "no options in the template");
  return JSON.parse(expandContext(JSON.stringify(tpl), it)) as MsxContentRoot;
}

const labels = (o: MsxContentRoot | false): string[] => (o === false ? [] : (o.items ?? []).map((i) => i.label ?? ""));

/** Пункт опций выбран: MSX закрывает опции (`back`) и выполняет остальное; панель — её dataId. */
function choose(t: TestApp, o: MsxContentRoot | false, label: string): string | undefined {
  assert.ok(o !== false, "system options");
  const row = pick(o.items, (i) => i.label === label, `option ${label}`);
  const members = splitChain(row.action ?? "");
  assert.equal(members[0], "back", "the options close first");
  let panel: string | undefined;
  for (const m of members.slice(1)) {
    if (m.startsWith(COMMIT)) t.app.handleData({ message: m.slice(COMMIT.length) });
    else panel = follow(m, "panel");
  }
  return panel;
}

const done = (t: TestApp, info: string): Promise<void> =>
  waitFor(t, () => actions(t).some((a) => a.includes(`info:${info}`)), `info:${info}`);
const calls = (t: TestApp, path: string): URLSearchParams[] =>
  t.mock.calls().filter((c) => c.path === path).map((c) => new URLSearchParams(c.query));

describe("contract: tile actions (spec §11.4)", () => {
  it("«История» → red on a title → «Удалить из истории»: clear-for-item, the tile is gone at once, focus on its neighbour", async () => {
    const t = await app();
    // Данные «Продолжить» и «Я смотрю» в кэше, как после главной.
    await t.run(Promise.all([t.ctx.repo.history(), t.ctx.repo.serials(), t.ctx.repo.watchingMovies(), t.ctx.repo.item(FIX.MOVIE_SIMPLE)]));
    const h = (await t.request(ids.list(HISTORY))) as MsxContentRoot;
    assert.deepEqual(tileIds(h), [`i${FIX.SERIAL_BIG}`, `i${FIX.MOVIE_SIMPLE}`, `i${FIX.SERIAL_SMALL}`]);
    assert.deepEqual(rootIssues(h, "history"), []);
    const o = optionsOf(h, tile(h, FIX.MOVIE_SIMPLE));
    assert.ok(o !== false);
    assert.equal(o.headline, "Тестовый фильм «Простой»", "the title in focus heads the options");
    assert.deepEqual(labels(o), ["Удалить из истории", "Очистить всю историю"]);
    t.host.clearActions();
    choose(t, o, "Удалить из истории");
    await done(t, "Удалено из истории");
    assert.deepEqual(calls(t, "/v1/history/clear-for-item").map((q) => q.get("id")), [String(FIX.MOVIE_SIMPLE)]);
    const dataId = ids.list(HISTORY);
    assert.deepEqual(actions(t), [
      `[focus:i${FIX.SERIAL_SMALL}|replace:content:${listFlag(HISTORY)}:request:interaction:${dataId}@${TEST_P}|info:Удалено из истории]`,
    ]);
    // MSX перезапрашивает экран по замене: из памяти, без сети и без удалённого тайтла.
    const n = t.mock.calls().length;
    const after = (await t.request(dataId)) as MsxContentRoot;
    assert.deepEqual(tileIds(after), [`i${FIX.SERIAL_BIG}`, `i${FIX.SERIAL_SMALL}`]);
    assert.equal(t.mock.calls().length, n, "the replaced screen comes from memory");
    // Связанные экраны: история, «Продолжить» и «Я смотрю» помечены устаревшими.
    for (const k of ["history:", "serials:", "movies:", `item:${FIX.MOVIE_SIMPLE}:`]) assert.equal(t.ctx.cache.peek(k)?.stale, true, k);
    assertCleanTraffic(t.mock.calls(), [t]);
  });

  it("the last tile removed → focus on the previous one; the only one → the empty screen", async () => {
    const t = await app();
    let h = (await t.request(ids.list(HISTORY))) as MsxContentRoot;
    choose(t, optionsOf(h, tile(h, FIX.SERIAL_SMALL)), "Удалить из истории");
    await done(t, "Удалено из истории");
    assert.ok(actions(t).at(-1)?.startsWith(`[focus:i${FIX.MOVIE_SIMPLE}|replace:content:`));
    for (const id of [FIX.MOVIE_SIMPLE, FIX.SERIAL_BIG]) {
      h = (await t.request(ids.list(HISTORY))) as MsxContentRoot;
      t.host.clearActions();
      choose(t, optionsOf(h, tile(h, id)), "Удалить из истории");
      await done(t, "Удалено из истории");
    }
    assert.ok(actions(t).at(-1)?.startsWith("[replace:content:"), "nothing to focus");
    const empty = (await t.request(ids.list(HISTORY))) as MsxContentRoot;
    assert.match(JSON.stringify(empty.pages), /Здесь появятся фильмы и сериалы/);
    assert.deepEqual(rootIssues(empty, "history"), []);
  });

  it("«Очистить всю историю» → confirmation with focus on «Отмена» → «Очистить»: every title cleared, the screen replaced empty", async () => {
    const t = await app();
    // Длинная история: серии одного сериала занимают записи, тайтлы — по одному запросу.
    for (let e = 5; e <= 8; e++) t.mock.state.history.unshift({ item: FIX.SERIAL_BIG, season: 1, video: e, time: 60, lastSeen: 2e9 + e });
    const h = (await t.request(ids.list(HISTORY))) as MsxContentRoot;
    const panelId = choose(t, optionsOf(h, tile(h, FIX.SERIAL_BIG)), "Очистить всю историю");
    assert.equal(panelId, ids.panel("tile", "clear"));
    const p = (await t.request(panelId!)) as MsxContentRoot;
    assert.equal(p.headline, "Очистить всю историю?");
    assert.deepEqual(labels(p), ["Очистить", "Отмена"]);
    assert.equal(pick(p.items, (i) => i.focus === true, "focused").label, "Отмена");
    assert.equal(pick(p.items, (i) => i.label === "Отмена", "cancel").action, "back");
    assert.deepEqual(rootIssues(p, panelId!), []);
    assert.equal(t.ctx.current.get(), ids.list(HISTORY), "a panel does not change the current screen");
    t.host.clearActions();
    choose(t, p, "Очистить");
    await done(t, "История очищена");
    assert.deepEqual(calls(t, "/v1/history/clear-for-item").map((q) => Number(q.get("id"))).sort(),
      [FIX.SERIAL_BIG, FIX.SERIAL_SMALL, FIX.MOVIE_SIMPLE].sort());
    assert.equal(t.mock.state.history.length, 0);
    assert.equal(actions(t).at(-1), `[replace:content:${listFlag(HISTORY)}:request:interaction:${ids.list(HISTORY)}@${TEST_P}|info:История очищена]`);
    const empty = (await t.request(ids.list(HISTORY))) as MsxContentRoot;
    assert.equal(empty.items, undefined);
    assert.match(JSON.stringify(empty.pages), /Здесь появятся/);
  });

  it("«Очистить всю историю» when KinoPub keeps a title: stops after one pass with a message, no endless loop", async () => {
    const t = await app();
    const h = (await t.request(ids.list(HISTORY))) as MsxContentRoot;
    // API отвечает 200, но запись остаётся (как если бы clear-for-item её не трогал).
    t.mock.setScenario({ rules: [{ path: "^/v1/history/clear-for-item$", status: 200 }] });
    choose(t, (await t.request(choose(t, optionsOf(h, tile(h, FIX.SERIAL_BIG)), "Очистить всю историю")!)) as MsxContentRoot, "Очистить");
    await done(t, "Историю очистить не удалось");
    assert.equal(calls(t, "/v1/history/clear-for-item").length, 3, "each title once");
  });

  it("«Я смотрю»: a serial → «Убрать из „Я смотрю“» (one togglewatchlist); a movie has no tile options", async () => {
    const t = await app();
    const w = (await t.request(ids.watching())) as MsxContentRoot;
    assert.deepEqual(tileIds(w), [`i${FIX.SERIAL_SMALL}`, `i${FIX.SERIAL_BIG}`, `i${FIX.MOVIE_SIMPLE}`]);
    assert.deepEqual(rootIssues(w, "watching"), []);
    assert.equal(optionsOf(w, tile(w, FIX.MOVIE_SIMPLE)), false, "a movie: MSX's own options, no remove action");
    const o = optionsOf(w, tile(w, FIX.SERIAL_BIG));
    assert.deepEqual(labels(o), ["Убрать из «Я смотрю»"]);
    t.host.clearActions();
    choose(t, o, "Убрать из «Я смотрю»");
    await done(t, "Убрано из «Я смотрю»");
    assert.deepEqual(calls(t, "/v1/watching/togglewatchlist").map((q) => q.get("id")), [String(FIX.SERIAL_BIG)]);
    assert.deepEqual(actions(t), [
      `[focus:i${FIX.MOVIE_SIMPLE}|replace:content:watching:request:interaction:${ids.watching()}@${TEST_P}|info:Убрано из «Я смотрю»]`,
    ]);
    const after = (await t.request(ids.watching())) as MsxContentRoot;
    assert.deepEqual(tileIds(after), [`i${FIX.SERIAL_SMALL}`, `i${FIX.MOVIE_SIMPLE}`]);
    assert.equal(after.extension, "1 сериал · 1 фильм");
    assertCleanTraffic(t.mock.calls(), [t]);
  });

  it("«Я смотрю», CM-01: the answer is lost after KinoPub applied it → re-read, no second toggle", async () => {
    const t = await app();
    const w = (await t.request(ids.watching())) as MsxContentRoot;
    t.mock.setScenario({ watchlistLostResponse: 1 });
    const reads = calls(t, "/v1/watching/serials").length;
    choose(t, optionsOf(w, tile(w, FIX.SERIAL_BIG)), "Убрать из «Я смотрю»");
    await done(t, "Убрано из «Я смотрю»");
    assert.equal(calls(t, "/v1/watching/togglewatchlist").length, 1, "not toggled back");
    assert.ok(calls(t, "/v1/watching/serials").length > reads, "the list was re-read before deciding");
    assert.equal(t.mock.state.watchlist.get(FIX.SERIAL_BIG), false);
    const after = (await t.request(ids.watching())) as MsxContentRoot;
    assert.deepEqual(tileIds(after), [`i${FIX.SERIAL_SMALL}`, `i${FIX.MOVIE_SIMPLE}`]);
  });

  it("«Я смотрю», CM-01: the request is lost before KinoPub → re-read shows the serial → one more toggle", async () => {
    const t = await app();
    const w = (await t.request(ids.watching())) as MsxContentRoot;
    t.mock.setScenario({ rules: [{ path: "^/v1/watching/togglewatchlist$", drop: true, times: 1 }] });
    choose(t, optionsOf(w, tile(w, FIX.SERIAL_BIG)), "Убрать из «Я смотрю»");
    await done(t, "Убрано из «Я смотрю»");
    assert.equal(calls(t, "/v1/watching/togglewatchlist").length, 2);
    assert.equal(t.mock.state.watchlist.get(FIX.SERIAL_BIG), false);
  });

  it("«Я смотрю», CM-01: already removed on another TV → the switch answers `true` → switched back once", async () => {
    const t = await app();
    const w = (await t.request(ids.watching())) as MsxContentRoot;
    t.mock.state.watchlist.set(FIX.SERIAL_BIG, false);
    choose(t, optionsOf(w, tile(w, FIX.SERIAL_BIG)), "Убрать из «Я смотрю»");
    await done(t, "Убрано из «Я смотрю»");
    assert.equal(calls(t, "/v1/watching/togglewatchlist").length, 2);
    assert.equal(t.mock.state.watchlist.get(FIX.SERIAL_BIG), false);
  });

  it("«Я смотрю»: KinoPub fails → the error text, the tile stays", async () => {
    const t = await app();
    const w = (await t.request(ids.watching())) as MsxContentRoot;
    t.mock.setScenario({ rules: [{ path: "^/v1/watching/", status: 503 }] });
    t.host.clearActions();
    choose(t, optionsOf(w, tile(w, FIX.SERIAL_BIG)), "Убрать из «Я смотрю»");
    await waitFor(t, () => actions(t).some((a) => a.startsWith("info:")), "error info");
    assert.ok(!actions(t).some((a) => a.includes("replace:content")), "nothing replaced");
    assert.equal(calls(t, "/v1/watching/togglewatchlist").length, 1, "no blind repeat of the switch");
    assert.equal(t.mock.state.watchlist.has(FIX.SERIAL_BIG), false, "the 503 came before KinoPub applied anything");
  });

  it("folder → «Убрать из папки»: remove-item, the tile is gone, the count in the extension follows", async () => {
    const t = await app();
    await t.request(ids.bookmarks());
    const f = (await t.request(ids.list(FOLDER_KEY))) as MsxContentRoot;
    assert.deepEqual(tileIds(f), [`i${FIX.MOVIE_SIMPLE}`, `i${FIX.SERIAL_BIG}`]);
    assert.equal(f.extension, "2 шт.");
    const o = optionsOf(f, tile(f, FIX.MOVIE_SIMPLE));
    assert.deepEqual(labels(o), ["Убрать из папки"], "one folder: nowhere to move");
    t.host.clearActions();
    choose(t, o, "Убрать из папки");
    await done(t, "Убрано из папки");
    const rm = t.mock.calls().filter((c) => c.path === "/v1/bookmarks/remove-item");
    assert.equal(rm.length, 1);
    assert.deepEqual(actions(t), [
      `[focus:i${FIX.SERIAL_BIG}|replace:content:${listFlag(FOLDER_KEY)}:request:interaction:${ids.list(FOLDER_KEY)}@${TEST_P}|info:Убрано из папки]`,
    ]);
    const after = (await t.request(ids.list(FOLDER_KEY))) as MsxContentRoot;
    assert.deepEqual(tileIds(after), [`i${FIX.SERIAL_BIG}`]);
    assert.equal(after.extension, "1 шт.");
    assert.deepEqual(t.mock.state.folders.get(FOLDER)?.items, [FIX.SERIAL_BIG]);
    assert.equal(t.ctx.cache.peek("bm:")?.stale, true, "folder counts on «Закладки» and the home shelf");
    assertCleanTraffic(t.mock.calls(), [t]);
  });

  it("folder → «Переместить в «MSX»»: add, then remove-item; the tile leaves this folder and shows in the other one", async () => {
    const t = await app();
    t.mock.state.folders.set(5, { title: "MSX", items: [FIX.SERIAL_SMALL], created: 1 });
    await t.request(ids.bookmarks());
    const other = encodeListKey({ src: "folder", folder: 5 });
    assert.deepEqual(tileIds((await t.request(ids.list(other))) as MsxContentRoot), [`i${FIX.SERIAL_SMALL}`]);
    const f = (await t.request(ids.list(FOLDER_KEY))) as MsxContentRoot;
    const o = optionsOf(f, tile(f, FIX.SERIAL_BIG));
    assert.deepEqual(labels(o), ["Убрать из папки", "Переместить в «MSX»"]);
    t.host.clearActions();
    choose(t, o, "Переместить в «MSX»");
    await done(t, "Перемещено в «MSX»");
    assert.deepEqual(t.mock.calls().filter((c) => c.path.startsWith("/v1/bookmarks/") && c.method === "POST").map((c) => c.path),
      ["/v1/bookmarks/add", "/v1/bookmarks/remove-item"]);
    assert.ok(actions(t).at(-1)?.startsWith(`[focus:i${FIX.MOVIE_SIMPLE}|replace:content:${listFlag(FOLDER_KEY)}:`));
    assert.deepEqual(tileIds((await t.request(ids.list(FOLDER_KEY))) as MsxContentRoot), [`i${FIX.MOVIE_SIMPLE}`]);
    assert.deepEqual(tileIds((await t.request(ids.list(other))) as MsxContentRoot), [`i${FIX.SERIAL_BIG}`, `i${FIX.SERIAL_SMALL}`]);
  });

  it("the screen is no longer current when KinoPub answers → only info, no replace or focus", async () => {
    const t = await app();
    const h = (await t.request(ids.list(HISTORY))) as MsxContentRoot;
    t.mock.setScenario({ delayMs: 300 });
    choose(t, optionsOf(h, tile(h, FIX.MOVIE_SIMPLE)), "Удалить из истории");
    await t.request(ids.search());
    t.host.clearActions();
    await done(t, "Удалено из истории");
    assert.deepEqual(actions(t), ["[info:Удалено из истории]"]);
    t.mock.setScenario({ delayMs: 0 });
    assert.deepEqual(tileIds((await t.request(ids.list(HISTORY))) as MsxContentRoot), [`i${FIX.SERIAL_BIG}`, `i${FIX.SERIAL_SMALL}`]);
  });

  it("other lists and sections have no tile options", async () => {
    const t = await app();
    for (const k of [{ src: "catalog", type: "movie" }, { src: "fresh", type: "movie" }, { src: "collections" }] as const) {
      const s = (await t.request(ids.list(encodeListKey(k)))) as MsxContentRoot;
      assert.equal(s.template?.options, undefined, k.src);
    }
  });

  it("bad messages do nothing: no request to KinoPub, a log line", async () => {
    const t = await app();
    const n = t.mock.calls().length;
    for (const m of ["act:tile:del", "act:tile:del:x", "act:tile:del:0", "act:tile:unfold:1", "act:tile:move:1:1", "act:tile:nope:1"]) {
      t.app.handleData({ message: m });
    }
    await t.run(new Promise((r) => setTimeout(r, 10)));
    assert.equal(t.mock.calls().length, n);
    assert.ok(t.ctx.log.entries().filter((e) => e.msg === "bad_args").length >= 6);
  });
});
