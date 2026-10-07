import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { CHANNELS, FIX, allCollections, buildCollections, catalog } from "../../tools/kpmock/fixtures.ts";
import { startMock } from "../../tools/kpmock/server.ts";
import type { MockServer } from "../../tools/kpmock/server.ts";
import { watchKey } from "../../tools/kpmock/state.ts";

// kpmock для разделов v1.11: подборки, каналы эфира, фильтр качества, `type` без учёта регистра, «Я смотрю».

interface Coll { id: number; title: string; watchers: number; views: number; created: number; updated: number; posters: Record<string, string> }
interface Page<T> { status: number; items: T[]; pagination: { total: number; current: number; perpage: number; total_items: number } }
interface Channel { id: number; title: string; name: string; logos: { s: string; m: string }; stream: string; playlist: string; status: null }

describe("kpmock: collections, TV channels, quality and the «Я смотрю» list", () => {
  let mock: MockServer;
  let token: string;
  const get = (path: string): Promise<Response> => fetch(`${mock.url}${path}${path.includes("?") ? "&" : "?"}access_token=${token}`);
  const json = async <T>(path: string): Promise<T> => {
    const r = await get(path);
    assert.equal(r.status, 200, `${path} → ${r.status}`);
    return (await r.json()) as T;
  };

  before(async () => { mock = await startMock({ port: 0 }); });
  after(async () => { await mock.close(); });
  beforeEach(() => {
    mock.reset();
    token = mock.issueToken().access;
  });

  it("collections fixtures are deterministic: 60, each with 5–64 unique visible titles", () => {
    assert.deepEqual(buildCollections(), allCollections());
    assert.equal(allCollections().length, 60);
    for (const c of allCollections()) {
      assert.ok(c.items.length >= 5 && c.items.length <= 64, `${c.id}: ${c.items.length}`);
      assert.equal(new Set(c.items).size, c.items.length);
      assert.ok(c.items.every((id) => catalog().some((it) => it.id === id && !it.deleted && !it.unlisted)));
    }
    assert.ok(allCollections().some((c) => c.items.length > 48), "a collection longer than a portion");
  });

  it("/v1/collections (and /index): pages, default sort updated-, -created / watchers- / -views, title filter from 3 chars; 401 without a token", async () => {
    const p1 = await json<Page<Coll>>("/v1/collections?perpage=48");
    assert.deepEqual(p1.pagination, { total: 2, current: 1, perpage: 48, total_items: 60 });
    assert.equal(p1.items.length, 48);
    const byUpdated = [...allCollections()].sort((a, b) => b.updated - a.updated || a.id - b.id).map((c) => c.id);
    assert.deepEqual(p1.items.map((c) => c.id), byUpdated.slice(0, 48));
    const c = p1.items[0]!;
    assert.deepEqual(Object.keys(c.posters).sort(), ["big", "medium", "small"], "collection posters have no wide");
    // Поля подборки — как у живого API: числа тайтлов нет (доки «API 1.3», снимок api2).
    assert.deepEqual(Object.keys(c).sort(), ["created", "id", "posters", "title", "updated", "views", "watchers"]);
    for (const [sort, key] of [["-created", "created"], ["watchers-", "watchers"], ["-views", "views"]] as const) {
      const ids = (await json<Page<Coll>>(`/v1/collections/index?sort=${sort}&perpage=60`)).items.map((x) => x[key]);
      assert.deepEqual(ids, [...ids].sort((a, b) => b - a), sort);
    }
    const found = await json<Page<Coll>>(`/v1/collections?title=${encodeURIComponent("космос")}`);
    assert.ok(found.items.length > 0 && found.items.every((x) => x.title.includes("космос")));
    assert.equal((await json<Page<Coll>>("/v1/collections?title=ко")).pagination.total_items, 60, "shorter than 3 — no filter");
    token = "";
    assert.equal((await get("/v1/collections")).status, 401);
  });

  it("/v1/collections/view: the collection, its titles as list items, pagination; unknown id → 404", async () => {
    const big = allCollections().find((c) => c.items.length > 48)!;
    const v = await json<Page<{ id: number; type: string }> & { collection: Coll }>(`/v1/collections/view?id=${big.id}&page=2&perpage=48`);
    assert.equal(v.collection.id, big.id);
    assert.equal(v.collection.title, big.title);
    assert.equal("count" in v.collection, false);
    assert.deepEqual(v.items.map((x) => x.id), big.items.slice(48));
    assert.equal(v.pagination.total_items, big.items.length);
    assert.equal((await get("/v1/collections/view?id=99999")).status, 404);
  });

  it("/v1/tv and /v1/tv/index: channels with logos and a live HLS stream (WebM in the e2e media mode)", async () => {
    for (const path of ["/v1/tv", "/v1/tv/index"]) {
      const body = await json<{ status: number; channels: Channel[] }>(path);
      assert.equal(body.channels.length, CHANNELS.length);
      const ch = body.channels[0]!;
      assert.deepEqual([ch.id, ch.title, ch.name, ch.playlist, ch.status], [1, "Тестовый спорт 1", "sport1", "", null]);
      assert.equal(ch.logos.s, `${mock.url}/poster/logo/1.svg`);
      assert.equal(ch.stream, `${mock.url}/cdn/tv/sport1/playlist.m3u8`);
    }
    const logo = await fetch(`${mock.url}/poster/logo/1.svg`);
    assert.match(await logo.text(), /width="240" height="180"/);
    const live = await (await fetch(`${mock.url}/cdn/tv/sport1/playlist.m3u8`)).text();
    assert.match(live, /#EXT-X-TARGETDURATION:6/);
    assert.doesNotMatch(live, /ENDLIST/);
    mock.setScenario({ media: "webm" });
    const webm = await json<{ channels: Channel[] }>("/v1/tv");
    assert.equal(webm.channels[0]?.stream, `${mock.url}/cdn/media/sample.webm?tv=sport1`);
  });

  it("/v1/items: quality=4 — at least 4K; an unknown quality id finds nothing; type is case-insensitive (3d)", async () => {
    const uhd = await json<Page<{ id: number; quality: number }>>("/v1/items?quality=4&perpage=48");
    assert.deepEqual(uhd.items.map((x) => x.id), [FIX.MOVIE_AUDIO12]);
    assert.equal((await json<Page<unknown>>("/v1/items?quality=1080")).pagination.total_items, 0);
    const lower = await json<Page<{ type: string }>>("/v1/items?type=3d&perpage=48");
    assert.ok(lower.items.length > 0 && lower.items.every((x) => x.type === "3D"));
    assert.equal(lower.pagination.total_items, (await json<Page<unknown>>("/v1/items?type=3D")).pagination.total_items);
  });

  it("/v1/watching/serials?subscribed=1 — «Я смотрю»: started serials, except fully watched without new episodes", async () => {
    const all = await json<{ items: { id: number; new: number }[] }>("/v1/watching/serials");
    const sub = await json<{ items: { id: number; new: number }[] }>("/v1/watching/serials?subscribed=1");
    assert.deepEqual(sub.items.map((x) => x.id), all.items.map((x) => x.id));
    // «Короткий» досмотрен целиком, новых серий нет — из «Я смотрю» уходит, в общем списке остаётся.
    for (const s of [1, 2]) for (const e of [1, 2, 3]) mock.state.watching.set(watchKey(FIX.SERIAL_SMALL, s, e), { time: 60, status: 1, updated: 1 });
    const after = await json<{ items: { id: number }[] }>("/v1/watching/serials?subscribed=1");
    assert.ok(!after.items.some((x) => x.id === FIX.SERIAL_SMALL));
    assert.ok((await json<{ items: { id: number }[] }>("/v1/watching/serials")).items.some((x) => x.id === FIX.SERIAL_SMALL));
    mock.state.newEpisodes.set(FIX.SERIAL_SMALL, 1);
    assert.ok((await json<{ items: { id: number }[] }>("/v1/watching/serials?subscribed=1")).items.some((x) => x.id === FIX.SERIAL_SMALL));
  });
});
