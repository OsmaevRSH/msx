import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIX, GENRES, buildCatalog, catalog, findItem, findUnit } from "../../tools/kpmock/fixtures.ts";
import type { FxItem, FxUnit } from "../../tools/kpmock/fixtures.ts";
import { MockState, watchKey } from "../../tools/kpmock/state.ts";

const SPECIAL_IDS = [FIX.SERIAL_BIG, FIX.SERIAL_SMALL, FIX.MOVIE_MULTI, FIX.MOVIE_AUDIO12, FIX.MOVIE_DELETED, FIX.MOVIE_SIMPLE];

function unitsOf(it: FxItem): FxUnit[] {
  return [...(it.videos ?? []), ...(it.seasons ?? []).flatMap((s) => s.episodes)];
}

describe("kpmock fixtures", () => {
  it("has 500 regular titles (1000–1499) and 6 special ones", () => {
    const all = catalog();
    assert.equal(all.length, 506);
    const regular = all.filter((it) => it.id >= 1000 && it.id <= 1499);
    assert.equal(regular.length, 500);
    assert.deepEqual(all.filter((it) => it.id >= 2000).map((it) => it.id).sort(), [...SPECIAL_IDS].sort());
  });

  it("splits regular titles by type as specified", () => {
    const counts: Record<string, number> = {};
    for (const it of catalog().filter((x) => x.id < 2000)) counts[it.type] = (counts[it.type] ?? 0) + 1;
    assert.deepEqual(counts, { movie: 200, serial: 150, documovie: 40, docuserial: 30, tvshow: 30, concert: 30, "3D": 20 });
  });

  it("is deterministic and cached", () => {
    assert.equal(catalog(), catalog());
    assert.deepEqual(buildCatalog(), buildCatalog());
    assert.deepEqual(buildCatalog(), catalog());
  });

  it("has unique item ids and unique mids", () => {
    const all = catalog();
    assert.equal(new Set(all.map((it) => it.id)).size, all.length);
    const mids = all.flatMap((it) => unitsOf(it).map((u) => u.id));
    assert.equal(new Set(mids).size, mids.length);
    for (const it of all) for (const u of unitsOf(it)) assert.equal(Math.floor(u.id / 1000), it.id, `mid ${u.id} of ${it.id}`);
  });

  it("gives every unit 1 subtitle in the item and 5 in the full list", () => {
    for (const it of catalog()) {
      for (const u of unitsOf(it)) {
        assert.equal(u.subsInItem.length, 1);
        assert.deepEqual(
          u.subsFull.map((s) => `${s.lang}${s.forced ? "!" : ""}`),
          ["rus", "eng", "eng!", "ukr", "fre"],
        );
      }
    }
  });

  it("uses synthetic titles, years 1990–2026 and genre 23 for every 3rd title", () => {
    const regular = catalog().filter((it) => it.id < 2000);
    assert.equal(findItem(1000)?.title, "Тестовый фильм 1000 / Test Movie 1000");
    for (const it of regular) {
      assert.ok(it.year >= 1990 && it.year <= 2026, `year ${it.year}`);
      if (it.type === "serial") assert.match(it.title, /^Тестовый сериал \d+ \/ Test Series \d+$/);
      else assert.doesNotMatch(it.title.toLowerCase(), /тестовый сериал/);
    }
    const anim = regular.filter((it) => it.genres.some((g) => g.id === FIX.GENRE_ANIM));
    assert.ok(anim.length >= 160 && anim.length <= 170, `anim ${anim.length}`);
    assert.ok(anim.some((it) => it.type === "movie") && anim.some((it) => it.type === "serial"));
    assert.ok(GENRES.movie.some((g) => g.id === 23 && g.title === "Мультфильм"));
  });

  it("orders created_at and updated_at descending by id", () => {
    const all = [...catalog()].sort((a, b) => a.id - b.id);
    for (let i = 1; i < all.length; i++) {
      assert.ok(all[i].created_at < all[i - 1].created_at);
      assert.ok(all[i].updated_at < all[i - 1].updated_at);
    }
  });

  it("builds SERIAL_BIG with 10 seasons × 20 episodes and 2 voices", () => {
    const it = findItem(FIX.SERIAL_BIG);
    assert.ok(it?.seasons);
    assert.equal(it.type, "serial");
    assert.equal(it.seasons.length, 10);
    for (const s of it.seasons) {
      assert.equal(s.episodes.length, 20);
      for (const e of s.episodes) {
        assert.equal(e.snumber, s.number);
        assert.equal(e.audios.length, 2);
      }
    }
  });

  it("builds SERIAL_SMALL with 2 × 3 episodes of 60 s", () => {
    const it = findItem(FIX.SERIAL_SMALL);
    assert.deepEqual(it?.seasons?.map((s) => s.episodes.map((e) => e.duration)), [[60, 60, 60], [60, 60, 60]]);
  });

  it("builds MOVIE_MULTI, MOVIE_DELETED and MOVIE_SIMPLE", () => {
    const multi = findItem(FIX.MOVIE_MULTI);
    assert.equal(multi?.subtype, "multi");
    assert.equal(multi?.videos?.length, 3);
    assert.deepEqual(multi?.videos?.map((v) => v.number), [1, 2, 3]);
    assert.equal(findItem(FIX.MOVIE_DELETED)?.deleted, true);
    const simple = findItem(FIX.MOVIE_SIMPLE);
    assert.equal(simple?.videos?.length, 1);
    assert.equal(simple?.videos?.[0].duration, 5400);
    assert.equal(simple?.videos?.[0].snumber, 0);
  });

  it("builds MOVIE_AUDIO12 with 12 audios (ac3, repeated author) and special files", () => {
    const u = findItem(FIX.MOVIE_AUDIO12)?.videos?.[0];
    assert.ok(u);
    assert.equal(u.audios.length, 12);
    assert.deepEqual(u.audios.map((a) => a.index), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.ok(u.audios.some((a) => a.codec === "ac3"));
    const authors = u.audios.map((a) => a.author?.id).filter((id) => id !== undefined);
    assert.ok(authors.length > new Set(authors).size, "some author repeats");
    const voice = u.audios.filter((a) => a.author?.id === u.audios[0].author?.id).map((a) => `${a.codec}/${a.channels}`);
    assert.deepEqual(voice, ["aac/2", "aac/6", "ac3/6"]);
    assert.ok(u.files.some((f) => f.codec === "h265" && f.h === 2160 && f.quality_id === 4));
    assert.ok(u.files.some((f) => f.w === 1920 && f.h === 800 && f.quality_id === 3));
    assert.deepEqual(u.files.filter((f) => f.codec === "h264" && f.h !== 800).map((f) => f.h), [480, 720, 1080]);
  });

  it("findUnit resolves a mid to its item and season", () => {
    const mid = FIX.SERIAL_BIG * 1000 + 25; // 2nd season, 5th episode
    const found = findUnit(mid);
    assert.equal(found?.item.id, FIX.SERIAL_BIG);
    assert.equal(found?.season, 2);
    assert.equal(found?.unit.number, 5);
    const movie = findUnit(FIX.MOVIE_SIMPLE * 1000 + 1);
    assert.equal(movie?.season, 0);
    assert.equal(movie?.unit.number, 1);
    assert.equal(findUnit(1), undefined);
  });
});

describe("kpmock initial state", () => {
  it("seeds watching, history, new episodes and the favourites folder", () => {
    const s = new MockState();
    const big = FIX.SERIAL_BIG;
    for (const e of [1, 2, 3]) assert.equal(s.watching.get(watchKey(big, 1, e))?.status, 1);
    assert.deepEqual(
      { time: s.watching.get(watchKey(big, 1, 4))?.time, status: s.watching.get(watchKey(big, 1, 4))?.status },
      { time: 600, status: 0 },
    );
    assert.deepEqual(
      { time: s.watching.get(watchKey(FIX.MOVIE_SIMPLE, 0, 1))?.time, status: s.watching.get(watchKey(FIX.MOVIE_SIMPLE, 0, 1))?.status },
      { time: 1200, status: 0 },
    );
    assert.equal(s.watching.get(watchKey(FIX.SERIAL_SMALL, 1, 1))?.status, 1);
    assert.equal(s.newEpisodes.get(big), 2);
    const order = [...s.history].sort((a, b) => b.lastSeen - a.lastSeen).map((h) => h.item);
    assert.deepEqual(order, [big, FIX.MOVIE_SIMPLE, FIX.SERIAL_SMALL]);
    assert.deepEqual(s.folders.get(1)?.title, "Избранное");
    assert.deepEqual([...(s.folders.get(1)?.items ?? [])].sort(), [FIX.SERIAL_BIG, FIX.MOVIE_SIMPLE].sort());
  });

  it("reset() restores the initial state and drops tokens", () => {
    const s = new MockState();
    const dev = s.createDevice({ title: "TV", hardware: "hw", software: "sw" });
    const pair = s.issueToken(dev, 3600);
    assert.ok(pair.access.length < 20 && pair.refresh.length < 20);
    assert.equal(s.tokenInfo(pair.access)?.deviceId, dev);
    s.watching.clear();
    s.folders.delete(1);
    s.reset();
    assert.equal(s.tokenInfo(pair.access), undefined);
    assert.equal(s.devices.size, 0);
    assert.equal(s.watching.get(watchKey(FIX.SERIAL_BIG, 1, 4))?.time, 600);
    assert.equal(s.folders.get(1)?.items.length, 2);
    const again = s.issueToken(s.createDevice({ title: "TV", hardware: "hw", software: "sw" }), 3600);
    assert.notEqual(again.access, pair.access, "token names never repeat");
  });
});
