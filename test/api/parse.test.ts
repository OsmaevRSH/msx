import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bool01, num, parseBookmarkFolder, parseCollection, parseDeviceCode, parseDeviceInfo, parseFile, parseHistory, parseHistoryPage,
  parseItemDetail, parseItemSummary, parseMediaLinks, parseMediaUnit, parsePage, parseSerialWatching, parseSubtitle, parseToggle,
  parseTokenPair, parseTvChannel, parseUser, parseWatching, str,
} from "../../src/api/parse.ts";

// Образцы — из docs/research/kinopub-api.md (§4–§8), ссылки и токены заменены синтетическими.

const LIST_ITEM = {
  id: 18422, type: "documovie", subtype: "",
  title: "BBC. Невидимый Рим / Rome's Invisible City", year: 2015,
  cast: "", director: "", voice: null,
  genres: [{ id: 51, title: "История" }], countries: [{ id: 5, title: "Великобритания" }],
  duration: { average: 3119, total: 3119 },
  langs: 1, ac3: 0, quality: 1080, subtitles: 3,
  plot: "Описание",
  imdb: 5304248, imdb_rating: 7.5, imdb_votes: 71,
  kinopoisk: null, kinopoisk_rating: null, kinopoisk_votes: null,
  rating: 5, posters: { small: "https://p.example/small/18422.jpg", medium: "https://p.example/medium/18422.jpg", big: "https://p.example/big/18422.jpg", wide: "https://p.example/wide/18422.jpg" },
  trailer: { id: 8632, file: "/trailers/8/d8/8632.mp4", url: "https://cdn.example/t.mp4" },
  finished: false, created_at: 1487027375, updated_at: 1487029825,
};

const SERIAL_CARD = {
  status: 200,
  item: {
    id: 8632, type: "serial", title: "Черное зеркало / Black Mirror",
    in_watchlist: true, subscribed: true, finished: false,
    voice: "Кубик в Кубе", langs: 98, ac3: 1, quality: 1080, bookmarks: [3, "7"],
    seasons: [{
      id: 59, number: 1, title: "", watching: { status: 1 },
      episodes: [{
        id: 82468, number: 1, snumber: 1,
        title: "Национальный гимн", thumbnail: "https://p.example/480x270.jpg",
        duration: 2675, tracks: 5, ac3: 0,
        audios: [
          { id: 1620649, index: 1, codec: "aac", channels: 2, lang: "rus",
            type: { id: 3, title: "Двухголосый", short_title: "DVO" },
            author: { id: 13, title: "Кубик в Кубе", short_title: null } },
          { id: 1620658, index: 5, codec: "aac", channels: 2, lang: "eng",
            type: { id: 6, title: "Оригинал", short_title: "Orig" }, author: null },
        ],
        subtitles: [{ lang: "rus", shift: 0, embed: false, file: "/5/50/235612.srt", url: "https://cdn.example/pd/subtitle/T/5/50/235612.srt" }],
        files: [{
          codec: "h264", w: 1920, h: 1072, quality: "1080p", quality_id: 3, file: "/2/46/D.mp4",
          url: {
            http: "https://cdn.example/pd/kinopub/T/2/46/D.mp4?loc=de",
            hls: "https://cdn.example/hls/kinopub/T/2/46/D.mp4/master-v1a1.m3u8?loc=de",
            hls2: "https://cdn.example/hls2/kinopub/T/82468.m3u8?loc=de",
            hls4: "https://cdn.example/hls4/kinopub/T/82468.m3u8?loc=de",
          },
        }],
        watched: 1, watching: { status: 1, time: 2644 },
      }],
    }],
  },
};

const MOVIE_CARD = {
  status: 200,
  item: {
    id: 48900, type: "movie", subtype: "", title: "Фильм / Movie", year: "2019",
    posters: { small: "s.jpg", medium: "m.jpg", big: "b.jpg" },
    videos: [{
      id: 48967, number: 1, snumber: 0, title: "", thumbnail: "t.jpg", duration: 5400, tracks: 1,
      audios: [{ id: 1, index: 1, codec: "aac", channels: 2, lang: "rus", type: null, author: null }],
      subtitles: [], files: [{ codec: "h264", w: 1280, h: 720, quality: "720p", quality_id: 2, file: "/a/b.mp4" }],
      watched: 0, watching: { status: 0, time: 884 },
    }],
  },
};

