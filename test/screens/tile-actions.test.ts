import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { BookmarkFolder } from "../../src/api/models.ts";
import type { MsxContentRoot } from "../../src/msx/types.ts";
import { encodeListKey, ids } from "../../src/router/ids.ts";
import { NO_OPTIONS, WATCHING_OPTIONS, listTileOptions, tilePanel } from "../../src/screens/tile-actions.ts";
import { actionIssues, contextIssues, rootIssues } from "../../tools/crawl-rules.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";
import { waitFor } from "../progress/progress-rig.ts";

// Действия над плиткой (спец. §11.4): опции шаблона, подтверждение «Очистить всю историю», разбор сообщений.
// Сквозные сценарии с KinoPub и заменой экрана — test/contract/actions.test.ts.

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

const folder = (id: number, title: string): BookmarkFolder => ({ id, title, count: 1 });
const seedFolders = (t: TestApp, list: BookmarkFolder[]): Promise<unknown> =>
  t.run(t.ctx.cache.get("bm:", { ttlMs: 60_000, staleMaxMs: 60_000, persist: false }, async () => list, { force: true }));
const rows = (o: { options?: MsxContentRoot } | undefined): [string | undefined, string | undefined][] =>
  (o?.options?.items ?? []).map((i) => [i.label, i.action]);
const act = (m: string): string => `[back|interaction:commit:message:act:tile:${m}]`;

describe("tile options (spec §11.4)", () => {
  it("«История»: remove the title in focus, clear everything through the confirmation panel", async () => {
    const t = await make();
    const o = listTileOptions(t.ctx, { src: "history" });
    assert.equal(o?.options?.headline, "{context:kt}");
    assert.deepEqual(rows(o), [
      ["Удалить из истории", act("del:{context:kid}")],
      ["Очистить всю историю", `[back|panel:request:interaction:panel:tile:clear@${TEST_P}]`],
    ]);
    for (const [, a] of rows(o)) assert.deepEqual(actionIssues(a ?? ""), []);
  });

  it("a folder: «Убрать из папки» and «Переместить в «…»» for every other folder known from the folder list", async () => {
    const t = await make();
    assert.deepEqual(rows(listTileOptions(t.ctx, { src: "folder", folder: 3 })), [["Убрать из папки", act("unfold:{context:kid}:3")]]);
    await seedFolders(t, [folder(1, "Избранное"), folder(3, "Это"), folder(0, "битая"), folder(9, "Позже")]);
    assert.deepEqual(rows(listTileOptions(t.ctx, { src: "folder", folder: 3 })), [
      ["Убрать из папки", act("unfold:{context:kid}:3")],
      ["Переместить в «Избранное»", act("move:{context:kid}:3:1")],
      ["Переместить в «Позже»", act("move:{context:kid}:3:9")],
    ]);
  });

  it("no tile options in other lists", async () => {
    const t = await make();
    for (const k of [{ src: "catalog" }, { src: "fresh", type: "movie" }, { src: "similar", id: 1 }, { src: "collections" }, { src: "collection", id: 1 }, { src: "folder" }] as const) {
      assert.equal(listTileOptions(t.ctx, k), undefined, k.src);
    }
  });

  it("«Я смотрю»: remove a serial; a movie tile overrides the template with `options: false` — MSX's own options", () => {
    assert.deepEqual(rows(WATCHING_OPTIONS), [["Убрать из «Я смотрю»", act("unwatch:{context:kid}")]]);
    assert.deepEqual(NO_OPTIONS, { options: false });
  });

  it("markup rules: template options are an options root with {context:…}; `options: false` on a tile is fine", () => {
    const root = {
      template: { type: "default", ...WATCHING_OPTIONS }, items: [{ kid: "1", kt: "А" }, { kid: "2", kt: "Б", ...NO_OPTIONS }],
    } as MsxContentRoot;
    assert.deepEqual(rootIssues(root, "w"), []);
    assert.deepEqual(contextIssues(root), []);
    assert.deepEqual(rootIssues({ template: { options: { items: [] } }, items: [{}] } as MsxContentRoot, "x"), [
      "x template options: items без template — MSX покажет «Содержимое недоступно»",
      "x template options: ни items, ни pages",
    ]);
  });
});

