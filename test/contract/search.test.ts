import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MsxContentItem, MsxContentPage, MsxContentRoot } from "../../src/msx/types.ts";
import { ids } from "../../src/router/ids.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";
import { commit, follow, until } from "./rig.ts";

// Поиск S7 с подсказками против kpmock (спец. §11 S7, §14.3): плагин ведётся только действиями из своих ответов, как
// MSX, а трафик считается по журналу mock. Подсказки и сетка — из одного ответа: на строку не больше одного запроса.

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

const SEARCH = "/v1/items/search";

async function opened(): Promise<TestApp> {
  const t = await createTestApp({ loggedIn: true });
  apps.push(t);
  await t.request(ids.search());
  return t;
}

const kb = (s: MsxContentRoot): MsxContentPage => s.header ?? (s.pages?.[0] as MsxContentPage);
const keyOf = (s: MsxContentRoot, label: string): MsxContentItem => {
  const it = kb(s).items.find((i) => i.label === label || i.id === label);
  assert.ok(it !== undefined, `no key ${label}`);
  return it;
};
const col = (s: MsxContentRoot): MsxContentItem[] => kb(s).items.filter((i) => /^s\d$/.test(i.id ?? ""));
const queries = (t: TestApp): string[] => t.mock.calls().filter((c) => c.path === SEARCH).map((c) => new URLSearchParams(c.query).get("q") ?? "");
const apiCalls = (t: TestApp): string[] => t.mock.calls().filter((c) => c.path.startsWith("/v1/")).map((c) => c.path);

/** Нажать клавишу экрана и, как MSX после `reload:content`, запросить экран заново. */
async function press(t: TestApp, s: MsxContentRoot, label: string): Promise<MsxContentRoot> {
  commit(t, keyOf(s, label).action);
  return t.request(ids.search());
}

/** Пауза пульта `ms` в поддельном времени, ответ mock разобран, экран перерисован. */
async function pause(t: TestApp, ms: number): Promise<MsxContentRoot> {
  await t.clock.advance(ms);
  await t.run(until(() => t.ctx.state.search.status !== "loading"));
  return t.request(ids.search());
}

describe("search with suggestions against kpmock: no extra requests", () => {
  it("«тест» with pauses: «те», «тес», «тест» — one GET each; the suggestions and the grid share it", async () => {
    const t = await opened();
    let s: MsxContentRoot = await t.request(ids.search());
    for (const ch of "тест") {
      s = await press(t, s, ch);
      s = await pause(t, 400);
    }
    assert.deepEqual(queries(t), ["те", "тес", "тест"]);
    assert.equal(col(s).length, 6);
    assert.equal(s.items?.length, 48);
    assert.deepEqual(apiCalls(t), [SEARCH, SEARCH, SEARCH]);
  });

  it("fast typing (keys under 300 ms apart) — one GET for the whole word", async () => {
    const t = await opened();
    let s: MsxContentRoot = await t.request(ids.search());
    for (const ch of "тест") {
      s = await press(t, s, ch);
      await t.clock.advance(150);
    }
    s = await pause(t, 300);
    assert.deepEqual(queries(t), ["тест"]);
    assert.equal(col(s).length, 6);
  });

  it("suggestion → card → back → «Стереть» → «Очистить» → the recent query: no search is asked twice", async () => {
    const t = await opened();
    let s: MsxContentRoot = await t.request(ids.search());
    for (const ch of "тест") s = await press(t, s, ch);
    s = await pause(t, 300);
    const before = apiCalls(t).length;
    const item = follow(col(s)[0]?.action, "content");
    await t.request(item);
    assert.deepEqual(apiCalls(t).slice(before, before + 1), [`/v1/items/${item.slice("item:".length)}`]);
    const shown = JSON.stringify(s);
    s = await t.request(ids.search());
    assert.equal(JSON.stringify(s), shown, "back: the same screen from memory");
    s = await press(t, s, "k_back");
    s = await pause(t, 300);
    assert.deepEqual(queries(t), ["тест", "тес"], "«тес» was never asked before");
    s = await press(t, s, "k_back");
    s = await press(t, s, "k_back");
    s = await press(t, s, "k_back");
    assert.deepEqual(col(s).map((i) => i.label), ["тест"]);
    commit(t, col(s)[0]?.action);
    s = await t.request(ids.search());
    assert.equal(t.ctx.state.search.status, "ready");
    assert.equal(col(s).length, 6);
    await t.clock.advance(1000);
    assert.deepEqual(queries(t), ["тест", "тес"], "the recent «тест» — from the cache");
  });
});
