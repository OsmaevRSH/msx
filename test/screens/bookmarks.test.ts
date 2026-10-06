import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { contentAction } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { encodeListKey, ids } from "../../src/router/ids.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

const P = TEST_P;
const folderKey = (folder: number): string => encodeListKey({ src: "folder", folder });

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

const screen = async (t: TestApp): Promise<MsxContentRoot> => (await t.request(ids.bookmarks())) as MsxContentRoot;
const allItems = (s: MsxContentRoot): MsxContentItem[] => [...(s.items ?? []), ...(s.pages ?? []).flatMap((p) => p.items)];

describe("bookmarksScreen (S11)", () => {
  it("16×8 list, not cached; «Избранное» is a 4×2 tile, the bookmark icon inside its headline (V-30), «2 шт.»", async () => {
    const t = await make();
    const s = await screen(t);
    assert.equal(s.type, "list");
    assert.equal(s.compress, true);
    assert.equal(s.cache, false);
    assert.equal(s.headline, "Закладки");
    assert.equal(s.template?.layout, "0,0,4,2");
    assert.equal(s.template?.icon, undefined, "the template icon was drawn over the folder name");
    assert.equal(s.template?.enumerate, false);
    assert.deepEqual(s.items, [{ id: "f1", focus: true, headline: "{ico:bookmark} Избранное", text: "2 шт.", action: contentAction(P, ids.list(folderKey(1))) }]);
    assert.equal(s.preload, "next");
    // Стражи над рядом папок и под ним (msx/edges.ts): «вверх» и «вниз» на краю не переносят фокус по кругу.
    assert.deepEqual(s.inserts?.map((p) => [p.position, p.items.map((g) => [g.layout, g.color, g.selection?.action])]), [
      ["page:0", [["0,0,4,1", "transparent", "focus:f1"], ["0,3,4,1", "transparent", "focus:f1"]]],
    ]);
  });

  it("every folder gets a tile in the server order", async () => {
    const t = await make();
    t.mock.state.folders.set(7, { title: "Позже", items: [FIX.SERIAL_SMALL], created: 0 });
    const s = await screen(t);
    assert.deepEqual(s.items?.map((i) => [i.headline, i.text, i.action]), [
      ["{ico:bookmark} Избранное", "2 шт.", contentAction(P, ids.list(folderKey(1)))],
      ["{ico:bookmark} Позже", "1 шт.", contentAction(P, ids.list(folderKey(7)))],
    ]);
  });

  it("no folders — a hint and a normal-sized «Найти фильм» to the search (V-32)", async () => {
    const t = await make();
    t.mock.state.folders.clear();
    const s = await screen(t);
    assert.equal(s.items, undefined, "explicit layouts: MSX lays root items out by the template");
    assert.deepEqual(s.pages?.[0]?.items.map((i) => [i.type, i.layout, i.text ?? i.label, i.action]), [
      ["space", "0,0,16,2", "Здесь появятся папки с закладками. Добавьте фильм кнопкой ☆ на карточке", undefined],
      ["button", "0,2,4,1", "{ico:search} Найти фильм", contentAction(P, ids.search())],
    ]);
  });

  it("folder contents are the S5 list of that folder (paging and window come from list.ts)", async () => {
    const t = await make();
    const s = await screen(t);
    const action = s.items?.[0]?.action ?? "";
    const dataId = action.replace(/^content:request:interaction:/, "").replace(`@${P}`, "");
    const list = (await t.request(dataId)) as MsxContentRoot;
    assert.equal(list.type, "list");
    assert.deepEqual(list.items?.map((i) => i.kid), [String(FIX.MOVIE_SIMPLE), String(FIX.SERIAL_BIG)]);
  });

  it("API failure — error screen whose «Повторить» reloads the bookmarks", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/bookmarks$", status: 404 }] });
    const s = await screen(t);
    const items = allItems(s);
    assert.match(String(items[0]?.text), /KP-404/);
    assert.equal(items[1]?.action, "[invalidate:content|reload:content]");
  });
});
