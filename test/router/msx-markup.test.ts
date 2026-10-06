import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cacheKeys } from "../../src/cache/repo.ts";
import type { MsxContentRoot, MsxMenuRoot } from "../../src/msx/types.ts";
import { encodeListKey, ids, msgs, parseDataId } from "../../src/router/ids.ts";
import { RESOLVE_KINDS, kindOf, menuActionIssues, menuIssues, rootIssues } from "../../tools/crawl-rules.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";

// Разметка каждого ответа плагина (интеграция W10b). Smoke-e2e этапа 27 нашёл в web MSX два дефекта, которых не видели
// тесты экранов: корень с `items` без `template` MSX не рисует («Содержимое недоступно», msx-platform §2.1), а меню из
// start parameter по `reload:menu` не перезапрашивается — только `replace:menu:<flag>:…`. Здесь все маршруты — обходом
// действий из ответов, как это делал бы MSX, и явно в пустых состояниях и при ошибках — проверяются на оба правила.
// Сами правила — общие с краулером (`tools/crawl-rules.ts`, этап 32).

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(o: TestAppOptions = {}): Promise<TestApp> {
  const t = await createTestApp(o);
  apps.push(t);
  return t;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** dataId всех `request:interaction:<id>@P` в ответе или действии: `content:`, `panel:`, `replace:…:`, `data` меню. */
const REQUEST = new RegExp(`request:interaction:([^@"|\\]]+)@${esc(TEST_P)}`, "g");
const requestsIn = (v: unknown): string[] => [...JSON.stringify(v).matchAll(REQUEST)].map((m) => m[1] ?? "");
const actions = (t: TestApp): string[] => t.host.actions.map((a) => a.action);

const MOVIES = encodeListKey({ src: "catalog", type: "movie", sort: "-updated" });
const EMPTY_FOLDER = 7;

/** Ждать в поддельном времени (через `t.run`), пока условие не выполнится. */
async function until(pred: () => boolean): Promise<void> {
  while (!pred()) await new Promise<void>((resolve) => setImmediate(resolve));
}

// --- Правила ---

function answerIssues(dataId: string, answer: unknown): string[] {
  const k = parseDataId(dataId).k;
  if (RESOLVE_KINDS.has(k)) return [];
  if (k === "init") return menuIssues(answer as MsxMenuRoot);
  return rootIssues(answer as MsxContentRoot, dataId);
}

/** Все нарушения в ответах и в действиях, которые плагин выполнил сам. */
function check(t: TestApp, answers: Map<string, unknown>): void {
  const out: string[] = [];
  for (const [id, a] of answers) out.push(...answerIssues(id, a), ...menuActionIssues(TEST_P, id, a));
  for (const a of actions(t)) out.push(...menuActionIssues(TEST_P, "executeAction", a));
  assert.deepEqual(out, []);
}

// --- Обход ---

/** Сколько разных dataId одного вида запрашивать: обходу нужна каждая разметка, а не каждый тайтл. */
const CAP: Record<string, number> = { item: 5, season: 3, play: 2, playEp: 2, probePlay: 1 };
const DEFAULT_CAP = 4;

/**
 * Обход как в MSX: следующие dataId — из действий в ответах (и в ответах resolve) и из действий, которые плагин выполнил
 * сам (`replace:content:…`). Ответы — по dataId, в порядке запросов.
 */
async function crawl(t: TestApp, start: string[], limit = 200): Promise<Map<string, unknown>> {
  const answers = new Map<string, unknown>();
  const queued = new Set<string>();
  const perKind = new Map<string, number>();
  const queue: string[] = [];
  const add = (ids: string[]): void => {
    for (const id of ids) {
      if (queued.has(id)) continue;
      const kind = kindOf(id);
      const n = perKind.get(kind) ?? 0;
      if (n >= (CAP[kind.split(":")[0] ?? ""] ?? DEFAULT_CAP)) continue;
      perKind.set(kind, n + 1);
      queued.add(id);
      queue.push(id);
    }
  };
  add(start);
  for (let id = queue.shift(); id !== undefined && answers.size < limit; id = queue.shift()) {
    const answer = await t.request(id);
    answers.set(id, answer);
    add(requestsIn(answer));
    add(actions(t).flatMap(requestsIn));
  }
  return answers;
}

const kinds = (answers: Map<string, unknown>): Set<string> => new Set([...answers.keys()].map(kindOf));

/** Ответы на явный список dataId по порядку. */
async function ask(t: TestApp, list: string[]): Promise<Map<string, unknown>> {
  const answers = new Map<string, unknown>();
  for (const id of list) answers.set(id, await t.request(id));
  return answers;
}

/** Набрать запрос поиска и дождаться ответа API (пауза ввода 500 мс). */
async function search(t: TestApp, query: string): Promise<void> {
  await t.request(ids.search());
  for (const ch of query) t.app.handleData({ message: msgs.searchInput(ch) });
  await t.clock.advance(500);
  await t.run(until(() => t.ctx.state.search.status !== "loading" && (t.ctx.state.search as { loading?: unknown }).loading === undefined));
}

// --- Тесты ---

describe("MSX markup of every answer (W10b: items need a template, the menu is redrawn by replace:menu)", () => {
  it("the rules catch the defects found in web MSX", () => {
    assert.deepEqual(rootIssues({ type: "list", items: [{ type: "button", label: "x" }] }, "dev"), [
      "dev: items без template — MSX покажет «Содержимое недоступно»",
    ]);
    assert.deepEqual(rootIssues({ type: "pages", pages: [{ items: [{ type: "space", text: "x" }] }] }, "p"), [
      "p: на странице 0 нет фокусируемого элемента",
    ]);
    assert.deepEqual(rootIssues({ template: {}, items: [{ label: "x", options: { items: [] } }] }, "o"), [
      "o item 0 options: items без template — MSX покажет «Содержимое недоступно»",
      "o item 0 options: ни items, ни pages",
    ]);
    assert.deepEqual(menuIssues({ menu: [{ label: "x" }] }), ["init: у меню нет flag — replace:menu его не найдёт"]);
    assert.deepEqual(menuIssues({ flag: "main", menu: [{ label: "x" }] }), ["init: flag main — replace:menu идёт с флагом menu"]);
    assert.equal(menuActionIssues(TEST_P, "a", "[info:x|reload:menu]").length, 1);
    assert.equal(menuActionIssues(TEST_P, "a", `replace:menu:main:request:interaction:init@${TEST_P}`).length, 1);
    assert.deepEqual(menuActionIssues(TEST_P, "a", `replace:menu:menu:request:interaction:init@${TEST_P}`), []);
  });

  it("logged out: menu, login, «Диагностика», «Для разработчика» with its panels, the report and every closed route", async () => {
    const t = await make();
    // Код не подтверждается: обход идёт без входа.
    t.mock.setScenario({ pendingPolls: 1_000 });
    const answers = await crawl(t, [
      ids.init(), ids.home(), ids.search(), ids.settings(), ids.bookmarks(), ids.list(MOVIES), ids.item(FIX.MOVIE_SIMPLE),
      ids.season(FIX.SERIAL_BIG, 1), ids.panel("sort", MOVIES), ids.playStart(FIX.MOVIE_SIMPLE), "no:such:route",
    ]);
    assert.equal(t.ctx.auth.isLoggedIn(), false);
    const seen = kinds(answers);
    for (const k of ["init", "login", "probe:", "probe:report:1", "probe:flag:heartbeat", "dev", "unknown", "home", "panel:sort"]) {
      assert.ok(seen.has(k), `${k} not crawled: ${[...seen].join(" ")}`);
    }
    check(t, answers);
  });

  it("logged in: everything reachable from the menu — home, lists, cards, seasons, panels, player, settings, «Диагностика»", async () => {
    const t = await make({ loggedIn: true });
    const answers = await crawl(t, [
      ids.init(),
      ids.list(encodeListKey({ src: "folder", folder: 1 })),
      ids.list(encodeListKey({ src: "similar", id: FIX.MOVIE_SIMPLE })),
      ids.login(),
    ]);
    const seen = kinds(answers);
    const want = [
      "init", "login", "home", "search", "settings", "bookmarks", "dev", "probe:", "probe:report:1", "probe:flag:apiBase",
      "list:catalog", "list:fresh", "list:folder", "list:similar", "item", "season", "play",
      "panel:sort", "panel:genre", "panel:audio", "panel:quality", "panel:subs", "panel:bookmarks", "panel:mode", "panel:loc",
      "panel:seasons", "panel:setting",
    ];
    assert.deepEqual(want.filter((k) => !seen.has(k)), [], `crawled: ${[...seen].join(" ")}`);
    // Результаты поиска — `template` + `items` под клавиатурой-заголовком; одна буква — ещё без запроса.
    await search(t, "тест");
    assert.equal(t.ctx.state.search.status, "ready");
    answers.set("search (results)", await t.request(ids.search()));
    t.app.handleData({ message: msgs.searchControl("clear") });
    t.app.handleData({ message: msgs.searchInput("м") });
    assert.equal(t.ctx.state.search.status, "short");
    answers.set("search (short)", await t.request(ids.search()));
    check(t, answers);
  });

  it("empty states: search without results, no folders, an empty folder, an empty list, an empty home", async () => {
    const s = await make({ loggedIn: true });
    await search(s, "мат");
    assert.equal(s.ctx.state.search.status, "empty");
    check(s, await ask(s, [ids.search()]));

    const b = await make({ loggedIn: true });
    b.mock.state.folders.clear();
    b.mock.state.folders.set(EMPTY_FOLDER, { title: "Пусто", items: [], created: 0 });
    check(b, await ask(b, [ids.bookmarks(), ids.list(encodeListKey({ src: "folder", folder: EMPTY_FOLDER }))]));
    b.mock.state.folders.clear();
    check(b, await ask(b, [ids.bookmarks()]));

    const l = await make({ loggedIn: true });
    check(l, await ask(l, [ids.list(encodeListKey({ src: "catalog", type: "movie", genre: "99999" }))]));

    const h = await make({ loggedIn: true });
    const empty = { ttlMs: 3_600_000, staleMaxMs: 0, persist: false };
    const keys = [cacheKeys.history(), cacheKeys.serials(), cacheKeys.movies(), cacheKeys.bookmarks()];
    for (const kind of ["fresh", "popular", "hot"]) for (const type of ["movie", "serial"]) keys.push(cacheKeys.shelf(kind, type));
    for (const k of keys) await h.run(h.ctx.cache.get(k, empty, async () => []));
    check(h, await ask(h, [ids.home()]));

    const n = await make({ loggedIn: true });
    n.mock.state.history = [];
    n.mock.state.watching.clear();
    n.mock.state.folders.clear();
    check(n, await ask(n, [ids.home()]));
  });

  it("errors: network down, KinoPub 5xx, a dead session, bad ids, probe.js not loaded", async () => {
    const screens = [
      ids.home(), ids.list(MOVIES), ids.item(FIX.MOVIE_SIMPLE), ids.season(FIX.SERIAL_BIG, 1), ids.settings(), ids.bookmarks(),
      ids.panel("genre", MOVIES), ids.panel("audio", FIX.MOVIE_SIMPLE, 1, "c"), ids.panel("quality", FIX.MOVIE_SIMPLE, 1, "p"),
      ids.panel("subs", FIX.MOVIE_SIMPLE, 1, "c"), ids.panel("bookmarks", FIX.MOVIE_SIMPLE), ids.panel("loc"),
      ids.panel("seasons", FIX.SERIAL_BIG, 1), ids.panel("setting", "audio"), ids.probe(), ids.probe("report:1"), ids.dev(),
      ids.playStart(FIX.MOVIE_SIMPLE),
    ];
    for (const rules of [[{ path: ".*", drop: true }], [{ path: "^/v1/", status: 502 }]]) {
      const t = await make({ loggedIn: true });
      t.mock.setScenario({ rules });
      check(t, await ask(t, screens));
      // Главная после срока ответа — «загрузка», ошибка приходит заменой экрана.
      await t.clock.advance(60_000);
      check(t, await ask(t, [ids.home()]));
      await search(t, "тест");
      assert.equal(t.ctx.state.search.status, "error");
      check(t, await ask(t, [ids.search()]));
    }

    const dead = await make({ loggedIn: true });
    dead.mock.setScenario({ refreshInvalid: true, rules: [{ path: "^/v1/", status: 401 }] });
    check(dead, await ask(dead, [ids.home(), ids.item(FIX.MOVIE_SIMPLE), ids.panel("loc"), ids.list(MOVIES)]));

    const bad = await make({ loggedIn: true });
    check(bad, await ask(bad, [
      "item:0", ids.item(999_999), ids.item(FIX.MOVIE_DELETED), "list:@@", ids.season(FIX.MOVIE_SIMPLE, 9),
      "panel:nope", "panel:sort:@@", ids.panel("audio", FIX.MOVIE_SIMPLE), ids.panel("setting", "nope"),
      ids.probe("flag:nope"), ids.probe("report:99"), ids.probe("nope"),
    ]));

    const noCode = await make();
    noCode.mock.setScenario({ rules: [{ path: "^/oauth2/device$", status: 500 }] });
    const failed = await ask(noCode, [ids.login(), ids.home()]);
    assert.match(JSON.stringify(failed.get(ids.login())), /Код: KP-/);
    check(noCode, failed);

    const offline = await make({ loggedIn: true, probe: () => Promise.reject(new Error("probe.js 404")) });
    check(offline, await ask(offline, [ids.probe(), ids.dev(), ids.probe("flag:heartbeat"), ids.probe("report:1")]));
  });

  it("menu: login, «Обновить меню» and both logouts redraw it by replace:menu with the menu flag, never reload:menu", async () => {
    const t = await make();
    t.mock.setScenario({ pendingPolls: 1 });
    const answers = await ask(t, [ids.init(), ids.login()]);
    await t.run(until(() => t.ctx.auth.isLoggedIn() && actions(t).some((a) => a.includes("replace:menu:"))));
    answers.set("login (done)", await t.request(ids.login()));
    t.app.handleData({ message: msgs.act("set", "logout") });
    await t.run(until(() => !t.ctx.auth.isLoggedIn()));
    await t.run(until(() => actions(t).filter((a) => a.includes("replace:menu:")).length === 2));

    const again = await make({ loggedIn: true });
    again.app.handleData({ message: msgs.act("probe", "logout") });
    await again.run(until(() => !again.ctx.auth.isLoggedIn() && actions(again).some((a) => a.includes("replace:menu:"))));

    check(t, answers);
    check(again, new Map());
    const done = answers.get("login (done)") as MsxContentRoot;
    assert.ok(requestsIn(done).includes(ids.init()), "«Обновить меню» on the done screen");
  });
});
