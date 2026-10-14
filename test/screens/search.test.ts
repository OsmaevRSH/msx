import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { persistState } from "../../src/app/context.ts";
import { contentAction } from "../../src/msx/actions.ts";
import { fmtCount } from "../../src/core/format.ts";
import type { MsxContentItem, MsxContentPage, MsxContentRoot } from "../../src/msx/types.ts";
import { ids } from "../../src/router/ids.ts";
import { LAYOUTS, keyboardPage } from "../../src/screens/keyboard.ts";
import type { SearchView } from "../../src/screens/keyboard.ts";
import { recentQueries, rememberQuery } from "../../src/screens/recent.ts";
import { onSearchInput, searchScreen } from "../../src/screens/search.ts";
import { gridTemplate, posterTiles } from "../../src/screens/tiles.ts";
import { catalog } from "../../tools/kpmock/fixtures.ts";
import type { CallRecord } from "../../tools/kpmock/server.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";
import { assertRealMs } from "../helpers/perf.ts";

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

/** Поиск открыт: он текущий экран, как после `content:request:interaction:search@P`. */
async function opened(): Promise<TestApp> {
  const t = await make();
  await t.request(ids.search());
  return t;
}

const SEARCH = "/v1/items/search";
const RELOAD = "reload:content";
const EXTEND_LIVE = { type: "setup", action: "interaction:commit:message:extend:search" };
const matches = (q: string): number => catalog().filter((it) => !it.deleted && it.title.toLowerCase().includes(q)).length;

const st = (t: TestApp): SearchView => t.ctx.state.search;
const send = (t: TestApp, msg: string): void => t.app.handleData({ message: msg });
const type = (t: TestApp, chars: string): void => {
  for (const ch of chars) send(t, `search:input:${ch}`);
};
const ctl = (t: TestApp, c: string): void => send(t, `search:control:${c}`);
const reloads = (t: TestApp): number => t.host.actions.filter((a) => a.action === RELOAD).length;
const searches = (t: TestApp): URLSearchParams[] =>
  t.mock.calls().filter((c: CallRecord) => c.path === SEARCH).map((c) => new URLSearchParams(c.query));
const kb = (s: MsxContentRoot): MsxContentPage => {
  const page = s.header ?? s.pages?.[0];
  assert.ok(page !== undefined, "keyboard page");
  return page;
};
/** V-28: поле запроса и подсказка справа от него — «<поле> | <подсказка>». */
const line = (s: MsxContentRoot): string => `${kb(s).items[0]?.headline ?? ""} | ${kb(s).items[1]?.text ?? ""}`;
const items = (s: MsxContentRoot): MsxContentItem[] => s.items ?? [];

