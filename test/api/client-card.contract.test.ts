import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Priority } from "../../src/api/transport.ts";
import { FIX, castOf, directorOf, findItem } from "../../tools/kpmock/fixtures.ts";
import { watchKey } from "../../tools/kpmock/state.ts";
import { kp, q, useKpApiMock } from "./kpapi-rig.ts";

// Contract-тесты KpApi пакета «Карточка» (v1.19) против kpmock: «Буду смотреть», сезон целиком, трейлер, поиск по
// актёру и режиссёру, новые поля карточки.

describe("KpApi card package against kpmock (contract, v1.19)", () => {
  const env = useKpApiMock();

  it("item: watchlist, director, cast (≤ 8), trailer without url under nolinks=1", async () => {
    const r = env.rig();
    const d = await r.run(r.api.item(FIX.SERIAL_BIG));
    assert.equal(d.watchlist, true);
    const big = findItem(FIX.SERIAL_BIG)!;
    assert.deepEqual(d.director, directorOf(big));
    assert.deepEqual(d.cast, castOf(big).slice(0, 8));
    assert.deepEqual(d.trailer, {});
    assert.equal((await r.run(r.api.item(FIX.MOVIE_MULTI))).trailer, undefined);
    assert.equal((await r.run(r.api.item(FIX.MOVIE_SIMPLE))).watchlist, false);
  });

  it("toggleWatchlist: GET with id, no automatic retry (CM-01), the new state; fg by default, a Priority — its class", async () => {
    const r = env.rig();
    assert.deepEqual(await r.run(r.api.toggleWatchlist(FIX.SERIAL_BIG)), { watching: false });
    assert.deepEqual(await r.run(r.api.toggleWatchlist(FIX.SERIAL_BIG, new Priority("bg"))), { watching: true });
    const sent = r.t.reqs.filter((x) => x.path === "/v1/watching/togglewatchlist");
    assert.deepEqual(sent.map((x) => [x.method, x.retry, x.cls]), [["GET", "none", "fg"], ["GET", "none", "bg"]]);
    assert.equal(q(env.calls("/v1/watching/togglewatchlist")[0]).get("id"), String(FIX.SERIAL_BIG));
  });

  it("toggleWatchlist with a dropped connection → exactly one call and KP-NET", async () => {
    env.mock().setScenario({ rules: [{ path: "^/v1/watching/togglewatchlist$", drop: true }] });
    const r = env.rig();
    await assert.rejects(r.run(r.api.toggleWatchlist(FIX.SERIAL_BIG)), kp("KP-NET"));
    assert.equal(env.calls("/v1/watching/togglewatchlist").length, 1);
  });

  it("toggleSeason: toggle with id and season, without video; no retry; the new state", async () => {
    const r = env.rig();
    assert.deepEqual(await r.run(r.api.toggleSeason(FIX.SERIAL_SMALL, 2)), { watched: 1 });
    const c = env.calls("/v1/watching/toggle")[0];
    assert.deepEqual([q(c).get("id"), q(c).get("season"), q(c).has("video")], [String(FIX.SERIAL_SMALL), "2", false]);
    assert.equal(r.t.reqs.find((x) => x.path === "/v1/watching/toggle")?.retry, "none");
    const small = findItem(FIX.SERIAL_SMALL)!.seasons![1]!;
    assert.ok(small.episodes.every((e) => env.mock().state.watching.get(watchKey(FIX.SERIAL_SMALL, 2, e.number))?.status === 1));
  });

  it("trailer: the file from items/trailer; a title without one — KP-404", async () => {
    const r = env.rig();
    const url = await r.run(r.api.trailer(FIX.MOVIE_SIMPLE));
    assert.match(url ?? "", /\/cdn\/media\/sample\.webm\?trailer=\d+$/);
    assert.equal(q(env.calls("/v1/items/trailer")[0]).get("id"), String(FIX.MOVIE_SIMPLE));
    await assert.rejects(r.run(r.api.trailer(FIX.MOVIE_MULTI)), kp("KP-404"));
  });

  it("searchBy: field=cast|director, one name, page and perpage", async () => {
    const r = env.rig();
    const name = castOf(findItem(FIX.SERIAL_BIG)!)[2]!;
    const page = await r.run(r.api.searchBy("cast", name, 1, 48));
    assert.ok(page.items.length > 0 && page.items.length <= 48);
    assert.ok((page.pagination.totalItems ?? 0) >= page.items.length);
    const c = env.calls("/v1/items/search")[0];
    assert.deepEqual([q(c).get("q"), q(c).get("field"), q(c).get("page"), q(c).get("perpage")], [name, "cast", "1", "48"]);
    const dir = await r.run(r.api.searchBy("director", directorOf(findItem(FIX.MOVIE_SIMPLE)!)[0]!, 1, 48, "bg"));
    assert.ok(dir.items.length > 0);
    assert.equal(q(env.calls("/v1/items/search")[1]).get("field"), "director");
  });
});
