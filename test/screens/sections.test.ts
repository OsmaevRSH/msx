import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chain, commitMsg, panelAction, replaceContent } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { encodeListKey, ids, listFlag, msgs } from "../../src/router/ids.ts";
import type { ListKey } from "../../src/router/ids.ts";
import { listSource, listTitle } from "../../src/screens/list.ts";
import { onPanelAct } from "../../src/screens/panels.ts";
import { refreshAfterPlayback } from "../../src/screens/refresh.ts";
import { FIX, allCollections, catalog } from "../../tools/kpmock/fixtures.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

// Новые разделы меню v1.11 через механизм списков S5 (`listSource`/`listScreen`, окно Р-35): «Новинки», «Популярное»,
// «Горячее» с вкладками типов (v1.14: `type` полке обязателен), «История», подборки и их содержимое, «Аниме»,
// «Стендап», 3D и 4K.

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
  it("«Новинки», «Популярное», «Горячее» from the menu: «Фильмы» by default — /v1/items/<shelf>?type=movie, tiles instead of an error, the red button opens the type panel", async () => {
    const t = await make();
    for (const [src, title] of [["fresh", "Новые фильмы"], ["popular", "Популярные фильмы"], ["hot", "Горячее: фильмы"]] as const) {
      const alias = encodeListKey({ src });
      const s = await list(t, { src });
      assert.equal(s.headline, title);
      assert.equal(tiles(s).length, 48);
      assert.ok(tiles(s).every((i) => catalog().find((it) => `i${it.id}` === i.id)?.type === "movie"), src);
      const q = query(t, `/v1/items/${src}`)[0];
      assert.deepEqual([q?.get("type"), q?.has("genre")], ["movie", false], src);
      // Экран — пункт меню: флаг и опции по запрошенному ключу без типа.
      assert.equal(s.flag, listFlag(alias));
      const o = s.options?.items?.[0];
      assert.deepEqual([s.options?.items?.length, o?.label, o?.key, o?.action], [1, "Тип: Фильмы", "red", chain(["cleanup", panelAction(P, ids.panel("type", alias))])]);
    }
    assert.match((await list(t, { src: "fresh" })).extension ?? "", /^\{ico:msx-red:stop\} Фильмы · \d+ фильм(а|ов)?$/);
  });

  it("type panel: 8 tabs in two columns with the current one marked; a choice is remembered for the menu item and replaces the open list by its flag", async () => {
    const t = await make();
    const alias = encodeListKey({ src: "popular" });
    await list(t, { src: "popular" });
    const p = (await t.request(ids.panel("type", alias))) as MsxContentRoot;
    assert.equal(p.headline, "Тип");
    assert.deepEqual(p.template, { type: "button", layout: "0,0,4,1" });
    assert.deepEqual(p.items?.map((i) => i.label), [
      "{ico:check} Фильмы", "Сериалы", "Док. фильмы", "Док. сериалы", "Концерты", "ТВ-шоу", "3D", "Все типы",
    ]);
    assert.equal(p.items?.[1]?.action, commitMsg(msgs.act("panel", "type", alias, "serial")));

    const serials = encodeListKey({ src: "popular", type: "serial" });
    t.host.clearActions();
    await onPanelAct(t.ctx, "type", [alias, "serial"]);
    assert.deepEqual(t.host.actions.map((a) => a.action), [chain(["back", replaceContent(listFlag(alias), P, ids.list(serials))])]);
    assert.deepEqual(t.ctx.store.get("cfg", "shelf"), { popular: "serial" });
    const s = await list(t, { src: "popular", type: "serial" });
    assert.equal(s.headline, "Популярные сериалы");
    assert.match(s.extension ?? "", /^\{ico:msx-red:stop\} Сериалы · \d+ сериал/);
    // Пункт меню теперь открывает сериалы: тот же список в памяти, без нового запроса.
    const firstPages = (): number => query(t, "/v1/items/popular").filter((q) => q.get("page") === "1").length;
    const n = firstPages();
    const again = await list(t, { src: "popular" });
    assert.deepEqual([again.headline, again.flag, firstPages()], ["Популярные сериалы", listFlag(alias), n]);
    assert.equal((await t.request(ids.panel("type", alias)) as MsxContentRoot).items?.[1]?.label, "{ico:check} Сериалы");
    // Остальные полки помнят своё.
    assert.equal((await list(t, { src: "hot" })).headline, "Горячее: фильмы");
  });

  it("«Все типы»: one feed of all types by a comma list; «Фильмы» again is the default and is not stored; bad arguments change nothing", async () => {
    const t = await make();
    const alias = encodeListKey({ src: "fresh" });
    await onPanelAct(t.ctx, "type", [alias, "all"]);
    const s = await list(t, { src: "fresh" });
    assert.equal(s.headline, "Новинки · Все типы");
    assert.equal(query(t, "/v1/items/fresh").at(-1)?.get("type"), "movie,serial,concert,documovie,docuserial,tvshow");
    const types = new Set(tiles(s).map((i) => catalog().find((it) => `i${it.id}` === i.id)?.type));
    assert.ok(types.size > 1, [...types].join());
    await onPanelAct(t.ctx, "type", [alias, "movie"]);
    assert.equal(t.ctx.store.get("cfg", "shelf"), undefined);
    t.host.clearActions();
    for (const args of [[alias, "anime"], [encodeListKey({ src: "catalog", type: "movie" }), "serial"], ["!!", "movie"], []]) {
      await onPanelAct(t.ctx, "type", args);
    }
    assert.deepEqual([t.host.actions, t.ctx.store.get("cfg", "shelf")], [[], undefined]);
  });

  it("the home «Показать все» key carries its type: no settings read, the panel marks it; a shelf key with a genre ignores it", async () => {
    const t = await make();
    t.ctx.store.set("cfg", "shelf", { fresh: "concert" });
    const key = encodeListKey({ src: "fresh", type: "serial" });
    const s = await list(t, { src: "fresh", type: "serial" });
    assert.deepEqual([s.headline, s.flag], ["Новые сериалы", listFlag(key)]);
    assert.equal((await t.request(ids.panel("type", key)) as MsxContentRoot).items?.[1]?.label, "{ico:check} Сериалы");
    assert.equal((await list(t, { src: "fresh" })).headline, "Новинки · Концерты");
    assert.deepEqual(listSource({ src: "hot", type: "tvshow", genre: "23" }), { kind: "shelf", shelf: "hot", type: "tvshow" });
    assert.deepEqual(listSource({ src: "hot" }), { kind: "shelf", shelf: "hot", type: "movie" });
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

  it("«Подборки»: collection posters without a made-up «0 шт.» (the API has no count), newest first, 48 + extend; the tile opens the collection; no focus prefetch", async () => {
    const t = await make();
    const s = await list(t, { src: "collections" });
    assert.equal(s.headline, "Подборки · Новые");
    assert.equal(query(t, "/v1/collections")[0]?.get("sort"), "-created");
    assert.equal(tiles(s).length, 48);
    const newest = [...allCollections()].sort((a, b) => b.created - a.created)[0]!;
    const first = tiles(s)[0];
    assert.equal(first?.id, `c${newest.id}`);
    assert.equal(first?.kid, undefined);
    assert.ok(tiles(s).every((i) => i.titleFooter === undefined), "no count — no footer");
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