const MEDIA_LINKS = {
  id: 456,
  thumbnail: "https://p.example/480x270.jpg",
  files: [{
    codec: "h264", w: 1920, h: 1080, quality: "1080p", quality_id: 3, file: "/b/8c/x.mp4",
    urls: { http: "https://cdn.example/pd/x.mp4", hls: "https://cdn.example/hls/x.mp4/master-v1a1.m3u8?loc=nl", hls2: "", hls4: "https://cdn.example/hls4/T/456.m3u8?loc=nl" },
  }],
  subtitles: [
    { lang: "eng", shift: 0, embed: true, forced: false, file: "/a/71/29725.srt", url: "https://cdn.example/subtitle/T/a/71/29725.srt" },
    { lang: "rus", shift: "2", embed: 0, forced: 1, url: "https://cdn.example/subtitle/T/r.srt" },
  ],
};

describe("primitives", () => {
  it("num accepts numbers and numeric strings, otherwise the default", () => {
    assert.equal(num(17), 17);
    assert.equal(num("17"), 17);
    assert.equal(num(" 2.5 "), 2.5);
    assert.equal(num(""), 0);
    assert.equal(num("abc", 5), 5);
    assert.equal(num(null, 3), 3);
    assert.equal(num(undefined), 0);
    assert.equal(num(Number.NaN, 1), 1);
    assert.equal(num({}, 4), 4);
  });

  it("str keeps strings, stringifies finite numbers, otherwise empty", () => {
    assert.equal(str("a"), "a");
    assert.equal(str(12), "12");
    assert.equal(str(null), "");
    assert.equal(str({}), "");
    assert.equal(str(undefined, "x"), "x");
  });

  it("bool01 reads 1/0, true/false and their strings", () => {
    assert.equal(bool01(1), 1);
    assert.equal(bool01("1"), 1);
    assert.equal(bool01(true), 1);
    assert.equal(bool01("true"), 1);
    assert.equal(bool01(0), 0);
    assert.equal(bool01("0"), 0);
    assert.equal(bool01(false), 0);
    assert.equal(bool01(null), 0);
    assert.equal(bool01(undefined), 0);
  });
});

describe("list items and pages", () => {
  it("parses a list item (research §6.2): nulls become absent fields", () => {
    const it = parseItemSummary(LIST_ITEM);
    assert.deepEqual(it, {
      id: 18422, type: "documovie", subtype: "", title: "BBC. Невидимый Рим / Rome's Invisible City", year: 2015,
      genres: [{ id: 51, title: "История" }], countries: ["Великобритания"], quality: 1080,
      posters: LIST_ITEM.posters, imdbRating: 7.5, durationAvg: 3119, plot: "Описание",
    });
  });

  it("reads numbers given as strings", () => {
    const it = parseItemSummary({ ...LIST_ITEM, id: "18422", year: "2015", imdb_rating: "7.5", quality: "1080", kinopoisk_rating: "6.1" });
    assert.equal(it.id, 18422);
    assert.equal(it.year, 2015);
    assert.equal(it.imdbRating, 7.5);
    assert.equal(it.kpRating, 6.1);
    assert.equal(it.quality, 1080);
  });

  it("fills missing poster sizes from the others; unknown type falls back to movie", () => {
    const it = parseItemSummary({ id: 1, type: "hologram", posters: { big: "b.jpg" } });
    assert.equal(it.type, "movie");
    assert.deepEqual(it.posters, { small: "b.jpg", medium: "b.jpg", big: "b.jpg" });
  });

  it("parsePage maps pagination.total_items to totalItems and skips garbage items", () => {
    const page = parsePage({
      status: 200, items: [LIST_ITEM, null, { title: "без id" }, "x"],
      pagination: { total: "61", current: 2, perpage: "20", total_items: 1211 },
    }, (v) => {
      const s = parseItemSummary(v);
      return s.id > 0 ? s : undefined;
    });
    assert.equal(page.items.length, 1);
    assert.deepEqual(page.pagination, { total: 61, current: 2, perpage: 20, totalItems: 1211 });
  });

  it("parsePage without pagination is a single page", () => {
    const page = parsePage({ items: [LIST_ITEM] }, parseItemSummary);
    assert.deepEqual(page.pagination, { total: 1, current: 1, perpage: 1, totalItems: 1 });
  });

  it("pagination without total_items: the count is known only on a single page, otherwise it is not made up", () => {
    assert.deepEqual(parsePage({ items: [LIST_ITEM], pagination: { total: 3, current: 1, perpage: 1 } }, parseItemSummary).pagination,
      { total: 3, current: 1, perpage: 1 });
    assert.equal(parsePage({ items: [LIST_ITEM], pagination: { total: 1, current: 1 } }, parseItemSummary).pagination.totalItems, 1);
    assert.equal(parsePage({ items: [], pagination: { total: 2, total_items: "0" } }, parseItemSummary).pagination.totalItems, 0);
  });
});

