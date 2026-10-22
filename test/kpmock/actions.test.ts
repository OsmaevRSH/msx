import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIX, findItem } from "../../tools/kpmock/fixtures.ts";
import { startMock } from "../../tools/kpmock/server.ts";
import type { MockServer } from "../../tools/kpmock/server.ts";

// kpmock для действий над плиткой (спец. §11.4): `togglewatchlist` и удаление из истории — по контрактам research
// kinopub-api §8.1, §8.3 (HipsterCat `watching.md`, `history.md`; aqualhume `history.md`).

interface Row { id: number }

describe("kpmock: togglewatchlist and history clear (tile actions)", () => {
  let mock: MockServer;
  let tok = "";
  const call = (method: "GET" | "POST", path: string, q: Record<string, string | number> = {}): Promise<Response> => {
    const qs = new URLSearchParams({ access_token: tok, ...Object.fromEntries(Object.entries(q).map(([k, v]) => [k, String(v)])) });
    return fetch(`${mock.url}${path}?${qs}`, { method });
  };
  const json = async <T>(method: "GET" | "POST", path: string, q: Record<string, string | number> = {}): Promise<T> => {
    const r = await call(method, path, q);
    assert.equal(r.status, 200, `${path} → ${r.status}`);
    return (await r.json()) as T;
  };
  const watchlist = async (): Promise<number[]> =>
    (await json<{ items: Row[] }>("GET", "/v1/watching/serials", { subscribed: 1 })).items.map((i) => i.id);
  const history = async (): Promise<number[]> =>
    (await json<{ history: { item: Row }[] }>("GET", "/v1/history", { perpage: 50 })).history.map((h) => h.item.id);

  before(async () => { mock = await startMock({ port: 0 }); });
  after(async () => { await mock.close(); });
  beforeEach(() => {
    mock.reset();
    tok = mock.issueToken().access;
  });

  describe("GET /v1/watching/togglewatchlist", () => {
    it("is a switch: the answer is the new state, «Я смотрю» follows it", async () => {
      assert.deepEqual(await watchlist(), [FIX.SERIAL_BIG, FIX.SERIAL_SMALL]);
      assert.deepEqual(await json("GET", "/v1/watching/togglewatchlist", { id: FIX.SERIAL_BIG }), { status: 200, watching: false });
      assert.deepEqual(await watchlist(), [FIX.SERIAL_SMALL]);
      assert.deepEqual(await json("GET", "/v1/watching/togglewatchlist", { id: FIX.SERIAL_BIG }), { status: 200, watching: true });
      assert.deepEqual(await watchlist(), [FIX.SERIAL_BIG, FIX.SERIAL_SMALL]);
    });

    it("removed from «Я смотрю»: subscribed=0 («Продолжить» главной) still lists it, the same as without the parameter", async () => {
      const all = async (q: Record<string, number>): Promise<number[]> =>
        (await json<{ items: Row[] }>("GET", "/v1/watching/serials", q)).items.map((i) => i.id);
      assert.deepEqual(await all({ subscribed: 0 }), await all({}));
      await json("GET", "/v1/watching/togglewatchlist", { id: FIX.SERIAL_BIG });
      assert.ok(!(await watchlist()).includes(FIX.SERIAL_BIG));
      assert.ok((await all({ subscribed: 0 })).includes(FIX.SERIAL_BIG));
    });

    it("adds a serial that was never started; the list without `subscribed` does not change", async () => {
      const before = (await json<{ items: Row[] }>("GET", "/v1/watching/serials")).items.map((i) => i.id);
      assert.deepEqual(await json("GET", "/v1/watching/togglewatchlist", { id: FIX.SERIAL_LONG }), { status: 200, watching: true });
      assert.ok((await watchlist()).includes(FIX.SERIAL_LONG));
      assert.deepEqual((await json<{ items: Row[] }>("GET", "/v1/watching/serials")).items.map((i) => i.id), before);
    });

    it("unknown title → 404; without a token → 401", async () => {
      assert.equal((await call("GET", "/v1/watching/togglewatchlist", { id: 99_999 })).status, 404);
      tok = "";
      assert.equal((await call("GET", "/v1/watching/togglewatchlist", { id: FIX.SERIAL_BIG })).status, 401);
    });

    it("watchlistLostResponse applies the switch, then drops the connection (CM-01)", async () => {
      mock.setScenario({ watchlistLostResponse: 1 });
      await assert.rejects(call("GET", "/v1/watching/togglewatchlist", { id: FIX.SERIAL_BIG }), TypeError);
      assert.deepEqual(await watchlist(), [FIX.SERIAL_SMALL], "applied");
      assert.equal(mock.calls().find((c) => c.path === "/v1/watching/togglewatchlist")?.status, 0);
      assert.deepEqual(await json("GET", "/v1/watching/togglewatchlist", { id: FIX.SERIAL_BIG }), { status: 200, watching: true });
    });

    it("reset forgets the choices", async () => {
      await json("GET", "/v1/watching/togglewatchlist", { id: FIX.SERIAL_BIG });
      mock.reset();
      tok = mock.issueToken().access;
      assert.deepEqual(await watchlist(), [FIX.SERIAL_BIG, FIX.SERIAL_SMALL]);
    });
  });

  describe("POST /v1/history/clear-for-*", () => {
    it("clear-for-item: HTTP 200 with a JSON null body; every record of the title is gone, watching state stays", async () => {
      await json("GET", "/v1/watching/marktime", { id: FIX.SERIAL_BIG, season: 1, video: 5, time: 60 });
      assert.deepEqual(await history(), [FIX.SERIAL_BIG, FIX.SERIAL_BIG, FIX.MOVIE_SIMPLE, FIX.SERIAL_SMALL]);
      const r = await call("POST", "/v1/history/clear-for-item", { id: FIX.SERIAL_BIG });
      assert.equal(r.status, 200);
      assert.match(r.headers.get("content-type") ?? "", /^application\/json/);
      assert.equal(await r.text(), "null");
      assert.deepEqual(await history(), [FIX.MOVIE_SIMPLE, FIX.SERIAL_SMALL]);
      const w = await json<{ item: { status: number } }>("GET", "/v1/watching", { id: FIX.SERIAL_BIG });
      assert.equal(w.item.status, 0, "progress is not history");
    });

    it("clear-for-media and clear-for-season take media and season ids", async () => {
      const big = findItem(FIX.SERIAL_BIG);
      const ep4 = big?.seasons?.[0]?.episodes.find((e) => e.number === 4)?.id ?? 0;
      await json("GET", "/v1/watching/marktime", { id: FIX.SERIAL_BIG, season: 1, video: 5, time: 60 });
      assert.equal(await (await call("POST", "/v1/history/clear-for-media", { id: ep4 })).text(), "null");
      assert.deepEqual(await history(), [FIX.SERIAL_BIG, FIX.MOVIE_SIMPLE, FIX.SERIAL_SMALL]);
      const small = findItem(FIX.SERIAL_SMALL)?.seasons?.[0]?.id ?? 0;
      await call("POST", "/v1/history/clear-for-season", { id: small });
      assert.deepEqual(await history(), [FIX.SERIAL_BIG, FIX.MOVIE_SIMPLE]);
    });

    it("an unknown id changes nothing; without a token → 401", async () => {
      assert.equal((await call("POST", "/v1/history/clear-for-item", { id: 99_999 })).status, 200);
      assert.deepEqual(await history(), [FIX.SERIAL_BIG, FIX.MOVIE_SIMPLE, FIX.SERIAL_SMALL]);
      tok = "";
      assert.equal((await call("POST", "/v1/history/clear-for-item", { id: FIX.SERIAL_BIG })).status, 401);
    });
  });
});