/** Ждать в поддельном времени (через `t.run`), пока условие не выполнится. */
async function until(pred: () => boolean): Promise<void> {
  while (!pred()) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Пауза ввода: таймер 300 мс срабатывает, ответ API разобран. */
async function settle(t: TestApp): Promise<void> {
  await t.clock.advance(500);
  await t.run(until(() => st(t).status !== "loading" && (st(t) as { loading?: unknown }).loading === undefined));
}

describe("searchScreen (S7, CC-06)", () => {
  it("before input: the keyboard page alone, flag search, cache:false, no network", async () => {
    const t = await make();
    const s: MsxContentRoot = await t.request(ids.search());
    assert.deepEqual(s, {
      type: "list", compress: true, flag: "search", cache: false, reuse: false, preload: "next", headline: "Поиск",
      pages: [keyboardPage(t.ctx, st(t))],
    });
    assert.equal(line(s), "{ico:search} _ | Наберите название");
    assert.equal(t.mock.calls().filter((c) => c.path.startsWith("/v1/")).length, 0);
    assert.equal(t.ctx.current.get(), "search");
  });

  it("«м», «а», «т» 100 ms apart → three reload:content at once, one GET 300 ms after the last letter, then reload", async () => {
    const t = await opened();
    type(t, "м");
    assert.equal(reloads(t), 1);
    assert.equal(st(t).status, "short");
    await t.clock.advance(100);
    type(t, "а");
    assert.equal(reloads(t), 2);
    assert.equal(st(t).status, "loading");
    await t.clock.advance(100);
    type(t, "т");
    assert.deepEqual([reloads(t), st(t).query], [3, "мат"]);
    await t.clock.advance(299);
    assert.equal(searches(t).length, 0);
    await t.clock.advance(1);
    await t.run(until(() => st(t).status !== "loading"));
    const q = searches(t);
    assert.equal(q.length, 1);
    assert.deepEqual([q[0].get("q"), q[0].get("field"), q[0].get("page"), q[0].get("perpage")], ["мат", "title", "1", "48"]);
    assert.equal(reloads(t), 4);
    assert.equal(t.host.actions.at(-1)?.action, RELOAD);
  });

  it("an empty result → «Ничего не найдено» in the input row, keyboard only", async () => {
    const t = await opened();
    type(t, "мат");
    await settle(t);
    assert.equal(matches("мат"), 0);
    assert.equal(st(t).status, "empty");
    const s: MsxContentRoot = await t.request(ids.search());
    assert.equal(line(s), "{ico:search} мат_ | Ничего не найдено");
    assert.equal(s.items, undefined);
    assert.equal(s.template, undefined);
    assert.equal(s.pages?.length, 1);
  });

  it("«⌫» → «ма»; «Очистить» → empty query, status short, no request", async () => {
    const t = await opened();
    type(t, "мат");
    ctl(t, "back");
    assert.equal(st(t).query, "ма");
    ctl(t, "clear");
    assert.deepEqual([st(t).query, st(t).status], ["", "short"]);
    assert.equal(reloads(t), 5);
    await t.clock.advance(2000);
    assert.equal(searches(t).length, 0);
    const s: MsxContentRoot = await t.request(ids.search());
    assert.equal(line(s), "{ico:search} _ | Наберите название", "V-29: an empty field always asks to type");
  });

  it("one letter → short, no request", async () => {
    const t = await opened();
    type(t, "ф");
    await t.clock.advance(2000);
    assert.equal(st(t).status, "short");
    assert.equal(searches(t).length, 0);
  });

  it("«RU/EN» → Latin keyboard, the query is kept; digit «1» from the remote → «1» in the query", async () => {
    const t = await opened();
    type(t, "те");
    const seq = st(t).seq;
    ctl(t, "lang");
    assert.equal(st(t).lang, "en");
    assert.equal(st(t).seq, seq);
    assert.equal(reloads(t), 3);
    const s: MsxContentRoot = await t.request(ids.search());
    // Клавиши — кнопки из шаблона страницы, без своего `type`; стражи — с `selection`.
    const labels = kb(s).items.filter((i) => i.type === undefined && i.selection === undefined && i.layout?.endsWith(",1,1")).map((i) => i.label).join("");
    assert.equal(labels, `${LAYOUTS.en}1234567890`);
    // Кнопка цифры с key "1": клавиша пульта выполняет то же действие.
    const one = kb(s).items.find((i) => i.key === "1");
    assert.equal(one?.action, "interaction:commit:message:search:input:1");
    send(t, "search:input:1");
    assert.equal(st(t).query, "те1");
    ctl(t, "lang");
    assert.equal(st(t).lang, "ru");
  });

  it("results arrive after leaving to item:1 → no reload; back to search: results from memory, no network (CE-06)", async () => {
    const t = await opened();
    type(t, "фи");
    t.ctx.current.onRequest(ids.item(1));
    t.host.clearActions();
    await settle(t);
    assert.equal(reloads(t), 0);
    assert.equal(st(t).status, "ready");
    assert.equal(st(t).items.length, 48);
    const before = t.mock.calls().length;
    const t0 = performance.now();
    const s = (await t.app.handleRequest(ids.search(), {})) as MsxContentRoot;
    const ms = performance.now() - t0;
    assert.equal(t.mock.calls().length, before);
    assertRealMs(ms, 50, "search from memory");
    const { header, template, items: tiles, inserts, ...root } = s;
    assert.deepEqual(root, {
      type: "list", compress: true, flag: "search", cache: false, reuse: false, preload: "next", headline: "Поиск",
      extension: `{ico:search} «фи» · ${fmtCount(matches("фи"), ["результат", "результата", "результатов"])}`,
    });
    assert.deepEqual(header, keyboardPage(t.ctx, st(t)));
    // Корень сжат ради клавиатуры 16×8, плитки — те же, что в каталоге (12×6, `decompress`).
    assert.deepEqual(template, gridTemplate(t.ctx, true));
    assert.equal(tiles?.length, 48);
    const expected = posterTiles(t.ctx, st(t).items);
    expected[42] = { ...expected[42], break: "context:end" };
    assert.deepEqual(tiles?.map(({ live: _l, ...tile }) => tile), expected);
    // Под последним рядом — стражи в сетке корня 16×8 (над первым — клавиатура): «вниз» на краю не уводит наверх.
    assert.deepEqual(inserts?.map((p) => [p.position, p.decompress, p.items.map((g) => g.layout)]), [
      ["context:end", true, ["0,5,3,1", "3,5,3,1", "5,5,3,1", "8,5,3,1", "11,5,3,1", "13,5,3,1"]],
    ]);
    assert.deepEqual(tiles?.at(-1)?.live, EXTEND_LIVE);
    assert.equal(line(s), `{ico:search} фи_ | Найдено: ${matches("фи")}`);
    assert.equal(t.ctx.current.get(), "search");
  });

  it("the screen JSON with 48 results fits 32 KB (CNFR-16)", async () => {
    const t = await opened();
    type(t, "тест");
    await settle(t);
    const s = await t.request(ids.search());
    assert.equal(items(s).length, 48);
    assert.ok(Buffer.byteLength(JSON.stringify(s), "utf8") <= 32 * 1024);
  });
});

describe("searchScreen: the input field and the results (V-09, V-25, V-28)", () => {
  it("results start on the next MSX page: the keyboard page fills all 8 rows and points down", async () => {
    const t = await opened();
    type(t, "фи");
    await settle(t);
    const s: MsxContentRoot = await t.request(ids.search());
    const rows = Math.max(...kb(s).items.map((i) => { const [, y, , h] = (i.layout ?? "").split(",").map(Number); return y + h; }));
    assert.equal(rows, 8);
    assert.deepEqual(kb(s).items.at(-1), { type: "space", layout: "0,7,16,1", text: "{ico:arrow-downward} Результаты ниже" });
  });

  it("no results — no extension and no pointer", async () => {
    const t = await opened();
    type(t, "мат");
    await settle(t);
    const s: MsxContentRoot = await t.request(ids.search());
    assert.equal(s.extension, undefined);
    assert.ok(kb(s).items.every((i) => i.layout !== "0,7,16,1"));
  });
});

describe("onSearchInput (spec §3.4, §6.3)", () => {
  it("extend:search → 96 results and reload:content while search is current", async () => {
    const t = await opened();
    type(t, "фи");
    await settle(t);
    t.host.clearActions();
    send(t, "extend:search");
    await t.run(until(() => reloads(t) > 0));
    assert.equal(st(t).items.length, 96);
    assert.equal(new Set(st(t).items.map((i) => i.id)).size, 96);
    assert.deepEqual(searches(t).map((q) => q.get("page")), ["1", "2"]);
    const s: MsxContentRoot = await t.request(ids.search());
    // Клавиатура и 96 плиток с полным названием для шапки (V-10) больше 32 КБ: последние ряды отрезает предохранитель.
    assert.equal(items(s).length, 72);
    assert.ok(Buffer.byteLength(JSON.stringify(s), "utf8") <= 32 * 1024);
  });

  it("results stop at 96 (CNFR-16): no live, no third page, the hint says to refine the query", async () => {
    const t = await opened();
    type(t, "фи");
    await settle(t);
    send(t, "extend:search");
    await t.run(until(() => st(t).items.length === 96 && (st(t) as { loading?: unknown }).loading === undefined));
    assert.ok(matches("фи") > 96);
    assert.equal(st(t).done, true);
    const s: MsxContentRoot = await t.request(ids.search());
    assert.ok(items(s).every((i) => i.live === undefined));
    assert.equal(line(s), `{ico:search} фи_ | Найдено: ${matches("фи")}, показаны первые ${items(s).length} — уточните запрос`);
    assert.ok(Buffer.byteLength(JSON.stringify(s), "utf8") <= 32 * 1024);
    send(t, "extend:search");
    await t.clock.advance(1000);
    assert.equal(searches(t).filter((q) => q.get("page") === "3").length, 0);
  });

  it("96 results with long titles fit 32 KB: the tail is cut by rows of 6 and the hint tells how many", async () => {
    const t = await opened();
    type(t, "фи");
    await settle(t);
    const base = st(t).items[0];
    assert.ok(base !== undefined);
    const long = (i: number) => ({ ...base, id: 900_000 + i, title: `${"Очень длинное русское название ".repeat(3)}${i} / Original ${i}` });
    Object.assign(st(t), { items: Array.from({ length: 96 }, (_, i) => long(i)), done: true, total: 500 });
    const s: MsxContentRoot = await t.request(ids.search());
    const n = items(s).length;
    assert.ok(Buffer.byteLength(JSON.stringify(s), "utf8") <= 32 * 1024);
    assert.ok(n < 96 && n >= 6 && n % 6 === 0, `${n} tiles`);
    assert.equal(line(s), `{ico:search} фи_ | Найдено: 500, показаны первые ${n} — уточните запрос`);
  });

  it("extend while another screen is current → appended in memory, no reload", async () => {
    const t = await opened();
    type(t, "фи");
    await settle(t);
    t.ctx.current.onRequest(ids.item(1));
    t.host.clearActions();
    onSearchInput(t.ctx, { k: "extend", key: "search" });
    await t.run(until(() => st(t).items.length === 96));
    assert.equal(reloads(t), 0);
  });

  it("to the end of the results: the last short page finishes, no live, extend does nothing more", async () => {
    const t = await opened();
    type(t, "концерт");
    await settle(t);
    assert.equal(matches("концерт"), 30);
    assert.equal(st(t).done, true);
    const s: MsxContentRoot = await t.request(ids.search());
    assert.ok(items(s).every((i) => i.live === undefined));
    send(t, "extend:search");
    await t.clock.advance(1000);
    assert.equal(searches(t).length, 1);
  });

  it("concurrent extends load one page", async () => {
    const t = await opened();
    type(t, "фи");
    await settle(t);
    send(t, "extend:search");
    send(t, "extend:search");
    await t.run(until(() => st(t).items.length === 96));
    await t.clock.advance(1000);
    assert.equal(searches(t).filter((q) => q.get("page") === "2").length, 1);
    assert.equal(st(t).items.length, 96);
  });

  it("a stale answer is dropped: typing on while the request is in flight searches again", async () => {
    const t = await opened();
    t.mock.setScenario({ delayMs: 50 });
    type(t, "фи");
    await t.clock.advance(500);
    // Запрос «фи» дошёл до mock и ждёт ответа 50 мс реального времени — ввод продолжается.
    await t.run(until(() => searches(t).length === 1));
    type(t, "л");
    assert.equal(st(t).status, "loading");
    await settle(t);
    assert.deepEqual(searches(t).map((q) => q.get("q")), ["фи", "фил"]);
    assert.equal(reloads(t), 4);
    assert.equal(st(t).query, "фил");
    assert.equal(st(t).status, "ready");
    assert.ok(st(t).items.every((it) => it.title.toLowerCase().includes("фил")));
  });

  it("a network failure → status error with the KP-NET text, then reload", async () => {
    const t = await opened();
    // Обрыв на всех путях: при живом /v1/types транспорт счёл бы это ответом без CORS (KP-429).
    t.mock.setScenario({ rules: [{ path: ".*", drop: true }] });
    type(t, "фи");
    await settle(t);
    assert.deepEqual([st(t).status, st(t).error], ["error", "KP-NET"]);
    assert.equal(t.host.actions.at(-1)?.action, RELOAD);
    const s: MsxContentRoot = await t.request(ids.search());
    assert.equal(line(s), "{ico:search} фи_ | Нет связи с KinoPub. Проверьте VPN (KP-NET)");
    assert.equal(s.items, undefined);
  });

  it("space: not leading, not doubled; a trailing space keeps the results without a new request", async () => {
    const t = await opened();
    ctl(t, "space");
    assert.deepEqual([st(t).query, reloads(t)], ["", 0]);
    type(t, "фи");
    await settle(t);
    const n = reloads(t);
    ctl(t, "space");
    ctl(t, "space");
    assert.equal(st(t).query, "фи ");
    assert.equal(reloads(t), n + 1);
    assert.deepEqual([st(t).status, st(t).items.length], ["ready", 48]);
    await t.clock.advance(1000);
    assert.equal(searches(t).length, 1);
  });

  it("at most 32 characters; unknown or multi-character input is ignored without a redraw", async () => {
    const t = await opened();
    type(t, "а".repeat(40));
    assert.equal(st(t).query, "а".repeat(32));
    assert.equal(reloads(t), 32);
    ctl(t, "clear");
    for (const bad of ["{", "ab", "A", "_", "%"]) send(t, `search:input:${bad}`);
    assert.equal(st(t).query, "");
    assert.equal(reloads(t), 33);
  });

  it("«⌫» and «Очистить» on an empty query change nothing and do not redraw", async () => {
    const t = await opened();
    ctl(t, "back");
    ctl(t, "clear");
    assert.deepEqual([st(t).query, st(t).status, reloads(t)], ["", "idle", 0]);
  });

  it("searchScreen itself never touches the network", async () => {
    const t = await make();
    type(t, "фи");
    const before = t.mock.calls().length;
    const s = await searchScreen(t.ctx);
    assert.equal(t.mock.calls().length, before);
    assert.equal(line(s), "{ico:search} фи_ | Ищу…");
  });
});

const col = (s: MsxContentRoot): MsxContentItem[] => kb(s).items.filter((i) => /^s\d$/.test(i.id ?? ""));
const recentOf = (t: TestApp): string[] => recentQueries(t.ctx.store);
/** Пауза ввода между буквами — дольше 300 мс: каждая строка ищется. */
async function typeSlow(t: TestApp, chars: string): Promise<void> {
  for (const ch of chars) {
    type(t, ch);
    await settle(t);
  }
}

describe("suggestions while typing (S7): the first 6 titles of the same answer", () => {
  it("one GET per pause gives both the column and the grid: 6 suggestions = the first 6 results", async () => {
    const t = await opened();
    type(t, "тест");
    await settle(t);
    assert.equal(searches(t).length, 1);
    const s: MsxContentRoot = await t.request(ids.search());
    const first6 = st(t).items.slice(0, 6);
    assert.deepEqual(col(s).map((i) => i.action), first6.map((it) => contentAction(TEST_P, ids.item(it.id))));
    assert.deepEqual(items(s).slice(0, 6).map((i) => i.kid), first6.map((it) => String(it.id)));
    assert.equal(searches(t).length, 1, "the screen itself asks nothing");
  });

  it("typing on: the grid goes at once (a light redraw), the suggestions stay until the new answer replaces them", async () => {
    const t = await opened();
    type(t, "тес");
    await settle(t);
    const before = col(await t.request(ids.search())).map((i) => i.label);
    type(t, "т");
    assert.equal(st(t).status, "loading");
    const typing: MsxContentRoot = await t.request(ids.search());
    assert.equal(typing.items, undefined, "no grid while the new query is searched");
    assert.deepEqual(col(typing).map((i) => i.label), before);
    assert.ok(Buffer.byteLength(JSON.stringify(typing), "utf8") <= 8 * 1024);
    await settle(t);
    assert.deepEqual(searches(t).map((q) => q.get("q")), ["тес", "тест"]);
    assert.deepEqual(col(await t.request(ids.search())).length, 6);
  });

  it("a 5-letter word typed with pauses: one GET per prefix from 2 letters, perpage 48 page 1 — nothing else", async () => {
    const t = await opened();
    await typeSlow(t, "тесто");
    assert.deepEqual(searches(t).map((q) => [q.get("q"), q.get("page"), q.get("perpage"), q.get("field")]), [
      ["те", "1", "48", "title"], ["тес", "1", "48", "title"], ["тест", "1", "48", "title"], ["тесто", "1", "48", "title"],
    ]);
    assert.equal(t.mock.calls().filter((c) => c.path.startsWith("/v1/items")).length, 4);
  });

  it("erasing back to an already found query answers from the cache: no pause, no request, one redraw with results", async () => {
    const t = await opened();
    await typeSlow(t, "тест");
    const n = searches(t).length;
    t.host.clearActions();
    ctl(t, "back");
    assert.deepEqual([st(t).query, st(t).status, st(t).timer], ["тес", "ready", undefined]);
    assert.equal(reloads(t), 1);
    const s: MsxContentRoot = await t.request(ids.search());
    assert.equal(col(s).length, 6);
    assert.ok(items(s).length > 0);
    await t.clock.advance(1000);
    assert.equal(searches(t).length, n);
  });

  it("below 2 letters the suggestions go; an empty field shows the recent queries instead", async () => {
    const t = await opened();
    rememberQuery(t.ctx.store, "матрица");
    type(t, "те");
    await settle(t);
    ctl(t, "back");
    assert.equal(st(t).hints, undefined);
    assert.deepEqual(col(await t.request(ids.search())), []);
    ctl(t, "back");
    assert.deepEqual(col(await t.request(ids.search())).map((i) => i.label), ["матрица"]);
  });

  it("nothing found or an error — no suggestions", async () => {
    const t = await opened();
    type(t, "мат");
    await settle(t);
    assert.deepEqual([st(t).status, st(t).hints], ["empty", []]);
    type(t, "фи".slice(0, 0));
    ctl(t, "clear");
    t.mock.setScenario({ rules: [{ path: ".*", drop: true }] });
    type(t, "фи");
    await settle(t);
    assert.deepEqual([st(t).status, st(t).hints], ["error", undefined]);
    assert.deepEqual(col(await t.request(ids.search())), []);
  });

  it("a stale answer never becomes the suggestions of a newer query", async () => {
    const t = await opened();
    t.mock.setScenario({ delayMs: 50 });
    type(t, "фи");
    await t.clock.advance(300);
    await t.run(until(() => searches(t).length === 1));
    type(t, "л");
    await settle(t);
    assert.ok((st(t).hints ?? []).length > 0);
    assert.ok((st(t).hints ?? []).every((it) => it.title.toLowerCase().includes("фил")));
  });
});

describe("recent queries (S7, kp.cfg.recent)", () => {
  it("opening a title from search (a suggestion or a tile) remembers the query, trimmed; from elsewhere — nothing", async () => {
    const t = await opened();
    type(t, "тест");
    ctl(t, "space");
    await settle(t);
    const s: MsxContentRoot = await t.request(ids.search());
    const action = col(s)[0]?.action ?? "";
    await t.request(action.slice("content:request:interaction:".length, -`@${TEST_P}`.length));
    assert.deepEqual(recentOf(t), ["тест"]);
    await t.request(ids.item(1001));
    assert.deepEqual(recentOf(t), ["тест"], "item → item is not a search");
    await t.request(ids.home());
    await t.request(ids.search());
    ctl(t, "clear");
    type(t, "фи");
    await settle(t);
    await t.request(ids.item(Number(items(await t.request(ids.search()))[0]?.kid)));
    assert.deepEqual(recentOf(t), ["фи", "тест"]);
  });

  it("a one-letter query is not remembered", async () => {
    const t = await opened();
    type(t, "ф");
    await t.request(ids.item(1000));
    assert.deepEqual(recentOf(t), []);
  });

  it("OK on a recent query: it goes into the field and is searched at once; the column keeps the recent rows until the answer", async () => {
    const t = await opened();
    for (const q of ["фил", "тест"]) rememberQuery(t.ctx.store, q);
    t.host.clearActions();
    send(t, "search:recent:1");
    assert.deepEqual([st(t).query, st(t).status, reloads(t)], ["фил", "loading", 1]);
    const waiting: MsxContentRoot = await t.request(ids.search());
    assert.equal(line(waiting), "{ico:search} фил_ | Ищу…");
    assert.deepEqual(col(waiting).map((i) => [i.id, i.label]), [["s0", "тест"], ["s1", "фил"]], "same rows: the focus stays");
    await t.clock.advance(0);
    await t.run(until(() => st(t).status !== "loading"));
    assert.deepEqual(searches(t).map((q) => q.get("q")), ["фил"]);
    assert.equal(reloads(t), 2);
    const s: MsxContentRoot = await t.request(ids.search());
    assert.equal(col(s).length, 6);
    assert.equal(col(s)[0]?.icon === "history", false);
  });

  it("a recent query found less than 5 min ago — straight from the cache, no request", async () => {
    const t = await opened();
    await typeSlow(t, "тест");
    await t.request(ids.item(Number(st(t).items[0]?.id)));
    await t.request(ids.search());
    ctl(t, "clear");
    const n = searches(t).length;
    t.host.clearActions();
    send(t, "search:recent:0");
    assert.deepEqual([st(t).query, st(t).status, reloads(t)], ["тест", "ready", 1]);
    await t.clock.advance(1000);
    assert.equal(searches(t).length, n);
  });

  it("a row number past the list does nothing", async () => {
    const t = await opened();
    rememberQuery(t.ctx.store, "тест");
    send(t, "search:recent:3");
    assert.deepEqual([st(t).query, reloads(t)], ["", 0]);
  });

  it("«Очистить историю»: the red button of the screen options, then the empty column; no options without recent queries", async () => {
    const t = await opened();
    const empty: MsxContentRoot = await t.request(ids.search());
    assert.equal(empty.options, undefined);
    rememberQuery(t.ctx.store, "тест");
    const s: MsxContentRoot = await t.request(ids.search());
    assert.deepEqual(s.options, {
      headline: "Поиск", template: { type: "control", layout: "0,0,8,1" },
      items: [{ icon: "delete", label: "Очистить историю", key: "red", action: "[cleanup|interaction:commit:message:search:control:forget]" }],
    });
    t.host.clearActions();
    ctl(t, "forget");
    assert.deepEqual(recentOf(t), []);
    assert.equal(reloads(t), 1);
    const after: MsxContentRoot = await t.request(ids.search());
    assert.deepEqual([col(after), after.options], [[], undefined]);
  });

  it("with a query typed the options are gone (the column shows suggestions, not the history)", async () => {
    const t = await opened();
    rememberQuery(t.ctx.store, "тест");
    type(t, "фи");
    const s: MsxContentRoot = await t.request(ids.search());
    assert.equal(s.options, undefined);
  });

  it("logout forgets the recent queries", async () => {
    const t = await opened();
    rememberQuery(t.ctx.store, "тест");
    await t.run(t.ctx.auth.logout());
    assert.deepEqual(recentOf(t), []);
  });

  it("the log never carries the query text: typing, results, opening a title, a recent query, clearing", async () => {
    const t = await opened();
    await typeSlow(t, "тест");
    send(t, "extend:search");
    await t.run(until(() => st(t).items.length > 48));
    await t.request(ids.item(Number(st(t).items[0]?.id)));
    await t.request(ids.search());
    ctl(t, "clear");
    send(t, "search:recent:0");
    await settle(t);
    ctl(t, "clear");
    ctl(t, "forget");
    persistState(t.ctx, true);
    const logs = JSON.stringify(t.ctx.log.entries());
    for (const q of ["тест", "тес", "те"]) assert.ok(!logs.includes(q), `«${q}» in the log`);
    assert.ok(logs.includes("\"recent\"") && logs.includes("recent_cleared"), "the events are logged, without the text");
    const stored = JSON.stringify(t.ctx.store.get("l2", "log"));
    assert.ok(!stored.includes("тест"));
  });
});