describe("panel:tile:clear (spec §11.4)", () => {
  it("«Очистить всю историю?»: «Очистить» closes the panel and sends act:tile:clear, focus on «Отмена»", async () => {
    const t = await make();
    const p = (await t.request(ids.panel("tile", "clear"))) as MsxContentRoot;
    assert.equal(p.headline, "Очистить всю историю?");
    assert.deepEqual(p.items?.map((i) => [i.label, i.action, i.focus === true]), [
      ["Очистить", act("clear"), false],
      ["Отмена", "back", true],
    ]);
    assert.deepEqual(rootIssues(p, "panel"), []);
  });

  it("any other panel:tile:… is an error panel, not a crash", async () => {
    const t = await make();
    assert.throws(() => tilePanel(t.ctx, ["clear", "x"]), /bad panel tile/);
    const p = (await t.request(ids.panel("tile", "nope"))) as MsxContentRoot;
    assert.match(JSON.stringify(p), /KP-BAD/);
  });
});

describe("act:tile messages", () => {
  it("reach onTileAct through the router (log line) and move a title on to the info", async () => {
    const t = await make();
    t.app.handleData({ message: `act:tile:del:${FIX.MOVIE_SIMPLE}` });
    await waitFor(t, () => t.host.actions.some((a) => a.action.includes("info:Удалено из истории")), "info");
    assert.equal(t.ctx.log.entries().filter((e) => e.msg === "act tile del").length, 1);
    assert.deepEqual(t.host.actions.map((a) => a.action), ["[info:Удалено из истории]"], "the history is not on screen");
  });

  it("the last tile of the window removed while the list goes on: focus on the previous tile, not one beyond the window", async () => {
    const t = await make();
    const key = encodeListKey({ src: "history" });
    const items = [FIX.SERIAL_BIG, FIX.MOVIE_SIMPLE, FIX.SERIAL_SMALL].map((id) => ({ id, title: String(id), posters: {} }));
    t.ctx.state.lists.set(key, { key, items, page: 1, totalPages: 2, done: false, from: 0, to: 2 } as never);
    t.ctx.current.onRequest(ids.list(key));
    t.app.handleData({ message: `act:tile:del:${FIX.MOVIE_SIMPLE}` });
    await waitFor(t, () => t.host.actions.some((a) => a.action.includes("info:")), "info");
    const last = t.host.actions.at(-1)?.action ?? "";
    assert.ok(last.startsWith(`[focus:i${FIX.SERIAL_BIG}|replace:content:`), last);
    assert.deepEqual(t.ctx.state.lists.get(key)?.items.map((i) => i.id), [FIX.SERIAL_BIG, FIX.SERIAL_SMALL]);
  });

  it("move into a folder whose title has chain characters: the info stays one MSX action", async () => {
    const t = await make();
    t.mock.state.folders.set(5, { title: "A|B [x]", items: [], created: 1 });
    await t.request(ids.bookmarks());
    t.app.handleData({ message: `act:tile:move:${FIX.MOVIE_SIMPLE}:1:5` });
    await waitFor(t, () => t.host.actions.some((a) => a.action.includes("info:")), "info");
    const a = t.host.actions.at(-1)?.action ?? "";
    assert.equal(a, "[info:Перемещено в «A B  x »]");
    assert.deepEqual(actionIssues(a), []);
    assert.deepEqual(t.mock.state.folders.get(5)?.items, [FIX.MOVIE_SIMPLE]);
  });

  it("a moved title is not in the source folder list kept in memory; the target is read anew", async () => {
    const t = await make();
    t.mock.state.folders.set(5, { title: "MSX", items: [], created: 1 });
    await t.request(ids.bookmarks());
    const target = encodeListKey({ src: "folder", folder: 5 });
    await t.request(ids.list(target));
    assert.ok(t.ctx.state.lists.has(target));
    t.app.handleData({ message: `act:tile:move:${FIX.SERIAL_BIG}:1:5` });
    await waitFor(t, () => t.host.actions.some((a) => a.action.includes("info:")), "info");
    assert.equal(t.ctx.state.lists.has(target), false);
  });
});
