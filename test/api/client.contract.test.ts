import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { KpError } from "../../src/core/errors.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { kp, q, useKpApiMock } from "./kpapi-rig.ts";

// Contract-тесты KpApi против kpmock (этапы 3, 6–8): каталог, личные данные, прогресс, устройство, ошибки.
// OAuth, повтор после 401 и таблица повторов — в client-auth.contract.test.ts.

describe("KpApi against kpmock (contract)", () => {
  const env = useKpApiMock((router) => {
    router.add("GET", "/v1/test/body-404", () => ({ status: 200, json: { status: 404, error: "Requested item or video not found." } }));
  });

  describe("catalog", () => {
    it("items: page of movies with tolerant numbers", async () => {
      const r = env.rig();
      const page = await r.run(r.api.items({ type: "movie", sort: "-updated", page: 2, perpage: 10 }));
      assert.equal(page.items.length, 10);
      assert.ok(page.items.every((it) => it.type === "movie" && it.id > 0 && it.posters.medium !== ""));
      assert.ok(page.items.every((it) => typeof it.year === "number"));
      assert.equal(page.pagination.current, 2);
      assert.equal(page.pagination.perpage, 10);
      assert.ok(page.pagination.totalItems > 20);
      assert.equal(page.pagination.total, Math.ceil(page.pagination.totalItems / 10));
      const c = env.calls("/v1/items")[0];
      assert.deepEqual([q(c).get("type"), q(c).get("sort"), q(c).get("page"), q(c).get("perpage")], ["movie", "-updated", "2", "10"]);
      assert.equal(q(c).has("genre"), false);
    });

    it("shelf, search and similar", async () => {
      const r = env.rig();
      const shelf = await r.run(r.api.shelf("popular", { type: "serial", page: 1, perpage: 7 }));
      assert.equal(shelf.items.length, 7);
      assert.ok(shelf.items.every((it) => it.type === "serial"));
      const found = await r.run(r.api.search("Простой", 1, 20));
      assert.deepEqual(found.items.map((it) => it.id), [FIX.MOVIE_SIMPLE]);
      const sc = env.calls("/v1/items/search")[0];
      assert.equal(q(sc).get("q"), "Простой");
      assert.equal(q(sc).get("field"), "title");
      const similar = await r.run(r.api.similar(FIX.MOVIE_SIMPLE));
      assert.equal(similar.length, 12);
      assert.ok(similar.every((it) => it.type === "movie" && it.id !== FIX.MOVIE_SIMPLE));
    });

    it("item(2001): serial card with nolinks=1, progress and bookmarks", async () => {
      const r = env.rig();
      const d = await r.run(r.api.item(FIX.SERIAL_BIG));
      assert.equal(d.id, FIX.SERIAL_BIG);
      assert.equal(d.type, "serial");
      assert.equal(d.seasons.length, 10);
      assert.equal(d.seasons[0].episodes.length, 20);
      const eps = d.seasons[0].episodes;
      assert.deepEqual(eps.slice(0, 5).map((e) => e.watching.status), [1, 1, 1, 0, -1]);
      assert.equal(eps[3].watching.time, 600);
      assert.equal(eps[0].snumber, 1);
      assert.ok(eps[0].audios.length > 0 && eps[0].files.length === 3);
      assert.ok(eps.every((e) => e.files.every((f) => Object.keys(f.urls).length === 0)), "nolinks=1: no stream urls in the card");
      assert.deepEqual(d.bookmarks, [1]);
      assert.equal(q(env.calls(`/v1/items/${FIX.SERIAL_BIG}`)[0]).get("nolinks"), "1");
    });

    it("mediaLinks: urls, full subtitles, the requested mid", async () => {
      const r = env.rig();
      const mid = FIX.MOVIE_SIMPLE * 1000 + 1;
      const ml = await r.run(r.api.mediaLinks(mid, "fg"));
      assert.equal(ml.mid, mid);
      assert.equal(ml.files.length, 3);
      assert.ok(ml.files.every((f) => f.urls.hls?.includes("master-v1a1.m3u8") && f.urls.hls2 && f.urls.hls4 && f.urls.http));
      assert.equal(ml.subtitles.length, 5);
      assert.ok(ml.subtitles.some((s) => s.forced));
      assert.equal(q(env.calls("/v1/items/media-links")[0]).get("mid"), String(mid));
    });

    it("references: genres, server locations, voiceover types; raw", async () => {
      const r = env.rig();
      const genres = await r.run(r.api.genres("movie"));
      assert.ok(genres.some((g) => g.id === FIX.GENRE_ANIM && g.title === "Мультфильм"));
      assert.equal(q(env.calls("/v1/genres")[0]).get("type"), "movie");
      const locs = await r.run(r.api.serverLocations());
      assert.deepEqual(locs[0], { id: 1, location: "nl", name: "Netherlands" });
      const vo = await r.run(r.api.voiceoverTypes());
      assert.ok(vo.some((v) => v.id === 6 && v.title === "Оригинал"));
      const raw = (await r.run(r.api.raw("/v1/types"))) as { items: unknown[] };
      assert.equal(raw.items.length, 7);
    });
  });

  describe("personal data", () => {
    it("watching(id) for a serial and a movie", async () => {
      const r = env.rig();
      const serial = await r.run(r.api.watching(FIX.SERIAL_BIG));
      assert.equal(serial.length, 200);
      assert.deepEqual(serial[3], { number: 4, season: 1, status: 0, time: 600, duration: serial[3].duration });
      assert.ok(serial[3].duration > 0);
      const movie = await r.run(r.api.watching(FIX.MOVIE_SIMPLE));
      assert.deepEqual(movie, [{ number: 1, season: 0, status: 0, time: 1200, duration: 5400 }]);
    });

    it("history, watching serials (total as a string) and movies", async () => {
      const r = env.rig();
      const h = await r.run(r.api.history(1, 20));
      assert.deepEqual(h.map((e) => e.item.id), [FIX.SERIAL_BIG, FIX.MOVIE_SIMPLE, FIX.SERIAL_SMALL]);
      assert.deepEqual({ number: h[0].media.number, snumber: h[0].media.snumber }, { number: 4, snumber: 1 });
      assert.equal(h[0].time, 600);
      assert.ok(h[0].lastSeen > 0);
      const serials = await r.run(r.api.watchingSerials());
      assert.deepEqual(serials.map((s) => [s.id, s.total, s.watched, s.new]), [[FIX.SERIAL_BIG, 200, 3, 2], [FIX.SERIAL_SMALL, 6, 1, 0]]);
      const movies = await r.run(r.api.watchingMovies());
      assert.deepEqual(movies.map((m) => m.id), [FIX.MOVIE_SIMPLE]);
    });

    it("history perpage is capped at 50 (research §8.3)", async () => {
      const r = env.rig();
      const h = await r.run(r.api.history(1, 100));
      assert.equal(h.length, 3);
      assert.equal(q(env.calls("/v1/history")[0]).get("perpage"), "50");
    });

    it("user, bookmark folders and a folder page", async () => {
      const r = env.rig();
      const user = await r.run(r.api.user());
      assert.equal(user.username, "tester");
      assert.equal(user.subscription.active, true);
      assert.equal(user.subscription.days, 30);
      const folders = await r.run(r.api.bookmarkFolders());
      assert.deepEqual(folders, [{ id: 1, title: "Избранное", count: 2 }]);
      const page = await r.run(r.api.bookmarkFolder(1, 1, 48));
      assert.deepEqual(page.items.map((it) => it.id), [FIX.MOVIE_SIMPLE, FIX.SERIAL_BIG]);
      assert.equal(page.pagination.totalItems, 2);
    });

    it("bookmarks: create, add, remove", async () => {
      const r = env.rig();
      const f = await r.run(r.api.bookmarkCreate("Позже"));
      assert.ok(f.id > 0);
      assert.deepEqual({ title: f.title, count: f.count }, { title: "Позже", count: 0 });
      await r.run(r.api.bookmarkAdd(FIX.SERIAL_SMALL, f.id));
      assert.equal((await r.run(r.api.bookmarkFolders())).find((x) => x.id === f.id)?.count, 1);
      await r.run(r.api.bookmarkRemove(FIX.SERIAL_SMALL, f.id));
      assert.equal((await r.run(r.api.bookmarkFolders())).find((x) => x.id === f.id)?.count, 0);
      for (const c of env.calls().filter((x) => x.method === "POST")) assert.match(c.contentType ?? "", /^application\/x-www-form-urlencoded/);
    });
  });

  describe("progress", () => {
    it("marktime of a serial passes season and video as numbers", async () => {
      const r = env.rig();
      await r.run(r.api.marktime(FIX.SERIAL_BIG, 5, 120, 1));
      const p = q(env.calls("/v1/watching/marktime")[0]);
      assert.deepEqual([p.get("id"), p.get("video"), p.get("season"), p.get("time")], [String(FIX.SERIAL_BIG), "5", "1", "120"]);
      const units = await r.run(r.api.watching(FIX.SERIAL_BIG));
      assert.deepEqual(units[4], { number: 5, season: 1, status: 0, time: 120, duration: units[4].duration });
    });

    it("marktime of a movie has no season; time is whole seconds", async () => {
      const r = env.rig();
      await r.run(r.api.marktime(FIX.MOVIE_SIMPLE, 1, 300.7));
      const p = q(env.calls("/v1/watching/marktime")[0]);
      assert.equal(p.has("season"), false);
      assert.deepEqual([p.get("id"), p.get("video"), p.get("time")], [String(FIX.MOVIE_SIMPLE), "1", "300"]);
    });

    it("toggle returns the new state and flips it", async () => {
      const r = env.rig();
      assert.deepEqual(await r.run(r.api.toggle(FIX.MOVIE_SIMPLE, 1)), { watched: 1 });
      assert.deepEqual(await r.run(r.api.toggle(FIX.MOVIE_SIMPLE, 1)), { watched: 0 });
      assert.deepEqual(await r.run(r.api.toggle(FIX.SERIAL_BIG, 1, 1)), { watched: 0 });
      assert.equal(q(env.calls("/v1/watching/toggle")[2]).get("season"), "1");
    });

    it("toggle with a dropped connection → exactly one call and KP-NET (CM-01)", async () => {
      env.mock().setScenario({ rules: [{ path: "^/v1/watching/toggle$", drop: true }] });
      const r = env.rig();
      await assert.rejects(r.run(r.api.toggle(FIX.MOVIE_SIMPLE, 1)), kp("KP-NET"));
      assert.equal(env.calls("/v1/watching/toggle").length, 1);
    });

    it("toggle whose response is lost after applying → one call, KP-NET, state changed", async () => {
      env.mock().setScenario({ toggleLostResponse: 1 });
      const r = env.rig();
      await assert.rejects(r.run(r.api.toggle(FIX.MOVIE_SIMPLE, 1)), kp("KP-NET"));
      assert.equal(env.calls("/v1/watching/toggle").length, 1);
      assert.equal((await r.run(r.api.watching(FIX.MOVIE_SIMPLE)))[0].status, 1);
    });
  });

  describe("device", () => {
    it("deviceInfo reads the settings wrapper; deviceSettingsSave really changes settings", async () => {
      const r = env.rig();
      const before = await r.run(r.api.deviceInfo());
      assert.ok(before.id > 0);
      assert.equal(before.title, "kpmock TV");
      assert.deepEqual(before.settings, { supportSsl: 1, supportHevc: 0, supportHdr: 0, support4k: 0, mixedPlaylist: 0 });
      await r.run(r.api.deviceSettingsSave(before.id, { supportHevc: 0, mixedPlaylist: 1, support4k: 1 }));
      const form = env.calls(`/v1/device/${before.id}/settings`)[0];
      assert.match(form.contentType ?? "", /^application\/x-www-form-urlencoded/);
      const afterSave = await r.run(r.api.deviceInfo());
      assert.deepEqual(afterSave.settings, { supportSsl: 1, supportHevc: 0, supportHdr: 0, support4k: 1, mixedPlaylist: 1 });
    });

    it("deviceSettingsSave with postBody: query still applies", async () => {
      const r = env.rig();
      r.flags.set("postBody", "query");
      const { id } = await r.run(r.api.deviceInfo());
      await r.run(r.api.deviceSettingsSave(id, { supportSsl: 0 }));
      assert.equal((await r.run(r.api.deviceInfo())).settings.supportSsl, 0);
    });

    it("deviceNotify updates title, hardware and software", async () => {
      const r = env.rig();
      await r.run(r.api.deviceNotify("MSX Тест", "Samsung Tizen", "kpmsx-client/1.0.0"));
      const d = await r.run(r.api.deviceInfo());
      assert.deepEqual([d.title, d.hardware, d.software], ["MSX Тест", "Samsung Tizen", "kpmsx-client/1.0.0"]);
    });

    it("deviceUnlink unlinks; the old pair stops working", async () => {
      const r = env.rig();
      await r.run(r.api.deviceUnlink());
      assert.equal(env.calls("/v1/device/unlink").length, 1);
      await assert.rejects(r.run(r.api.user()), kp("KP-AUTH"));
    });
  });

  describe("errors", () => {
    it("deleted item → KP-404; empty search → KP-BAD with status 400", async () => {
      const r = env.rig();
      await assert.rejects(r.run(r.api.item(FIX.MOVIE_DELETED)), kp("KP-404", 404));
      await assert.rejects(r.run(r.api.search("", 1, 20)), kp("KP-BAD", 400));
    });

    it("HTTP 200 with an error status in the body is an error", async () => {
      const r = env.rig();
      await assert.rejects(r.run(r.api.raw("/v1/test/body-404")), (e: unknown) => {
        kp("KP-404", 404)(e);
        assert.equal((e as KpError).detail, "Requested item or video not found.");
        return true;
      });
    });
  });

  it("no preflight in the whole file (CC-01, CNFR-19)", () => {
    assert.equal(env.cors.preflights, 0);
  });
});
