import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ItemSummary } from "../../src/api/models.ts";
import type { ListState } from "../../src/app/context.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { encodeListKey, ids } from "../../src/router/ids.ts";
import { MAX_BYTES, WINDOW, onExtend } from "../../src/screens/list.ts";
import { ROW, posterTiles } from "../../src/screens/tiles.ts";
import { catalog } from "../../tools/kpmock/fixtures.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

// Окно ответа списка (CNFR-16, этап 21b): после любых догрузок ответ ≤ 32 КБ и ≤ 96 плиток, края окна двигают его
// на 48 плиток, а плитки у края пользователя остаются в ответе (MSX держит фокус по `id` при `reload:content`).

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

const MOVIES = encodeListKey({ src: "catalog", type: "movie", sort: "-updated" });
const EXTEND = "interaction:commit:message:extend:";
const visible = (type: string): number => catalog().filter((it) => !it.deleted && it.type === type).length;
const items = (s: MsxContentRoot): MsxContentItem[] => s.items ?? [];
const actions = (t: TestApp): string[] => t.host.actions.map((a) => a.action);
const live = (key: string, dir: "down" | "up", at: number): MsxContentItem["live"] =>
  ({ type: "setup", action: `${EXTEND}${key}:${dir}:${at}` });
const pageCalls = (t: TestApp, page: number): number =>
  t.mock.calls().filter((c) => c.path === "/v1/items" && new URLSearchParams(c.query).get("page") === String(page)).length;
const state = (t: TestApp, key: string): ListState & { from: number; to: number } => {
  const st = t.ctx.state.lists.get(key);
  assert.ok(st !== undefined, "list state");
  return st as ListState & { from: number; to: number };
};