describe("cards (research §6.3)", () => {
  it("parses a serial card: seasons, episodes, audios, url ladder, watch state, bookmarks", () => {
    const d = parseItemDetail(SERIAL_CARD);
    assert.equal(d.id, 8632);
    assert.equal(d.type, "serial");
    assert.equal(d.voice, "Кубик в Кубе");
    assert.equal(d.finished, false);
    assert.deepEqual(d.bookmarks, [3, 7]);
    assert.deepEqual(d.videos, []);
    assert.equal(d.seasons.length, 1);
    const s = d.seasons[0];
    assert.deepEqual({ id: s.id, number: s.number, title: s.title }, { id: 59, number: 1, title: "" });
    const e = s.episodes[0];
    assert.deepEqual({ id: e.id, number: e.number, snumber: e.snumber, duration: e.duration, thumbnail: e.thumbnail },
      { id: 82468, number: 1, snumber: 1, duration: 2675, thumbnail: "https://p.example/480x270.jpg" });
    assert.deepEqual(e.watching, { status: 1, time: 2644 });
    assert.deepEqual(e.audios[0], {
      id: 1620649, index: 1, codec: "aac", channels: 2, lang: "rus", typeId: 3, typeTitle: "Двухголосый", authorId: 13, authorTitle: "Кубик в Кубе",
    });
    assert.deepEqual(e.audios[1], { id: 1620658, index: 5, codec: "aac", channels: 2, lang: "eng", typeId: 6, typeTitle: "Оригинал" });
    assert.equal(e.files[0].qualityId, 3);
    assert.deepEqual(Object.keys(e.files[0].urls).sort(), ["hls", "hls2", "hls4", "http"]);
    assert.deepEqual(e.subtitles, [{ lang: "rus", shift: 0, embed: false, forced: false, url: "https://cdn.example/pd/subtitle/T/5/50/235612.srt" }]);
  });

  it("parses a movie card with nolinks: files without urls, snumber 0, in-progress state", () => {
    const d = parseItemDetail(MOVIE_CARD);
    assert.equal(d.year, 2019);
    assert.deepEqual(d.seasons, []);
    assert.deepEqual(d.bookmarks, []);
    assert.equal(d.videos.length, 1);
    const v = d.videos[0];
    assert.equal(v.snumber, 0);
    assert.deepEqual(v.watching, { status: 0, time: 884 });
    assert.deepEqual(v.files[0], { codec: "h264", w: 1280, h: 720, quality: "720p", qualityId: 2, file: "/a/b.mp4", urls: {} });
    assert.deepEqual(v.audios[0], { id: 1, index: 1, codec: "aac", channels: 2, lang: "rus" });
  });

  it("parses a multi movie: several videos, subtype multi; also without the {item} wrapper", () => {
    const unit = (n: number) => ({ id: 100 + n, number: n, snumber: 0, title: `Часть ${n}`, duration: 3000, watched: n === 1 ? 1 : 0 });
    const d = parseItemDetail({ id: 2003, type: "movie", subtype: "multi", title: "M", videos: [unit(1), unit(2), unit(3)] });
    assert.equal(d.subtype, "multi");
    assert.deepEqual(d.videos.map((v) => v.number), [1, 2, 3]);
    assert.deepEqual(d.videos.map((v) => v.watching.status), [1, -1, -1]);
  });

  it("a card of unknown type with seasons is a serial; episodes get the season number as snumber", () => {
    const d = parseItemDetail({ item: { id: 5, type: "anime", seasons: [{ number: 2, episodes: [{ id: 9, number: 1 }] }] } });
    assert.equal(d.type, "serial");
    assert.equal(d.seasons[0].episodes[0].snumber, 2);
  });

  it("media unit: watched without watching → status 1; time without status → 0", () => {
    assert.deepEqual(parseMediaUnit({ id: 1, watched: 1 }).watching, { status: 1, time: 0 });
    assert.deepEqual(parseMediaUnit({ id: 1, watching: { time: "120.5" } }).watching, { status: 0, time: 120.5 });
    assert.deepEqual(parseMediaUnit({ id: 1, watching: { status: 7 } }).watching, { status: -1, time: 0 });
  });
});

