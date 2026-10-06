import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chain, panelAction, replaceContent } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { encodeListKey, ids, listFlag } from "../../src/router/ids.ts";
import type { ListKey } from "../../src/router/ids.ts";
import { listSource, listTitle } from "../../src/screens/list.ts";
import { refreshAfterPlayback } from "../../src/screens/refresh.ts";
import { FIX, allCollections, catalog } from "../../tools/kpmock/fixtures.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

// Новые разделы меню v1.11 через механизм списков S5 (`listSource`/`listScreen`, окно Р-35): «Новинки», «Популярное»,
// «Горячее» без типа, «История», подборки и их содержимое, «Аниме», «Стендап», 3D и 4K.

const P = TEST_P;
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

const list = async (t: TestApp, k: ListKey): Promise<MsxContentRoot> => (await t.request(ids.list(encodeListKey(k)))) as MsxContentRoot;
const tiles = (s: MsxContentRoot): MsxContentItem[] => s.items ?? [];
const query = (t: TestApp, path: string): URLSearchParams[] =>
  t.mock.calls().filter((c) => c.path === path).map((c) => new URLSearchParams(c.query));
const options = (s: MsxContentRoot): (string | undefined)[] => (s.options?.items ?? []).map((i) => i.label);

describe("new menu sections as lists (v1.11)", () => {
  it("«Новинки», «Популярное», «Горячее» without a type: /v1/items/<shelf> without type, titled like the menu item, genre option only", async () => {
    const t = await make();
    for (const [src, title] of [["fresh", "Новинки"], ["popular", "Популярное"], ["hot", "Горячее"]] as const) {
      const s = await list(t, { src });
      assert.equal(s.headline, title);
      assert.equal(tiles(s).length, 48);
      const q = query(t, `/v1/items/${src}`)[0];
      assert.equal(q?.has("type"), false, src);
      assert.deepEqual(options(s), ["Жанр: все жанры"]);
    }
    assert.match((await list(t, { src: "fresh" })).extension ?? "", /Все жанры · 50\d шт\./);
  });

  it("«Аниме» (25), «Стендап» (101) are named by their section, not by a genre request; 3D asks type=3d; 4K — quality=4", async () => {
    const t = await make();
    const anime = await list(t, { src: "catalog", type: "movie,serial", sort: "-updated", genre: "25" });
    assert.equal(anime.headline, "Аниме · Обновлённые");
    const standup = await list(t, { src: "catalog", type: "movie", sort: "-updated", genre: "101" });
    assert.equal(standup.headline, "Стендап · Обновлённые");
    assert.deepEqual(query(t, "/v1/genres"), [], "no genre lookup for section genres");
    const s3d = await list(t, { src: "catalog", type: "3d", sort: "-updated" });
    assert.equal(s3d.headline, "3D · Обновлённые");
    assert.equal(tiles(s3d).length, catalog().filter((it) => it.type === "3D" && !it.deleted && !it.unlisted).length);
    const uhd = await list(t, { src: "catalog", sort: "-updated", quality: "4" });
    assert.equal(uhd.headline, "4K · Обновлённые");
    assert.equal(query(t, "/v1/items").at(-1)?.get("quality"), "4");
    assert.deepEqual(tiles(uhd).map((i) => i.id), [`i${FIX.MOVIE_AUDIO12}`]);
    assert.equal(tiles(uhd)[0]?.badge, "4K");
    assert.deepEqual(listSource({ src: "catalog", sort: "-updated", quality: "4" }), { kind: "catalog", sort: "-updated", quality: "4" });
  });

  it("«История»: /v1/history by 48, one tile per title in the history order, no options and no count", async () => {
    const t = await make();
    const s = await list(t, { src: "history" });
    assert.equal(s.headline, "История");
    assert.deepEqual(tiles(s).map((i) => i.id), [`i${FIX.SERIAL_BIG}`, `i${FIX.MOVIE_SIMPLE}`, `i${FIX.SERIAL_SMALL}`]);
    assert.equal(s.options, undefined);
    assert.equal(s.extension, undefined);
    assert.equal(query(t, "/v1/history")[0]?.get("perpage"), "48");
  });

  it("«История» without entries: a text instead of tiles", async () => {
    const t = await make();
    t.mock.state.history = [];
    const s = await list(t, { src: "history" });
    assert.equal(s.pages?.[0]?.items[0]?.text, "Здесь появятся фильмы и сериалы, которые вы смотрели");
  });

  it("«История» opened this session is forgotten after playback and its first page refreshed in the background", async () => {
    const t = await make();
    const key = encodeListKey({ src: "history" });
    await list(t, { src: "history" });
    const n = query(t, "/v1/history").length;
    t.ctx.current.onRequest(ids.item(FIX.MOVIE_SIMPLE));
    refreshAfterPlayback(t.ctx, FIX.MOVIE_SIMPLE);
    assert.equal(t.ctx.state.lists.has(key), false);
    await t.run(new Promise((r) => setImmediate(r)));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(query(t, "/v1/history").length, n + 1);
  });

  it("«Подборки»: collection posters with «N шт.», newest first, 48 + extend; the tile opens the collection; no focus prefetch", async () => {
    const t = await make();
    const s = await list(t, { src: "collections" });
    assert.equal(s.headline, "Подборки · Новые");
    assert.equal(query(t, "/v1/collections")[0]?.get("sort"), "-created");
    assert.equal(tiles(s).length, 48);
    const newest = [...allCollections()].sort((a, b) => b.created - a.created)[0]!;
    const first = tiles(s)[0];
    assert.equal(first?.id, `c${newest.id}`);
    assert.equal(first?.kid, undefined);
    assert.equal(first?.titleFooter, `${newest.items.length} шт.`);
    assert.equal(first?.action, `content:request:interaction:${ids.list(encodeListKey({ src: "collection", id: newest.id }))}@${P}`);
    assert.equal((s.template?.selection as { action?: string } | undefined)?.action, undefined, "no pf for collections");
    assert.equal(s.extension, "{ico:msx-red:stop} Новые · 60 подборок");
    assert.deepEqual(options(s), ["Сортировка: Новые"]);
    assert.deepEqual(tiles(s).at(-1)?.live?.type, "setup");
  });

  it("collection sort panel: Новые, Горячие, Популярные; a choice replaces the list with its flag", async () => {
    const t = await make();
    const key = encodeListKey({ src: "collections" });
    const s = await list(t, { src: "collections" });
    assert.equal(s.options?.items?.[0]?.action, chain(["back", panelAction(P, ids.panel("sort", key))]));
    const p = (await t.request(ids.panel("sort", key))) as MsxContentRoot;
    assert.deepEqual(p.items?.map((i) => i.label), ["{ico:check} Новые", "Горячие", "Популярные"]);
    const hot = encodeListKey({ src: "collections", sort: "-watchers" });
    assert.equal(p.items?.[1]?.action, chain(["back", replaceContent(listFlag(key), P, ids.list(hot))]));
    const h = (await t.request(ids.list(hot))) as MsxContentRoot;
    assert.equal(h.headline, "Подборки · Горячие");
    const top = [...allCollections()].sort((a, b) => b.watchers - a.watchers || a.id - b.id)[0]!;
    assert.equal(tiles(h)[0]?.id, `c${top.id}`);
  });

  it("a collection: its own title from collections/view, its titles by 48 with extend, ordinary title tiles", async () => {
    const t = await make();
    const big = allCollections().find((c) => c.items.length > 48)!;
    const s = await list(t, { src: "collection", id: big.id });
    assert.equal(s.headline, big.title);
    assert.equal(tiles(s).length, 48);
    assert.equal(tiles(s)[0]?.id, `i${big.items[0]}`);
    assert.equal(tiles(s)[0]?.kid, String(big.items[0]));
    assert.equal(s.options, undefined);
    assert.equal(s.extension, `${big.items.length} шт.`);
    assert.equal(query(t, "/v1/collections/view")[0]?.get("id"), String(big.id));
    assert.equal(listTitle({ src: "collection", id: big.id }), "Подборка");
  });

  it("a collection that does not exist → the error screen KP-404; a key without id → KP-BAD", async () => {
    const t = await make();
    assert.match(JSON.stringify(await list(t, { src: "collection", id: 99_999 })), /KP-404/);
    assert.match(JSON.stringify(await list(t, { src: "collection" })), /KP-BAD/);
  });
});
