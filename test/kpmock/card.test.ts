import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIX, castOf, directorOf, findItem, trailerOf } from "../../tools/kpmock/fixtures.ts";
import { startMock } from "../../tools/kpmock/server.ts";
import type { MockServer } from "../../tools/kpmock/server.ts";
import { watchKey } from "../../tools/kpmock/state.ts";

// v1.16, пакет «Карточка»: контракты kpmock по исходникам клиентов — «Буду смотреть» (`togglewatchlist`), сезон целиком
// (`toggle` без `video`), трейлер (`items/trailer`), поиск по актёру и режиссёру (`field=cast|director`). Строго, как
// v1.14: обязательные параметры — HTTP 400, неизвестное — 404.

const ACAO = "access-control-allow-origin";
const NOT_FOUND = { status: 404, error: "Not found" };
const UNIT_NOT_FOUND = { status: 404, error: "Requested item or video not found." };

interface Card { in_watchlist: boolean; subscribed: boolean; cast: string; director: string; trailer: Record<string, unknown> | null }
interface ListBody { items: (Card & { id: number; type: string })[]; pagination: { total_items: number } }
interface Serial { id: number; total: string; watched: number }

describe("kpmock: card package (v1.16)", () => {
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
  const card = async (id: number): Promise<Card> => (await json<{ item: Card }>(`/v1/items/${id}`, { nolinks: 1 })).item;
  const subscribed = async (): Promise<number[]> =>
    (await json<{ items: Serial[] }>("/v1/watching/serials", { subscribed: 1 })).items.map((s) => s.id);
  const firstOf = (type: string): number => [...Array(500).keys()].map((i) => 1000 + i).find((id) => findItem(id)?.type === type)!;
  const statuses = (id: number, season: number): (number | undefined)[] =>
    (findItem(id)?.seasons?.find((s) => s.number === season)?.episodes ?? [])
      .map((e) => mock.state.watching.get(watchKey(id, season, e.number))?.status ?? -1);

  before(async () => { mock = await startMock({ port: 0 }); });
  after(async () => { await mock.close(); });
  beforeEach(() => {
    mock.reset();
    tok = mock.issueToken().access;
  });

  describe("card fields", () => {
    it("cast and director are synthetic comma strings; a concert has neither", async () => {
      const big = await card(FIX.SERIAL_BIG);
      assert.equal(big.cast, castOf(findItem(FIX.SERIAL_BIG)!).join(", "));
      assert.equal(big.director, directorOf(findItem(FIX.SERIAL_BIG)!).join(", "));
      assert.ok(castOf(findItem(FIX.SERIAL_BIG)!).length >= 6, "SERIAL_BIG: a cast longer than the card line");
      const concert = findItem(firstOf("concert"))!;
      assert.deepEqual([castOf(concert), directorOf(concert)], [[], []]);
      assert.deepEqual([(await card(concert.id)).cast, (await card(concert.id)).director], ["", ""]);
    });

    it("trailer {id, file} without url under nolinks=1 (unknown on the live API — the strict side); none — null", async () => {
      const t = (await card(FIX.SERIAL_BIG)).trailer;
      assert.deepEqual(Object.keys(t ?? {}).sort(), ["file", "id"]);
      assert.equal(trailerOf(FIX.MOVIE_MULTI), undefined);
      assert.equal((await card(FIX.MOVIE_MULTI)).trailer, null);
    });

    it("in_watchlist and its alias subscribed: started unfinished serials by default; a movie — false", async () => {
      const big = await card(FIX.SERIAL_BIG);
      assert.deepEqual([big.in_watchlist, big.subscribed], [true, true]);
      assert.equal((await card(firstOf("serial"))).in_watchlist, false);
      assert.equal((await card(FIX.MOVIE_SIMPLE)).in_watchlist, false);
    });
  });

  describe("GET /v1/watching/togglewatchlist", () => {
    it("toggles: the answer, the card and serials?subscribed=1 follow (HC watching.md: {status, watching})", async () => {
      assert.deepEqual(await subscribed(), [FIX.SERIAL_BIG, FIX.SERIAL_SMALL]);
      assert.deepEqual(await json("/v1/watching/togglewatchlist", { id: FIX.SERIAL_BIG }), { status: 200, watching: false });
      assert.equal((await card(FIX.SERIAL_BIG)).in_watchlist, false);
      assert.deepEqual(await subscribed(), [FIX.SERIAL_SMALL]);
      assert.deepEqual(await json("/v1/watching/togglewatchlist", { id: FIX.SERIAL_BIG }), { status: 200, watching: true });
      assert.deepEqual(await subscribed(), [FIX.SERIAL_BIG, FIX.SERIAL_SMALL]);
    });

    it("an unstarted serial joins «Я смотрю» with nothing watched", async () => {
      const serial = firstOf("serial");
      assert.equal((await card(serial)).in_watchlist, false);
      assert.deepEqual(await json("/v1/watching/togglewatchlist", { id: serial }), { status: 200, watching: true });
      const row = (await json<{ items: Serial[] }>("/v1/watching/serials", { subscribed: 1 })).items.find((s) => s.id === serial);
      assert.equal(row?.watched, 0);
      assert.ok(Number(row?.total) > 0);
      assert.equal((await card(serial)).subscribed, true);
    });

    it("strict: no id — 400 in the Yii format; unknown, deleted or a movie — 404", async () => {
      const r = await get("/v1/watching/togglewatchlist");
      assert.equal(r.status, 400);
      assert.equal(r.headers.get(ACAO), "*");
      assert.equal(((await r.json()) as { message: string }).message, "Отсутствуют обязательные параметры: id");
      for (const id of [99_999, FIX.MOVIE_DELETED, FIX.MOVIE_SIMPLE]) {
        const nf = await get("/v1/watching/togglewatchlist", { id });
        assert.equal(nf.status, 404, String(id));
        assert.deepEqual(await nf.json(), NOT_FOUND);
      }
      const unauth = await fetch(`${mock.url}/v1/watching/togglewatchlist?id=${FIX.SERIAL_BIG}`);
      assert.equal(unauth.status, 401);
    });
  });

  describe("GET /v1/watching/toggle without video — the whole season (HC watching.md: «модификации подвергаются все эпизоды сезона»)", () => {
    it("a part-watched season becomes watched, a watched one — unwatched (Apple: «flips the season to the opposite»)", async () => {
      assert.deepEqual(statuses(FIX.SERIAL_BIG, 1).slice(0, 5), [1, 1, 1, 0, -1]);
      assert.deepEqual(await json("/v1/watching/toggle", { id: FIX.SERIAL_BIG, season: 1 }), { status: 200, watched: 1, watching: { status: 1 } });
      assert.ok(statuses(FIX.SERIAL_BIG, 1).every((s) => s === 1));
      assert.equal(mock.state.watching.get(watchKey(FIX.SERIAL_BIG, 1, 4))?.time, 600, "the position stays");
      assert.ok(statuses(FIX.SERIAL_BIG, 2).every((s) => s === -1), "other seasons untouched");
      assert.deepEqual(await json("/v1/watching/toggle", { id: FIX.SERIAL_BIG, season: 1 }), { status: 200, watched: 0, watching: { status: -1 } });
      assert.ok(statuses(FIX.SERIAL_BIG, 1).every((s) => s === -1));
    });

    it("a multipart movie without video — all its videos (Kodi: subtype multi, no kwargs)", async () => {
      assert.deepEqual(await json("/v1/watching/toggle", { id: FIX.MOVIE_MULTI }), { status: 200, watched: 1, watching: { status: 1 } });
      assert.deepEqual([1, 2, 3].map((v) => mock.state.watching.get(watchKey(FIX.MOVIE_MULTI, 0, v))?.status), [1, 1, 1]);
    });

    it("strict: a serial without season or with an unknown one — 404 with the API text; no id — 404", async () => {
      for (const q of [{ id: FIX.SERIAL_BIG }, { id: FIX.SERIAL_BIG, season: 11 }, { id: 99_999, season: 1 }] as Record<string, number>[]) {
        const r = await get("/v1/watching/toggle", q);
        assert.equal(r.status, 404, JSON.stringify(q));
        assert.deepEqual(await r.json(), UNIT_NOT_FOUND);
      }
    });

    it("toggleLostResponse applies the season switch and drops the connection (CM-01)", async () => {
      mock.setScenario({ toggleLostResponse: 1 });
      await assert.rejects(get("/v1/watching/toggle", { id: FIX.SERIAL_SMALL, season: 2 }), TypeError);
      assert.ok(statuses(FIX.SERIAL_SMALL, 2).every((s) => s === 1));
    });
  });

  describe("GET /v1/items/trailer", () => {
    it("files[].url — a playable file on the mock CDN, url — an external page (Kodi main.py: prefer the file)", async () => {
      const b = await json<{ status: number; trailer: { id: number; url: string; files: { url: string; quality: string }[] } }>(
        "/v1/items/trailer", { id: FIX.SERIAL_BIG });
      assert.equal(b.status, 200);
      assert.equal(b.trailer.id, trailerOf(FIX.SERIAL_BIG));
      assert.match(b.trailer.url, /youtube/);
      assert.ok(b.trailer.files[0]?.url.startsWith(`${mock.url}/cdn/media/sample.webm?`));
    });

    it("strict: no id — 400 in the Yii format; unknown, deleted or without a trailer — 404", async () => {
      const r = await get("/v1/items/trailer");
      assert.equal(r.status, 400);
      assert.equal(((await r.json()) as { message: string }).message, "Отсутствуют обязательные параметры: id");
      for (const id of [99_999, FIX.MOVIE_DELETED, FIX.MOVIE_MULTI]) assert.equal((await get("/v1/items/trailer", { id })).status, 404, String(id));
    });
  });

  describe("GET /v1/items/search field=cast|director (HC video.md: one field per request, without field — titles only)", () => {
    it("field=cast finds the filmography of one name; field=director — of a director", async () => {
      const big = findItem(FIX.SERIAL_BIG)!;
      const actor = castOf(big)[0]!;
      const byCast = await json<ListBody>("/v1/items/search", { q: actor, field: "cast", perpage: 1000 });
      assert.ok(byCast.items.some((it) => it.id === FIX.SERIAL_BIG));
      assert.ok(byCast.items.every((it) => it.cast.includes(actor)));
      const director = directorOf(big)[0]!;
      const byDir = await json<ListBody>("/v1/items/search", { q: director, field: "director", perpage: 1000 });
      assert.ok(byDir.items.some((it) => it.id === FIX.SERIAL_BIG));
      assert.ok(byDir.items.every((it) => it.director.includes(director)));
    });

    it("a name is not found by title or without field; field=title,cast reads as the title (HC 2026-09-26)", async () => {
      const actor = castOf(findItem(FIX.SERIAL_BIG)!)[0]!;
      for (const q of [{ q: actor }, { q: actor, field: "title" }, { q: actor, field: "title,cast" }] as Record<string, string>[]) {
        assert.equal((await json<ListBody>("/v1/items/search", q)).pagination.total_items, 0, JSON.stringify(q));
      }
    });
  });
});
