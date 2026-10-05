import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIX, findItem } from "../../tools/kpmock/fixtures.ts";
import { Router } from "../../tools/kpmock/router.ts";
import { register as registerItems } from "../../tools/kpmock/routes/items.ts";
import { startMock } from "../../tools/kpmock/server.ts";
import type { MockServer } from "../../tools/kpmock/server.ts";
import { MockState, watchKey } from "../../tools/kpmock/state.ts";

const ACAO = "access-control-allow-origin";
const NOT_FOUND = { status: 404, error: "Requested item or video not found." };

// `/v1/items/:id` наполняет этап 7 (параллельная волна W2); до слияния проверка через карточку пропускается.
const itemsRouteReady = ((): boolean => {
  const r = new Router();
  registerItems(r, new MockState(), () => "");
  return r.match("GET", `/v1/items/${FIX.MOVIE_SIMPLE}`) !== undefined;
})();

interface WatchUnit { id: number; number: number; title: string; duration: number; time: number; status: number; updated: number | null }
interface WatchBody { status: number; item: { id: number; title: string; type: string; status: number;
  videos?: WatchUnit[]; seasons?: { id: number; number: number; status: number; watched: number; episodes: WatchUnit[] }[] } }
interface HistoryBody { status: number; history: { counter: number; first_seen: number; last_seen: number; time: number;
  item: { id: number; type: string; title: string; posters: Record<string, string> };
  media: { id: number; number: number; snumber: number; title: string; duration: number } }[];
  pagination: { total: number; current: number; perpage: number; total_items: number } }
interface SerialRow { id: number; type: string; title: string; posters: Record<string, string>; total: number | string; watched: number; new: number }

