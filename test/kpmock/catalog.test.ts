import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "../../tools/kpmock/server.ts";
import type { MockServer } from "../../tools/kpmock/server.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";

const ACAO = "access-control-allow-origin";

interface ListItem { id: number; type: string; title: string; year: number | string; imdb_rating: number | string;
  genres: { id: number; title: string }[]; posters: Record<string, string>; created_at: number; views: number; rating: number }
interface ListBody { status: number; items: ListItem[]; pagination: { total: number; current: number; perpage: number; total_items: number } }
interface Urls { http: string; hls: string; hls2: string; hls4: string }
interface UnitBody { id: number; number: number; watched: number; watching: { status: number; time: number };
  files: { quality_id: number; file: string; url?: Urls }[]; subtitles: { lang: string; url: string }[] }
interface ItemBody { status: number; item: ListItem & { seasons?: { number: number; watching: { status: number }; episodes: UnitBody[] }[];
  videos?: UnitBody[]; bookmarks: number[]; in_watchlist: boolean } }
interface LinksBody { id: number; thumbnail: string; files: { codec: string; quality_id: number; file: string; urls: Urls }[];
  subtitles: { lang: string; forced: boolean; url: string }[] }

const S1E1 = FIX.SERIAL_BIG * 1000 + 1;

describe("kpmock catalog, items, media links, CDN", () => {
  let mock: MockServer;
  let token: string;
  const get = (path: string, init?: RequestInit): Promise<Response> => {
    const sep = path.includes("?") ? "&" : "?";
    return fetch(`${mock.url}${path}${sep}access_token=${token}`, init);
  };
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

  describe("lists", () => {
    it("requires a token and answers with CORS", async () => {
      const r = await fetch(`${mock.url}/v1/items?type=movie`);
      assert.equal(r.status, 401);
      assert.equal(r.headers.get(ACAO), "*");
      const ok = await get("/v1/items?type=movie");
      assert.equal(ok.headers.get(ACAO), "*");
    });

    it("filters by type with default perpage 20", async () => {
      const b = await json<ListBody>("/v1/items?type=movie");
      assert.equal(b.status, 200);
      assert.equal(b.items.length, 20);
      assert.ok(b.items.every((it) => it.type === "movie"));
      assert.deepEqual(b.pagination, { total: 11, current: 1, perpage: 20, total_items: 203 });
    });

    it("type list and genre filter: type=movie,serial&genre=23", async () => {
      const b = await json<ListBody>("/v1/items?type=movie,serial&genre=23&perpage=500");
      assert.deepEqual([...new Set(b.items.map((it) => it.type))].sort(), ["movie", "serial"]);
      assert.ok(b.items.every((it) => it.genres.some((g) => g.id === FIX.GENRE_ANIM)));
      const or = await json<ListBody>("/v1/items?type=movie&genre=23,1&perpage=500");
      assert.ok(or.items.length > b.items.filter((it) => it.type === "movie").length);
      assert.ok(or.items.every((it) => it.genres.some((g) => g.id === 23 || g.id === 1)));
    });

    it("sorts: -year descending, year- the same, title ascending", async () => {
      const desc = await json<ListBody>("/v1/items?type=movie&sort=-year&perpage=100");
      const years = desc.items.map((it) => Number(it.year));
      for (let i = 1; i < years.length; i++) assert.ok(years[i - 1] >= years[i], `year order at ${i}`);
      const suffix = await json<ListBody>("/v1/items?type=movie&sort=year-&perpage=100");
      assert.deepEqual(suffix.items.map((it) => it.id), desc.items.map((it) => it.id));
      const fallback = await json<ListBody>("/v1/items?sort=constructor&perpage=5");
      const updated = await json<ListBody>("/v1/items?sort=-updated&perpage=5");
      assert.deepEqual(fallback.items.map((it) => it.id), updated.items.map((it) => it.id));
      const asc = await json<ListBody>("/v1/items?sort=title&perpage=100");
      for (let i = 1; i < asc.items.length; i++) {
        assert.ok(asc.items[i - 1].title.localeCompare(asc.items[i].title, "ru") <= 0, `title order at ${i}`);
      }
    });

    it("perpage=48 and clamps a page past the end to the last one (A-13)", async () => {
      const p1 = await json<ListBody>("/v1/items?type=serial&perpage=48");
      assert.equal(p1.items.length, 48);
      const last = await json<ListBody>(`/v1/items?type=serial&perpage=48&page=${p1.pagination.total}`);
      const far = await json<ListBody>("/v1/items?type=serial&perpage=48&page=999");
      assert.equal(far.pagination.current, far.pagination.total);
      assert.deepEqual(far.items.map((it) => it.id), last.items.map((it) => it.id));
      mock.setScenario({ clampPages: false });
      const raw = await json<ListBody>("/v1/items?type=serial&perpage=48&page=999");
      assert.equal(raw.pagination.current, 999);
      assert.deepEqual(raw.items, []);
    });

    it("never lists the deleted title", async () => {
      const all = await json<ListBody>("/v1/items?perpage=1000");
      assert.equal(all.pagination.total_items, 505);
      assert.ok(!all.items.some((it) => it.id === FIX.MOVIE_DELETED));
      const found = await json<ListBody>("/v1/items/search?q=удалённый");
      assert.deepEqual(found.items, []);
    });

    it("SERIAL_LONG is only reachable by id: not in lists, search or similar", async () => {
      const all = await json<ListBody>("/v1/items?perpage=1000");
      assert.ok(!all.items.some((it) => it.id === FIX.SERIAL_LONG));
      assert.deepEqual((await json<ListBody>("/v1/items/search?q=длинный")).items, []);
      const similar = await json<ListBody>(`/v1/items/similar?id=${FIX.SERIAL_BIG}`);
      assert.ok(!similar.items.some((it) => it.id === FIX.SERIAL_LONG));
      assert.equal((await get(`/v1/items/${FIX.SERIAL_LONG}`)).status, 200);
    });

    it("tolerance: year as a string for every 7th id, imdb_rating for every 5th; posters on the mock", async () => {
      const b = await json<ListBody>("/v1/items?perpage=1000");
      const byId = new Map(b.items.map((it) => [it.id, it]));
      assert.equal(typeof byId.get(1002)?.year, "number");
      assert.equal(typeof byId.get(1002)?.imdb_rating, "number");
      assert.equal(typeof byId.get(1008)?.year, "string");               // 1008 = 7 × 144
      assert.equal(typeof byId.get(1005)?.imdb_rating, "string");
      assert.deepEqual(byId.get(1002)?.posters, {
        small: `${mock.url}/poster/small/1002.svg`, medium: `${mock.url}/poster/medium/1002.svg`,
        big: `${mock.url}/poster/big/1002.svg`, wide: `${mock.url}/poster/wide/1002.svg`,
      });
    });

    it("shelves: fresh by created_at, popular by views, hot by rating; type only — genre is ignored, a comma list is one feed", async () => {
      const fresh = await json<ListBody>("/v1/items/fresh?type=movie&perpage=30");
      assert.equal(fresh.items[0].id, 1000);
      const check = (items: ListItem[], f: (it: ListItem) => number): void => {
        for (let i = 1; i < items.length; i++) assert.ok(f(items[i - 1]) >= f(items[i]), `order at ${i}`);
      };
      check(fresh.items, (it) => it.created_at);
      assert.ok(fresh.items.every((it) => it.type === "movie"));
      const popular = await json<ListBody>("/v1/items/popular?type=serial&genre=23&perpage=30");
      check(popular.items, (it) => it.views);
      assert.ok(popular.items.every((it) => it.type === "serial"));
      assert.ok(popular.items.some((it) => !it.genres.some((g) => g.id === 23)), "genre is not a shelf filter");
      const total = async (type: string): Promise<number> => (await json<ListBody>(`/v1/items/hot?type=${type}`)).pagination.total_items;
      const hot = await json<ListBody>("/v1/items/hot?type=movie,serial&perpage=7");
      assert.equal(hot.items.length, 7);
      check(hot.items, (it) => it.rating);
      assert.equal(hot.pagination.total_items, (await total("movie")) + (await total("serial")));
    });

    it("shelves without type: HTTP 400 in the Yii format, as the live API (research kinopub-api §6.1); all, None, empty — an empty list", async () => {
      for (const shelf of ["fresh", "popular", "hot"]) {
        const r = await get(`/v1/items/${shelf}?perpage=7`);
        assert.equal(r.status, 400, shelf);
        assert.deepEqual(await r.json(), { name: "Bad Request", message: "Отсутствуют обязательные параметры: type", code: 0, status: 400 });
      }
      for (const type of ["all", "None", ""]) {
        const b = await json<ListBody>(`/v1/items/fresh?type=${type}`);
        assert.deepEqual([b.items.length, b.pagination.total_items], [0, 0], type);
      }
    });

    it("search: case-insensitive title substring with pagination", async () => {
      const b = await json<ListBody>(`/v1/items/search?q=${encodeURIComponent("тестовый сериал")}&field=title&perpage=200`);
      assert.ok(b.items.length > 0);
      assert.ok(b.items.every((it) => it.type === "serial"));
      assert.equal(b.pagination.total_items, 152);
      const en = await json<ListBody>("/v1/items/search?q=TEST%20SERIES%20big");
      assert.deepEqual(en.items.map((it) => it.id), [FIX.SERIAL_BIG]);
      const missing = await get("/v1/items/search");
      assert.equal(missing.status, 400);
    });

    it("similar: 12 titles of the same type", async () => {
      const b = await json<ListBody>(`/v1/items/similar?id=${FIX.SERIAL_BIG}`);
      assert.equal(b.items.length, 12);
      assert.ok(b.items.every((it) => it.type === "serial" && it.id !== FIX.SERIAL_BIG));
      assert.equal(new Set(b.items.map((it) => it.id)).size, 12);
      assert.equal((await get("/v1/items/similar?id=9")).status, 404);
    });
  });

  describe("item card", () => {
    it("serial: 10 seasons × 20 episodes, progress from state, url links, bookmarks", async () => {
      const { item } = await json<ItemBody>(`/v1/items/${FIX.SERIAL_BIG}`);
      assert.equal(item.id, FIX.SERIAL_BIG);
      assert.equal(item.seasons?.length, 10);
      assert.ok(item.seasons?.every((s) => s.episodes.length === 20));
      const s1 = item.seasons?.[0];
      assert.deepEqual(s1?.episodes.slice(0, 3).map((e) => e.watched), [1, 1, 1]);
      assert.equal(s1?.episodes[3].watching.time, 600);
      assert.equal(s1?.episodes[3].watching.status, 0);
      assert.equal(s1?.episodes[4].watching.status, -1);
      assert.equal(s1?.watching.status, 0);
      assert.equal(item.seasons?.[1].watching.status, -1);
      assert.deepEqual(item.bookmarks, [1]);
      const f0 = s1?.episodes[0].files[0];
      assert.ok(f0?.url?.hls.startsWith(`${mock.url}/cdn/hls/`));
      assert.ok(f0?.url?.hls.endsWith(`${f0.file}/master-v1a1.m3u8?loc=nl`));
      assert.ok(f0?.url?.hls2.endsWith(`/${S1E1}.m3u8?loc=nl`));
      assert.ok(s1?.episodes[0].subtitles[0].url.startsWith(`${mock.url}/cdn/sub/`));
    });

    it("nolinks=1 drops files[].url but keeps the ladder", async () => {
      const { item } = await json<ItemBody>(`/v1/items/${FIX.SERIAL_BIG}?nolinks=1`);
      const f0 = item.seasons?.[0].episodes[0].files[0];
      assert.ok(f0);
      assert.equal("url" in f0, false);
      assert.equal(f0.quality_id, 1);
    });

    it("movie: videos with watching from state", async () => {
      const { item } = await json<ItemBody>(`/v1/items/${FIX.MOVIE_SIMPLE}`);
      assert.equal(item.seasons, undefined);
      assert.equal(item.videos?.length, 1);
      assert.deepEqual(item.videos?.[0].watching, { status: 0, time: 1200 });
      assert.deepEqual(item.bookmarks, [1]);
      const multi = await json<ItemBody>(`/v1/items/${FIX.MOVIE_MULTI}`);
      assert.equal(multi.item.videos?.length, 3);
    });

    it("deleted or unknown title → 404 with CORS", async () => {
      for (const id of [FIX.MOVIE_DELETED, 9]) {
        const r = await get(`/v1/items/${id}`);
        assert.equal(r.status, 404);
        assert.equal(r.headers.get(ACAO), "*");
        assert.deepEqual(await r.json(), { status: 404, error: "Not found" });
      }
    });
  });

  describe("media-links", () => {
    it("has no status, urls instead of url, the full subtitle list and a KinoPub-like token", async () => {
      const before = Math.floor(Date.now() / 1000);
      const b = await json<LinksBody & { status?: number }>(`/v1/items/media-links?mid=${S1E1}`);
      assert.equal("status" in b, false);
      assert.equal(b.id, S1E1);
      assert.ok(b.files[0].urls.hls.endsWith("/master-v1a1.m3u8?loc=nl"));
      assert.ok(b.files[0].urls.hls2.endsWith(`/${S1E1}.m3u8?loc=nl`));
      assert.ok(b.files[0].urls.hls4.startsWith(`${mock.url}/cdn/hls4/`));
      assert.ok(b.files[0].urls.http.startsWith(`${mock.url}/cdn/pd/`));
      assert.ok(b.subtitles.length >= 5);
      assert.ok(b.subtitles.some((s) => s.lang === "eng" && s.forced));
      const tok = b.files[0].urls.hls2.split("/")[5];
      const m = /^id=1;0;0;(\d+);(\d+)&h=mock&e=(\d+)$/.exec(Buffer.from(tok, "base64url").toString("utf8"));
      assert.ok(m, "token format");
      assert.equal(Number(m[1]), S1E1);
      assert.ok(Number(m[2]) >= before);
      assert.equal(Number(m[3]), Number(m[2]) + 86_400);
    });

    it("unknown or missing mid → 404 / 400", async () => {
      assert.equal((await get("/v1/items/media-links?mid=1")).status, 404);
      assert.equal((await get("/v1/items/media-links")).status, 400);
    });
  });

  describe("CDN and posters", () => {
    const links = (): Promise<LinksBody> => json<LinksBody>(`/v1/items/media-links?mid=${S1E1}`);

    it("hls v1: master-v1aN → index-v1aN → 3 segments, no CORS", async () => {
      const { files } = await links();
      const master = await fetch(files[0].urls.hls.replace("master-v1a1", "master-v1a3"));
      assert.equal(master.status, 200);
      assert.match(master.headers.get("content-type") ?? "", /mpegurl/i);
      assert.equal(master.headers.get(ACAO), null);
      const text = await master.text();
      assert.ok(text.startsWith("#EXTM3U"));
      assert.equal(text.match(/#EXT-X-STREAM-INF/g)?.length, 1);
      assert.ok(text.includes("index-v1a3.m3u8"));
      const index = await (await fetch(new URL(text.trim().split("\n").at(-1) ?? "", master.url))).text();
      assert.equal(index.match(/#EXTINF/g)?.length, 3);
      assert.ok(index.includes("#EXT-X-ENDLIST"));
    });

    it("hls2: ABR master with 3 variants", async () => {
      const { files } = await links();
      const r = await fetch(files[0].urls.hls2);
      assert.equal(r.status, 200);
      const text = await r.text();
      assert.equal(text.match(/#EXT-X-STREAM-INF/g)?.length, 3);
      assert.ok(text.includes("RESOLUTION=1920x1080"));
    });

    it("subtitles: SRT with 3 cues", async () => {
      const { subtitles } = await links();
      const r = await fetch(subtitles[0].url);
      assert.equal(r.status, 200);
      const text = await r.text();
      assert.equal(text.match(/-->/g)?.length, 3);
      assert.ok(text.startsWith("1\n00:00:"));
    });

    it("media webm: every url points to sample.webm, Range → 206", async () => {
      mock.setScenario({ media: "webm" });
      const { files } = await links();
      for (const f of files) {
        for (const u of Object.values(f.urls)) assert.equal(u, `${mock.url}/cdn/media/sample.webm?mid=${S1E1}&loc=nl`);
      }
      const { item } = await json<ItemBody>(`/v1/items/${FIX.MOVIE_SIMPLE}`);
      assert.ok(item.videos?.[0].files[0].url?.hls.includes("/cdn/media/sample.webm?mid="));
      const full = await fetch(files[0].urls.hls);
      assert.equal(full.status, 200);
      assert.equal(full.headers.get("content-type"), "video/webm");
      assert.equal(full.headers.get("accept-ranges"), "bytes");
      const all = Buffer.from(await full.arrayBuffer());
      assert.equal(all.subarray(0, 4).toString("hex"), "1a45dfa3");   // EBML
      const part = await fetch(files[0].urls.hls, { headers: { Range: "bytes=0-99" } });
      assert.equal(part.status, 206);
      assert.equal(part.headers.get("content-range"), `bytes 0-99/${all.length}`);
      assert.equal(part.headers.get("accept-ranges"), "bytes");
      assert.equal(part.headers.get("content-type"), "video/webm");
      const bytes = Buffer.from(await part.arrayBuffer());
      assert.equal(bytes.length, 100);
      assert.deepEqual(bytes, all.subarray(0, 100));
      const tail = await fetch(files[0].urls.hls, { headers: { Range: "bytes=-10" } });
      assert.equal(tail.status, 206);
      assert.deepEqual(Buffer.from(await tail.arrayBuffer()), all.subarray(all.length - 10));
      const bad = await fetch(files[0].urls.hls, { headers: { Range: `bytes=${all.length}-` } });
      assert.equal(bad.status, 416);
      assert.equal(bad.headers.get("content-range"), `bytes */${all.length}`);
    });

    it("startMock({media: \"webm\"}) is the default after reset", async () => {
      const webm = await startMock({ port: 0, media: "webm" });
      try {
        webm.reset();
        const t = webm.issueToken().access;
        const r = await fetch(`${webm.url}/v1/items/media-links?mid=${S1E1}&access_token=${t}`);
        const b = (await r.json()) as LinksBody;
        assert.ok(b.files[0].urls.hls.includes("/cdn/media/sample.webm"));
      } finally {
        await webm.close();
      }
    });

    it("poster: SVG with the title number", async () => {
      const r = await fetch(`${mock.url}/poster/medium/${FIX.SERIAL_BIG}.svg`);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "image/svg+xml");
      assert.equal(r.headers.get(ACAO), null);
      const svg = await r.text();
      assert.ok(svg.startsWith("<svg"));
      assert.ok(svg.includes('width="250" height="375"'));
      assert.ok(svg.includes(String(FIX.SERIAL_BIG)));
      assert.equal((await fetch(`${mock.url}/poster/huge/1.svg`)).status, 404);
      assert.equal((await fetch(`${mock.url}/poster/constructor/1.svg`)).status, 404);
    });
  });
});