describe("files and media links (research §7.1)", () => {
  it("takes both url and urls; urls wins; empty strings mean no such kind", () => {
    const f = parseFile({
      codec: "h264", w: "1920", h: 1080, quality: "1080p", quality_id: "3", file: "/f.mp4",
      url: { http: "https://a/old.mp4", hls: "https://a/old.m3u8", hls2: "https://a/old2.m3u8" },
      urls: { hls: "https://a/new.m3u8", hls2: "", hls4: "   " },
    });
    assert.deepEqual(f, {
      codec: "h264", w: 1920, h: 1080, quality: "1080p", qualityId: 3, file: "/f.mp4",
      urls: { http: "https://a/old.mp4", hls: "https://a/new.m3u8", hls2: "https://a/old2.m3u8" },
    });
  });

  it("parses media-links without status: empty hls2 is dropped, subtitles fully", () => {
    const ml = parseMediaLinks(MEDIA_LINKS, 456);
    assert.equal(ml.mid, 456);
    assert.equal(ml.files.length, 1);
    assert.equal("hls2" in ml.files[0].urls, false);
    assert.equal(ml.files[0].urls.hls4, "https://cdn.example/hls4/T/456.m3u8?loc=nl");
    assert.deepEqual(ml.subtitles, [
      { lang: "eng", shift: 0, embed: true, forced: false, url: "https://cdn.example/subtitle/T/a/71/29725.srt" },
      { lang: "rus", shift: 2, embed: false, forced: true, url: "https://cdn.example/subtitle/T/r.srt" },
    ]);
  });

  it("media-links: mid falls back to the response id; subtitles without url are skipped", () => {
    const ml = parseMediaLinks({ id: "77", files: null, subtitles: [{ lang: "eng" }, null] });
    assert.deepEqual(ml, { mid: 77, files: [], subtitles: [] });
  });

  it("parseSubtitle never throws on garbage", () => {
    assert.deepEqual(parseSubtitle(null), { lang: "", shift: 0, embed: false, forced: false, url: "" });
  });
});

describe("watching, history, serials (research §8)", () => {
  it("history lives in the `history` field, not `items`", () => {
    const h = parseHistory({
      status: 200,
      history: [
        { counter: 2, first_seen: 1, last_seen: "1700000000", time: 600, deleted: false,
          item: LIST_ITEM, media: { id: 82468, number: 4, snumber: 1, title: "Серия 4", thumbnail: "t", duration: "2675", tracks: 2 } },
        { item: null, media: {} },
      ],
      items: [{ item: LIST_ITEM }, { item: LIST_ITEM }],
      pagination: { total: 1, current: 1, perpage: 20, total_items: 1 },
    });
    assert.equal(h.length, 1);
    assert.equal(h[0].item.id, 18422);
    assert.deepEqual(h[0].media, { id: 82468, number: 4, snumber: 1, title: "Серия 4", duration: 2675 });
    assert.equal(h[0].time, 600);
    assert.equal(h[0].lastSeen, 1700000000);
  });

  it("serials: total as a string", () => {
    const s = parseSerialWatching({ id: 8632, type: "serial", title: "S", posters: { medium: "m" }, total: "128", watched: 122, new: "6" });
    assert.deepEqual({ id: s.id, type: s.type, total: s.total, watched: s.watched, new: s.new }, { id: 8632, type: "serial", total: 128, watched: 122, new: 6 });
  });

  it("watching?id= for a serial: units with season numbers", () => {
    const units = parseWatching({
      status: 200,
      item: {
        id: 2001, title: "S", type: "serial", status: 0,
        seasons: [
          { id: 1, number: 1, watched: 1, status: 0, episodes: [
            { id: 11, number: 1, title: "", duration: 2400, time: 2400, status: 1, updated: 1 },
            { id: 12, number: 2, title: "", duration: "2410", time: "600", status: "0", updated: null },
          ] },
          { id: 2, number: 2, episodes: [{ id: 21, number: 1, duration: 2400 }] },
        ],
      },
    });
    assert.deepEqual(units, [
      { number: 1, season: 1, status: 1, time: 2400, duration: 2400 },
      { number: 2, season: 1, status: 0, time: 600, duration: 2410 },
      { number: 1, season: 2, status: -1, time: 0, duration: 2400 },
    ]);
  });

  it("watching?id= for a movie: season 0", () => {
    const units = parseWatching({ item: { id: 2006, type: "movie", videos: [{ id: 1, number: 1, duration: 5400, time: 1200, status: 0 }] } });
    assert.deepEqual(units, [{ number: 1, season: 0, status: 0, time: 1200, duration: 5400 }]);
  });

  it("toggle: watched from the field or from watching.status", () => {
    assert.deepEqual(parseToggle({ status: 200, watched: 1, watching: { status: 1 } }), { watched: 1 });
    assert.deepEqual(parseToggle({ status: 200, watching: { status: -1 } }), { watched: 0 });
    assert.deepEqual(parseToggle({ watching: { status: "1" } }), { watched: 1 });
  });
});