describe("list response window (CNFR-16)", () => {
  const bytes = (s: MsxContentRoot): number => Buffer.byteLength(JSON.stringify(s), "utf8");
  const tileIds = (s: MsxContentRoot): string[] => items(s).map((i) => i.id ?? "");
  const slice = (st: ListState, from: number, to: number): string[] => st.items.slice(from, to).map((it) => `i${it.id}`);

  /** Как MSX: выполнить live `setup` плитки края — сообщение уходит в `onExtend`. */
  async function fire(t: TestApp, tile: MsxContentItem | undefined): Promise<void> {
    const action = tile?.live?.action ?? "";
    assert.ok(action.startsWith(EXTEND), `no edge on ${tile?.id}`);
    await t.run(onExtend(t.ctx, action.slice(EXTEND.length)));
  }

  /** Ответ — непрерывный кусок списка без повторов, ≤ 32 КБ и ≤ 96 плиток; края — по положению окна. */
  function windowOf(t: TestApp, key: string, s: MsxContentRoot): { from: number; to: number } {
    const st = state(t, key);
    const got = tileIds(s);
    assert.ok(bytes(s) <= MAX_BYTES, `${bytes(s)} B`);
    assert.ok(got.length <= WINDOW, `${got.length} tiles`);
    assert.equal(new Set(got).size, got.length);
    assert.deepEqual(got, slice(st, st.from, st.to));
    assert.equal(st.from % ROW, 0);
    const end = st.to === st.items.length && st.done;
    assert.deepEqual(items(s)[0]?.live, st.from > 0 ? live(key, "up", st.from) : undefined);
    if (got.length > 1) assert.deepEqual(items(s).at(-1)?.live, end ? undefined : live(key, "down", st.to));
    assert.equal(items(s).slice(1, -1).filter((i) => i.live !== undefined).length, 0);
    return { from: st.from, to: st.to };
  }

  it("4 extends to the end (203 tiles): every answer ≤ 32 KB and ≤ 96 tiles, no repeats, each page once", async () => {
    const t = await make();
    let s = await t.request(ids.list(MOVIES));
    const seen = new Set<string>();
    const spans = [windowOf(t, MOVIES, s)];
    tileIds(s).forEach((id) => seen.add(id));
    for (let i = 0; i < 4; i++) {
      await fire(t, items(s).at(-1));
      s = await t.request(ids.list(MOVIES));
      spans.push(windowOf(t, MOVIES, s));
      tileIds(s).forEach((id) => seen.add(id));
    }
    const total = visible("movie");
    assert.equal(total, 203);
    // Начало окна кратно ряду из 6 плиток: при сдвиге плитки не меняют колонку.
    assert.deepEqual(spans, [{ from: 0, to: 48 }, { from: 0, to: 96 }, { from: 48, to: 144 }, { from: 96, to: 192 }, { from: 108, to: 203 }]);
    assert.equal(seen.size, total);
    assert.equal(state(t, MOVIES).done, true);
    for (let p = 1; p <= 5; p++) assert.equal(pageCalls(t, p), 1, `page ${p}`);
    assert.equal(actions(t).filter((a) => a === "reload:content").length, 4);
  });

  it("focus and continuation: the edge tile and 47 before it stay, the next 48 follow it", async () => {
    const t = await make();
    let s = await t.request(ids.list(MOVIES));
    await fire(t, items(s).at(-1));
    s = await t.request(ids.list(MOVIES));
    const before = tileIds(s);
    await fire(t, items(s).at(-1));
    const after = await t.request(ids.list(MOVIES));
    const got = tileIds(after);
    const at = got.indexOf(before.at(-1) ?? "");
    assert.equal(at, 47);
    assert.deepEqual(got.slice(0, at + 1), before.slice(-48));
    assert.deepEqual(got.slice(at + 1), slice(state(t, MOVIES), 96, 144));
    assert.deepEqual(actions(t), ["reload:content", "reload:content"]);
  });

  it("scrolling back: up shows the previous 48 from memory keeping the head tile; down returns without the network", async () => {
    const t = await make();
    await t.request(ids.list(MOVIES));
    const st = state(t, MOVIES);
    while (!st.done) await t.run(onExtend(t.ctx, MOVIES));
    let s = await t.request(ids.list(MOVIES));
    assert.deepEqual(windowOf(t, MOVIES, s), { from: 108, to: 203 });
    const head = items(s)[0]?.id;
    const calls = t.mock.calls().length;
    t.host.actions.length = 0;

    await fire(t, items(s)[0]);
    s = await t.request(ids.list(MOVIES));
    assert.deepEqual(windowOf(t, MOVIES, s), { from: 60, to: 156 });
    assert.equal(tileIds(s).indexOf(head ?? ""), 48);
    await fire(t, items(s)[0]);
    s = await t.request(ids.list(MOVIES));
    assert.deepEqual(windowOf(t, MOVIES, s), { from: 12, to: 108 });
    await fire(t, items(s)[0]);
    s = await t.request(ids.list(MOVIES));
    assert.deepEqual(windowOf(t, MOVIES, s), { from: 0, to: 96 });

    await fire(t, items(s).at(-1));
    s = await t.request(ids.list(MOVIES));
    assert.deepEqual(windowOf(t, MOVIES, s), { from: 48, to: 144 });
    assert.equal(t.mock.calls().length, calls);
    assert.deepEqual(actions(t), Array(4).fill("reload:content"));
  });

  it("a repeated or malformed edge message changes nothing", async () => {
    const t = await make();
    let s = await t.request(ids.list(MOVIES));
    await fire(t, items(s).at(-1));
    s = await t.request(ids.list(MOVIES));
    const stale = items(s).at(-1);
    await fire(t, stale);
    s = await t.request(ids.list(MOVIES));
    assert.deepEqual(windowOf(t, MOVIES, s), { from: 48, to: 144 });
    const calls = t.mock.calls().length;
    const reloads = actions(t).length;
    for (const m of [`${MOVIES}:down:96`, `${MOVIES}:down:48`, `${MOVIES}:up:0`, `${MOVIES}:up:96`, `${MOVIES}:down:x`,
      `${MOVIES}:sideways:48`, `${MOVIES}:up:48:1`, `${MOVIES}:up`]) {
      await t.run(onExtend(t.ctx, m));
    }
    await fire(t, stale);
    assert.equal(t.mock.calls().length, calls);
    assert.equal(actions(t).length, reloads);
    assert.deepEqual(windowOf(t, MOVIES, await t.request(ids.list(MOVIES))), { from: 48, to: 144 });
  });

  it("up while the next page loads: the page is only kept in memory, the window stays where the user went", async () => {
    const t = await make();
    let s = await t.request(ids.list(MOVIES));
    await fire(t, items(s).at(-1));
    s = await t.request(ids.list(MOVIES));
    await fire(t, items(s).at(-1));
    s = await t.request(ids.list(MOVIES));
    assert.deepEqual(windowOf(t, MOVIES, s), { from: 48, to: 144 });
    const down = onExtend(t.ctx, `${MOVIES}:down:144`);
    await t.run(onExtend(t.ctx, `${MOVIES}:up:48`));
    await t.run(down);
    assert.equal(state(t, MOVIES).items.length, 192);
    s = await t.request(ids.list(MOVIES));
    assert.deepEqual(windowOf(t, MOVIES, s), { from: 0, to: 96 });
    await fire(t, items(s).at(-1));
    assert.deepEqual(windowOf(t, MOVIES, await t.request(ids.list(MOVIES))), { from: 48, to: 144 });
  });

  it("long titles: the window shrinks by rows keeping 18 seen tiles (3 rows) at the shift; every answer ≤ 32 KB", async () => {
    const t = await make();
    // Название плитка несёт дважды — две строки `titleHeader` и `kn` для шапки (V-10): окно — около 48 плиток.
    const long = "Очень длинное название фильма ".repeat(3);
    const big: ItemSummary[] = Array.from({ length: 144 }, (_, i) => ({
      id: 5000 + i, type: "movie", subtype: "", title: `${long}${i} / Long ${i}`, year: 2001, genres: [], countries: [],
      quality: 2160, kpRating: 7.9,
      posters: { small: `https://cdn.test/s/${i}.jpg`, medium: `https://cdn.test/m/${i}.jpg`, big: `https://cdn.test/b/${i}.jpg` },
    }));
    t.ctx.state.lists.set(MOVIES, { key: MOVIES, items: big, page: 3, totalPages: 9, done: false });
    let s = await t.request(ids.list(MOVIES));
    const first = windowOf(t, MOVIES, s);
    assert.equal(first.from, 0);
    assert.ok(first.to < WINDOW && first.to % ROW === 0, `to ${first.to}`);
    assert.ok(bytes({ ...s, items: [...items(s), ...posterTiles(t.ctx, big.slice(first.to, first.to + ROW))] }) > MAX_BYTES);

    const edgeTile = items(s).at(-1)?.id ?? "";
    await fire(t, items(s).at(-1));
    s = await t.request(ids.list(MOVIES));
    const next = windowOf(t, MOVIES, s);
    assert.ok(next.from > 0 && next.to > first.to, JSON.stringify(next));
    assert.deepEqual(tileIds(s).slice(0, tileIds(s).indexOf(edgeTile) + 1), slice(state(t, MOVIES), first.to - 3 * ROW, first.to));

    const headTile = items(s)[0]?.id ?? "";
    await fire(t, items(s)[0]);
    s = await t.request(ids.list(MOVIES));
    const back = windowOf(t, MOVIES, s);
    assert.ok(back.from < next.from, JSON.stringify(back));
    const at = tileIds(s).indexOf(headTile);
    assert.deepEqual(tileIds(s).slice(at, at + 3 * ROW), slice(state(t, MOVIES), next.from, next.from + 3 * ROW));
  });
});