describe("kpmock watching and history", () => {
  let mock: MockServer;
  let tok = "";
  const get = (path: string, q: Record<string, string | number> = {}): Promise<Response> => {
    const qs = new URLSearchParams({ access_token: tok, ...Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])) });
    return fetch(`${mock.url}${path}?${qs}`);
  };
  const json = async <T>(path: string, q: Record<string, string | number> = {}): Promise<T> => {
    const r = await get(path, q);
    assert.equal(r.status, 200, `${path} → ${r.status}`);
    return (await r.json()) as T;
  };
  const episode = (b: WatchBody, s: number, e: number): WatchUnit | undefined =>
    b.item.seasons?.find((x) => x.number === s)?.episodes.find((x) => x.number === e);

  before(async () => { mock = await startMock({ port: 0 }); });
  after(async () => { await mock.close(); });
  beforeEach(() => {
    mock.reset();
    tok = mock.issueToken().access;
  });

  it("requires a token (401 with CORS)", async () => {
    tok = "";
    const r = await get("/v1/watching/marktime", { id: FIX.MOVIE_SIMPLE, video: 1, time: 100 });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get(ACAO), "*");
  });

  describe("marktime", () => {
    it("answers 404 with the API text when a serial has no season", async () => {
      const r = await get("/v1/watching/marktime", { id: FIX.SERIAL_BIG, video: 5, time: 100 });
      assert.equal(r.status, 404);
      assert.equal(r.headers.get(ACAO), "*");
      assert.deepEqual(await r.json(), NOT_FOUND);
    });

    it("answers 404 for a season or video number that does not exist (numbers, not ids)", async () => {
      const unitId = findItem(FIX.SERIAL_BIG)?.seasons?.[0].episodes[0].id ?? 0;
      for (const q of [{ season: 11, video: 1 }, { season: 1, video: 21 }, { season: 1, video: unitId }]) {
        const r = await get("/v1/watching/marktime", { id: FIX.SERIAL_BIG, time: 100, ...q });
        assert.equal(r.status, 404, JSON.stringify(q));
        assert.deepEqual(await r.json(), NOT_FOUND);
      }
      const unknown = await get("/v1/watching/marktime", { id: 99_999, video: 1, time: 100 });
      assert.equal(unknown.status, 404);
    });

    it("answers 400 without video", async () => {
      const r = await get("/v1/watching/marktime", { id: FIX.MOVIE_SIMPLE, time: 100 });
      assert.equal(r.status, 400);
      assert.equal(r.headers.get(ACAO), "*");
      assert.equal(((await r.json()) as { status: number }).status, 400);
    });

    it("sets the movie position (video=1) and marks it in progress", async () => {
      assert.deepEqual(await json("/v1/watching/marktime", { id: FIX.MOVIE_SIMPLE, video: 1, time: "2500.7" }), { status: 200 });
      const rec = mock.state.watching.get(watchKey(FIX.MOVIE_SIMPLE, 0, 1));
      assert.equal(rec?.time, 2500);
      assert.equal(rec?.status, 0);
      const w = await json<WatchBody>("/v1/watching", { id: FIX.MOVIE_SIMPLE });
      assert.equal(w.item.videos?.[0].time, 2500);
      assert.equal(w.item.videos?.[0].status, 0);
    });

    it("changes watching.time in items/:id", { skip: itemsRouteReady ? false : "needs /v1/items/:id from stage 7" }, async () => {
      await json("/v1/watching/marktime", { id: FIX.MOVIE_SIMPLE, video: 1, time: 3100 });
      const card = await json<{ item: { videos: { watching: { status: number; time: number } }[] } }>(`/v1/items/${FIX.MOVIE_SIMPLE}`, { nolinks: 1 });
      assert.equal(card.item.videos[0].watching.time, 3100);
      assert.equal(card.item.videos[0].watching.status, 0);
    });

    it("keeps status 1 on a watched episode and sets 0 on a new one", async () => {
      await json("/v1/watching/marktime", { id: FIX.SERIAL_BIG, season: 1, video: 2, time: 40 });
      await json("/v1/watching/marktime", { id: FIX.SERIAL_BIG, season: 2, video: 3, time: 90 });
      const w = await json<WatchBody>("/v1/watching", { id: FIX.SERIAL_BIG });
      assert.deepEqual([episode(w, 1, 2)?.status, episode(w, 1, 2)?.time], [1, 40]);
      assert.deepEqual([episode(w, 2, 3)?.status, episode(w, 2, 3)?.time], [0, 90]);
    });
  });

  describe("toggle", () => {
    it("is a switch: twice returns the status back", async () => {
      const q = { id: FIX.SERIAL_BIG, season: 1, video: 1 };
      assert.deepEqual(await json("/v1/watching/toggle", q), { status: 200, watched: 0, watching: { status: -1 } });
      assert.equal(episode(await json<WatchBody>("/v1/watching", { id: FIX.SERIAL_BIG }), 1, 1)?.status, -1);
      assert.deepEqual(await json("/v1/watching/toggle", q), { status: 200, watched: 1, watching: { status: 1 } });
      assert.equal(episode(await json<WatchBody>("/v1/watching", { id: FIX.SERIAL_BIG }), 1, 1)?.status, 1);
    });

    it("marks an unwatched or in-progress unit as watched", async () => {
      assert.deepEqual(await json("/v1/watching/toggle", { id: FIX.SERIAL_BIG, season: 1, video: 4 }),
        { status: 200, watched: 1, watching: { status: 1 } });
      assert.deepEqual(await json("/v1/watching/toggle", { id: FIX.MOVIE_MULTI, video: 2 }),
        { status: 200, watched: 1, watching: { status: 1 } });
    });

    it("validates numbers like marktime", async () => {
      const noSeason = await get("/v1/watching/toggle", { id: FIX.SERIAL_BIG, video: 1 });
      assert.equal(noSeason.status, 404);
      assert.deepEqual(await noSeason.json(), NOT_FOUND);
      assert.equal((await get("/v1/watching/toggle", { id: FIX.SERIAL_BIG, season: 1 })).status, 400);
    });

    it("toggleLostResponse applies the switch, then drops the connection (CM-01)", async () => {
      mock.setScenario({ toggleLostResponse: 1 });
      const q = { id: FIX.MOVIE_SIMPLE, video: 1 };
      await assert.rejects(get("/v1/watching/toggle", q), TypeError);
      const w = await json<WatchBody>("/v1/watching", { id: FIX.MOVIE_SIMPLE });
      assert.equal(w.item.videos?.[0].status, 1);
      const lost = mock.calls().find((c) => c.path === "/v1/watching/toggle");
      assert.equal(lost?.status, 0);
      // Счётчик израсходован: следующий toggle отвечает (и снова переключает).
      assert.deepEqual(await json("/v1/watching/toggle", q), { status: 200, watched: 0, watching: { status: -1 } });
    });

    it("does not consume toggleLostResponse on an invalid request", async () => {
      mock.setScenario({ toggleLostResponse: 1 });
      assert.equal((await get("/v1/watching/toggle", { id: FIX.SERIAL_BIG, video: 1 })).status, 404);
      await assert.rejects(get("/v1/watching/toggle", { id: FIX.SERIAL_BIG, season: 3, video: 3 }), TypeError);
    });
  });

  describe("GET /v1/watching", () => {
    it("returns videos with time and status for a movie", async () => {
      const w = await json<WatchBody>("/v1/watching", { id: FIX.MOVIE_SIMPLE });
      assert.equal(w.status, 200);
      assert.equal(w.item.id, FIX.MOVIE_SIMPLE);
      assert.equal(w.item.type, "movie");
      assert.equal(w.item.status, 0);
      assert.equal(w.item.seasons, undefined);
      const v = w.item.videos?.[0];
      assert.deepEqual([v?.number, v?.time, v?.status, v?.duration], [1, 1200, 0, 5400]);
      assert.equal(typeof v?.updated, "number");
    });

    it("returns seasons with episode statuses for a serial", async () => {
      const w = await json<WatchBody>("/v1/watching", { id: FIX.SERIAL_BIG });
      assert.equal(w.item.videos, undefined);
      assert.equal(w.item.seasons?.length, 10);
      assert.equal(w.item.seasons?.[0].episodes.length, 20);
      assert.deepEqual([1, 2, 3, 4, 5].map((e) => episode(w, 1, e)?.status), [1, 1, 1, 0, -1]);
      assert.equal(episode(w, 1, 4)?.time, 600);
      assert.equal(episode(w, 1, 5)?.time, 0);
      assert.equal(w.item.seasons?.[0].status, 0);
      assert.equal(w.item.seasons?.[0].watched, 3);
      assert.equal(w.item.seasons?.[1].status, -1);
    });

    it("answers for a deleted title and 404 for an unknown one", async () => {
      assert.equal((await json<WatchBody>("/v1/watching", { id: FIX.MOVIE_DELETED })).item.status, -1);
      assert.equal((await get("/v1/watching", { id: 99_999 })).status, 404);
    });
  });

  describe("serials and movies", () => {
    it("lists serials with at least one watched episode", async () => {
      const { items } = await json<{ items: SerialRow[] }>("/v1/watching/serials");
      const big = items.find((s) => s.id === FIX.SERIAL_BIG);
      assert.equal(big?.watched, 3);
      assert.equal(big?.new, 2);
      assert.equal(Number(big?.total), 200);
      assert.equal(big?.type, "serial");
      assert.match(big?.posters.medium ?? "", /\/poster\/medium\/2001\.svg$/);
      assert.equal(items.find((s) => s.id === FIX.SERIAL_SMALL)?.new, 0);
      assert.deepEqual(items.map((s) => s.id).sort(), [FIX.SERIAL_BIG, FIX.SERIAL_SMALL]);
    });

    it("lists started movies and drops a movie once it is watched", async () => {
      type Movies = { items: { id: number; type: string; subtype: string; title: string; posters: Record<string, string> }[] };
      const { items } = await json<Movies>("/v1/watching/movies");
      assert.deepEqual(items.map((m) => m.id), [FIX.MOVIE_SIMPLE]);
      assert.equal(items[0].type, "movie");
      assert.equal(items[0].subtype, "");
      assert.ok(items[0].posters.small);
      await json("/v1/watching/toggle", { id: FIX.MOVIE_SIMPLE, video: 1 });
      assert.deepEqual((await json<Movies>("/v1/watching/movies")).items, []);
    });
  });

  describe("history", () => {
    it("starts in fixture order, sorted by last_seen", async () => {
      const h = await json<HistoryBody>("/v1/history");
      assert.deepEqual(h.history.map((e) => e.item.id), [FIX.SERIAL_BIG, FIX.MOVIE_SIMPLE, FIX.SERIAL_SMALL]);
      const first = h.history[0];
      assert.deepEqual([first.media.snumber, first.media.number, first.time], [1, 4, 600]);
      assert.equal(first.media.id, findItem(FIX.SERIAL_BIG)?.seasons?.[0].episodes[3].id);
      assert.ok(first.last_seen >= h.history[1].last_seen);
      assert.equal(first.item.type, "serial");
      assert.match(first.item.posters.medium, /\/poster\/medium\/2001\.svg$/);
      assert.deepEqual(h.pagination, { total: 1, current: 1, perpage: 20, total_items: 3 });
    });

    it("puts the last marktime first", async () => {
      await json("/v1/watching/marktime", { id: FIX.SERIAL_SMALL, season: 2, video: 1, time: 45 });
      await json("/v1/watching/marktime", { id: FIX.MOVIE_MULTI, video: 2, time: 300 });
      const h = await json<HistoryBody>("/v1/history");
      assert.deepEqual(h.history.map((e) => e.item.id).slice(0, 2), [FIX.MOVIE_MULTI, FIX.SERIAL_SMALL]);
      assert.deepEqual([h.history[0].media.number, h.history[0].time], [2, 300]);
      assert.deepEqual([h.history[1].media.snumber, h.history[1].media.number], [2, 1]);
      assert.equal(h.pagination.total_items, 5);
    });

    it("updates the entry of the same media instead of adding one", async () => {
      await json("/v1/watching/marktime", { id: FIX.MOVIE_SIMPLE, video: 1, time: 1300 });
      const h = await json<HistoryBody>("/v1/history");
      assert.equal(h.history.length, 3);
      assert.deepEqual([h.history[0].item.id, h.history[0].time], [FIX.MOVIE_SIMPLE, 1300]);
      assert.ok(h.history[0].counter >= 1);
      assert.ok(h.history[0].first_seen <= h.history[0].last_seen);
    });

    it("paginates and rejects perpage over 50", async () => {
      const p2 = await json<HistoryBody>("/v1/history", { page: 2, perpage: 2 });
      assert.deepEqual(p2.history.map((e) => e.item.id), [FIX.SERIAL_SMALL]);
      assert.deepEqual(p2.pagination, { total: 2, current: 2, perpage: 2, total_items: 3 });
      assert.equal((await json<HistoryBody>("/v1/history", { perpage: 50 })).history.length, 3);
      const r = await get("/v1/history", { perpage: 51 });
      assert.equal(r.status, 400);
      assert.equal(r.headers.get(ACAO), "*");
    });
  });
});