describe("device, oauth, user, bookmarks (research §4, §5)", () => {
  it("device code: interval as a string, default 5", () => {
    const dc = parseDeviceCode({ code: "ab23", user_code: "ASDFGH", verification_uri: "https://kino.watch/device", expires_in: 8600, interval: "1" });
    assert.deepEqual(dc, { code: "ab23", userCode: "ASDFGH", verificationUri: "https://kino.watch/device", interval: 1, expiresIn: 8600 });
    const d2 = parseDeviceCode({ code: "c", user_code: "U" });
    assert.equal(d2.interval, 5);
    assert.equal(d2.verificationUri, "https://kino.watch/device");
    assert.ok(d2.expiresIn > 0);
  });

  it("token pair; expires_in as a string", () => {
    assert.deepEqual(parseTokenPair({ access_token: "a1", token_type: "bearer", expires_in: "3600", refresh_token: "r1", scope: null }),
      { access: "a1", refresh: "r1", expiresIn: 3600 });
  });

  it("device settings in the {label, value, type} wrapper", () => {
    const info = parseDeviceInfo({
      status: 200,
      device: {
        id: "41", title: "MSX TV", hardware: "Samsung Tizen", software: "kpmsx-client/1.0", is_browser: false,
        settings: {
          supportSsl: { label: "Use SSL", value: 1, type: "bool" },
          supportHevc: { label: "HEVC", value: "1", type: "bool" },
          supportHdr: { label: "HDR", value: 0, type: "bool" },
          support4k: { label: "4K", value: 0, type: "bool" },
          mixedPlaylist: 1,
          streamingType: { label: "Streaming type", type: "list", value: [{ id: 4, label: "HLS4", selected: 1 }] },
        },
      },
    });
    assert.deepEqual(info, {
      id: 41, title: "MSX TV", hardware: "Samsung Tizen", software: "kpmsx-client/1.0",
      settings: { supportSsl: 1, supportHevc: 1, supportHdr: 0, support4k: 0, mixedPlaylist: 1 },
    });
  });

  it("device server location: the selected entry of the list setting (research §5.2)", () => {
    const loc = (value: unknown): unknown => parseDeviceInfo({ device: { id: 1, settings: { serverLocation: { type: "list", value } } } }).location;
    assert.deepEqual(loc([{ id: 1, label: "Netherlands", selected: 0 }, { id: "2", label: "Germany", selected: "1" }]), { id: 2, label: "Germany" });
    assert.equal(loc([{ id: 1, label: "Netherlands", selected: 0 }]), undefined);
    assert.equal(loc("nl"), undefined);
    assert.deepEqual(loc([{ id: 3, selected: 1 }]), { id: 3, label: "" });
  });

  it("user and bookmark folder", () => {
    assert.deepEqual(parseUser({ status: 200, user: { username: "u", reg_date: 1, subscription: { active: true, end_time: "1800000000", days: 30 } } }),
      { username: "u", subscription: { active: true, endTime: 1800000000, days: 30 } });
    assert.deepEqual(parseBookmarkFolder({ id: "3", title: "Избранное", views: 0, count: "17" }), { id: 3, title: "Избранное", count: 17 });
  });
});

