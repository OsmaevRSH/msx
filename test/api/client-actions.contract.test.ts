import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { kp, q, useKpApiMock } from "./kpapi-rig.ts";

// Contract-тесты KpApi для действий над плиткой (спец. §11.4): `togglewatchlist` — переключатель без автоповтора (CM-01),
// удаление из истории — POST с `id` в query и телом ответа `null` (research kinopub-api §8.1, §8.3).

describe("KpApi tile actions against kpmock (contract)", () => {
  const env = useKpApiMock();
  const watchlist = async (r: ReturnType<typeof env.rig>): Promise<number[]> =>
    (await r.run(r.api.watchingSerials("fg", true))).map((s) => s.id);

  it("toggleWatchlist returns the new state and flips it; GET with id, fg, no auto-retry", async () => {
    const r = env.rig();
    assert.deepEqual(await r.run(r.api.toggleWatchlist(FIX.SERIAL_BIG)), { watching: false });
    assert.deepEqual(await watchlist(r), [FIX.SERIAL_SMALL]);
    assert.deepEqual(await r.run(r.api.toggleWatchlist(FIX.SERIAL_BIG, "bg")), { watching: true });
    const calls = env.calls("/v1/watching/togglewatchlist");
    assert.deepEqual(calls.map((c) => `${c.method} ${q(c).get("id")}`), [`GET ${FIX.SERIAL_BIG}`, `GET ${FIX.SERIAL_BIG}`]);
    const sent = r.t.reqs.filter((x) => x.path === "/v1/watching/togglewatchlist");
    assert.deepEqual(sent.map((x) => `${x.cls} ${x.retry}`), ["fg none", "bg none"]);
  });

  it("toggleWatchlist with a dropped connection → exactly one call and KP-NET (CM-01)", async () => {
    env.mock().setScenario({ rules: [{ path: "^/v1/watching/togglewatchlist$", drop: true }] });
    const r = env.rig();
    await assert.rejects(r.run(r.api.toggleWatchlist(FIX.SERIAL_BIG)), kp("KP-NET"));
    assert.equal(env.calls("/v1/watching/togglewatchlist").length, 1);
  });

  it("toggleWatchlist whose response is lost after applying → one call, KP-NET, state changed", async () => {
    env.mock().setScenario({ watchlistLostResponse: 1 });
    const r = env.rig();
    await assert.rejects(r.run(r.api.toggleWatchlist(FIX.SERIAL_BIG)), kp("KP-NET"));
    assert.equal(env.calls("/v1/watching/togglewatchlist").length, 1);
    assert.deepEqual(await watchlist(r), [FIX.SERIAL_SMALL]);
  });

  it("historyClearItem: POST with id in the query and an empty body; the JSON null answer is a success", async () => {
    const r = env.rig();
    await r.run(r.api.historyClearItem(FIX.MOVIE_SIMPLE));
    const [c] = env.calls("/v1/history/clear-for-item");
    assert.equal(c?.method, "POST");
    assert.equal(q(c!).get("id"), String(FIX.MOVIE_SIMPLE));
    assert.deepEqual((await r.run(r.api.history(1, 50))).map((e) => e.item.id), [FIX.SERIAL_BIG, FIX.SERIAL_SMALL]);
  });

  it("API-6: historyClearItem(mid, \"media\") removes one episode — POST clear-for-media with the media id", async () => {
    const r = env.rig();
    const [first] = await r.run(r.api.history(1, 50));
    assert.ok(first !== undefined && first.media.id > 0);
    await r.run(r.api.historyClearItem(first.media.id, "media"));
    const [c] = env.calls("/v1/history/clear-for-media");
    assert.deepEqual([c?.method, q(c!).get("id")], ["POST", String(first.media.id)]);
    assert.ok(!(await r.run(r.api.history(1, 50))).some((e) => e.media.id === first.media.id));
  });

  it("historyClearItem is idempotent: a 5xx is retried, the title is gone once", async () => {
    env.mock().setScenario({ rules: [{ path: "^/v1/history/clear-for-item$", status: 502, times: 1 }] });
    const r = env.rig();
    await r.run(r.api.historyClearItem(FIX.SERIAL_BIG));
    assert.equal(env.calls("/v1/history/clear-for-item").length, 2);
    assert.deepEqual((await r.run(r.api.history(1, 50))).map((e) => e.item.id), [FIX.MOVIE_SIMPLE, FIX.SERIAL_SMALL]);
  });
});
