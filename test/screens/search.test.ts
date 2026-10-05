import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { SearchState } from "../../src/app/context.ts";
import type { MsxContentItem, MsxContentPage, MsxContentRoot } from "../../src/msx/types.ts";
import { ids } from "../../src/router/ids.ts";
import { LAYOUTS, keyboardPage } from "../../src/screens/keyboard.ts";
import { onSearchInput, searchScreen } from "../../src/screens/search.ts";
import { gridTemplate, posterTiles } from "../../src/screens/tiles.ts";
import { catalog } from "../../tools/kpmock/fixtures.ts";
import type { CallRecord } from "../../tools/kpmock/server.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

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

const st = (t: TestApp): SearchState => t.ctx.state.search;
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
const line = (s: MsxContentRoot): string | undefined => kb(s).items[0]?.headline;
const items = (s: MsxContentRoot): MsxContentItem[] => s.items ?? [];

/** Ждать в поддельном времени (через `t.run`), пока условие не выполнится. */
async function until(pred: () => boolean): Promise<void> {
  while (!pred()) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Пауза ввода: таймер 500 мс срабатывает, ответ API разобран. */
async function settle(t: TestApp): Promise<void> {
  await t.clock.advance(500);
  await t.run(until(() => st(t).status !== "loading" && (st(t) as { loading?: unknown }).loading === undefined));
}

describe("searchScreen (S7, CC-06)", () => {
  it("before input: the keyboard page alone, flag search, cache:false, no network", async () => {
    const t = await make();
    const s: MsxContentRoot = await t.request(ids.search());
    assert.deepEqual(s, {
      type: "list", compress: true, flag: "search", cache: false, reuse: false, headline: "Поиск",
      pages: [keyboardPage(t.ctx, st(t))],
    });
    assert.equal(line(s), "{ico:search} _ {col:msx-white-soft}· Наберите название");
    assert.equal(t.mock.calls().filter((c) => c.path.startsWith("/v1/")).length, 0);
    assert.equal(t.ctx.current.get(), "search");
  });

  it("«м», «а», «т» 100 ms apart → three reload:content at once, one GET 500 ms after the last letter, then reload", async () => {
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
    await t.clock.advance(499);
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
    assert.equal(line(s), "{ico:search} мат_ {col:msx-white-soft}· Ничего не найдено");
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
    assert.equal(line(s), "{ico:search} _ {col:msx-white-soft}· Минимум 2 символа");
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
    const labels = kb(s).items.filter((i) => i.type === "button" && i.layout?.endsWith(",1,1")).map((i) => i.label).join("");
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
    assert.ok(ms <= 50, `${ms.toFixed(1)} ms`);
    const { header, template, items: tiles, ...root } = s;
    assert.deepEqual(root, { type: "list", compress: true, flag: "search", cache: false, reuse: false, headline: "Поиск" });
    assert.deepEqual(header, keyboardPage(t.ctx, st(t)));
    assert.deepEqual(template, gridTemplate(t.ctx, "0,0,2,4"));
    assert.equal(tiles?.length, 48);
    assert.deepEqual(tiles?.map(({ live: _l, ...tile }) => tile), posterTiles(t.ctx, st(t).items));
    assert.deepEqual(tiles?.at(-1)?.live, EXTEND_LIVE);
    assert.equal(line(s), `{ico:search} фи_ {col:msx-white-soft}· Найдено: ${matches("фи")}`);
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
    assert.equal(items(s).length, 96);
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
    assert.equal(line(s), `{ico:search} фи_ {col:msx-white-soft}· Найдено: ${matches("фи")}, показаны первые 96 — уточните запрос`);
    assert.ok(Buffer.byteLength(JSON.stringify(s), "utf8") <= 32 * 1024);
    send(t, "extend:search");
    await t.clock.advance(1000);
    assert.equal(searches(t).filter((q) => q.get("page") === "3").length, 0);
  });

  it("96 results with long titles fit 32 KB: the tail is cut by MSX pages of 16 and the hint tells how many", async () => {
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
    assert.ok(n < 96 && n >= 16 && n % 16 === 0, `${n} tiles`);
    assert.equal(line(s), `{ico:search} фи_ {col:msx-white-soft}· Найдено: 500, показаны первые ${n} — уточните запрос`);
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
    assert.equal(line(s), "{ico:search} фи_ {col:msx-white-soft}· Нет связи с KinoPub. Проверьте VPN (KP-NET)");
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
    assert.equal(line(s), "{ico:search} фи_ {col:msx-white-soft}· Ищу…");
  });
});