describe("garbage never throws", () => {
  const junk: unknown[] = [null, undefined, 0, "", "x", [], {}, { items: "no" }, { item: null }, { history: {} }, [null], true];
  const parsers: ((x: unknown) => unknown)[] = [
    parseItemSummary, parseItemDetail, (x) => parseMediaUnit(x), parseFile, parseSubtitle, (x) => parseMediaLinks(x),
    (x) => parsePage(x, parseItemSummary), parseHistory, parseSerialWatching, parseWatching, parseDeviceInfo,
    parseDeviceCode, parseUser, parseTokenPair, parseBookmarkFolder, parseToggle,
  ];

  it("every parser returns a value for every junk input", () => {
    for (const p of parsers) for (const j of junk) assert.doesNotThrow(() => p(j), `${p.name}(${JSON.stringify(j)})`);
  });

  it("deeply broken card: non-objects in arrays are skipped, the rest gets defaults", () => {
    const d = parseItemDetail({ item: { id: 1, seasons: [null, { episodes: [null, { id: 9, audios: [null], files: [null], subtitles: "x" }] }], videos: "x", bookmarks: [null, {}, "a"] } });
    assert.deepEqual(d.videos, []);
    assert.deepEqual(d.bookmarks, []);
    assert.equal(d.seasons.length, 1);
    assert.equal(d.seasons[0].number, 1);
    assert.equal(d.seasons[0].episodes.length, 1);
    const e = d.seasons[0].episodes[0];
    assert.deepEqual({ id: e.id, number: e.number, audios: e.audios, files: e.files, subtitles: e.subtitles }, { id: 9, number: 1, audios: [], files: [], subtitles: [] });
  });
});

describe("v1.11 sections: collections, TV channels, history pages, the 3d type", () => {
  it("parseCollection: the live shape has no count — none is made up (not 0); items_count or count when present; no id → skipped", () => {
    // Доки «API 1.3» и снимок api2: id, title, watchers, views, created, updated, posters.
    const raw = { id: 7, title: "Семейные", watchers: 19, views: 123, created: 1, updated: 2, posters: { small: "s", medium: "m", big: "b" } };
    assert.deepEqual(parseCollection(raw), { id: 7, title: "Семейные", posters: { small: "s", medium: "m", big: "b" } });
    assert.equal(parseCollection({ ...raw, items_count: "12" })?.count, 12);
    assert.equal(parseCollection({ ...raw, count: 50 })?.count, 50);
    for (const count of [0, null, "", "x"]) assert.equal(parseCollection({ ...raw, count })?.count, undefined, String(count));
    assert.equal(parseCollection({ title: "x" }), undefined);
    assert.deepEqual(parsePage({ items: [raw, null, { id: 0 }], pagination: { total: 1, current: 1, perpage: 25 } }, parseCollection).items.map((c) => c.id), [7]);
  });

  it("parseTvChannel: title (or name), logo m → s → l, stream trimmed", () => {
    assert.deepEqual(parseTvChannel({ id: 1, title: "Матч", name: "match", logos: { s: "S", m: "M" }, stream: " https://x/p.m3u8 ", status: null }),
      { id: 1, title: "Матч", logo: "M", stream: "https://x/p.m3u8" });
    assert.deepEqual(parseTvChannel({ id: "2", name: "sport", logos: { l: "L" } }), { id: 2, title: "sport", logo: "L", stream: "" });
    assert.deepEqual(parseTvChannel(null), { id: 0, title: "", logo: "", stream: "" });
  });

  it("parseHistoryPage: titles of the entries in order and the pagination (list key «history»)", () => {
    const entry = (id: number) => ({ time: 1, last_seen: 2, item: { ...LIST_ITEM, id }, media: { id: 9, number: 1, snumber: 0 } });
    const p = parseHistoryPage({ history: [entry(5), entry(6), { item: null }], pagination: { total: 3, current: 1, perpage: 50, total_items: 120 } });
    assert.deepEqual(p.items.map((i) => i.id), [5, 6]);
    assert.deepEqual(p.pagination, { total: 3, current: 1, perpage: 50, totalItems: 120 });
    assert.deepEqual(parseHistoryPage({}).items, []);
  });

  it("the live API writes 3d in lower case: it is the 3D type", () => {
    assert.equal(parseItemSummary({ ...LIST_ITEM, type: "3d" }).type, "3D");
    assert.equal(parseItemSummary({ ...LIST_ITEM, type: "4k" }).type, "movie");
    assert.equal(parseSerialWatching({ id: 1, type: "3d" }).type, "3D");
    assert.equal(parseItemDetail({ item: { id: 1, type: "3d", seasons: [{ episodes: [{ id: 9 }] }] } }).type, "3D");
  });
});
