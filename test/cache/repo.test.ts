import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import { KvStore } from "../../src/bridge/storage.ts";
import { L2 } from "../../src/cache/l2.ts";
import { Lru } from "../../src/cache/lru.ts";
import { Repo, cacheKeys } from "../../src/cache/repo.ts";
import type { ListSource } from "../../src/cache/repo.ts";
import { type Got, SwrCache } from "../../src/cache/swr.ts";
import { b64urlDecode } from "../../src/core/b64url.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";
import { type Rig, kp, q, useKpApiMock } from "../api/kpapi-rig.ts";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const LONG_PLOT = "Длинный сюжет. ".repeat(60);
const CATALOG: ListSource = { kind: "catalog", type: "movie", sort: "-updated" };
const FOLDER1: ListSource = { kind: "folder", folder: 1 };

/** Карточка, в которой API проигнорировал `nolinks=1`: ссылки на поток, субтитры со ссылками и длинный сюжет. */
function rawCard(id: number): unknown {
  const unit = {
    id: id * 1000 + 1, number: 1, snumber: 0, title: "", duration: 5400,
    audios: [{ id: 1, index: 1, codec: "aac", channels: 2, lang: "rus" }],
    files: [{
      codec: "h264", w: 1920, h: 1080, quality: "1080p", quality_id: 3, file: "/f.mp4",
      url: { hls: "http://cdn.test/cdn/hls/t/f.mp4/master.m3u8", http: "http://cdn.test/cdn/pd/t/f.mp4" },
    }],
    subtitles: [{ lang: "rus", shift: 0, embed: false, forced: false, url: "http://cdn.test/cdn/sub/t/s.srt" }],
    watching: { status: -1, time: 0 },
  };
  return {
    status: 200,
    item: {
      id, type: "movie", subtype: "", title: `Карточка ${id} / Card ${id}`, year: 2020, quality: 1080, plot: LONG_PLOT,
      genres: [], countries: [], posters: { small: "s", medium: "m", big: "b" }, bookmarks: [], videos: [unit],
    },
  };
}

function setup(r: Rig, mem = new MemoryStorage()) {
  const l2 = new L2(new KvStore(mem, r.log), r.clock, undefined, r.log);
  const cache = new SwrCache({ l1: new Lru(), l2, clock: r.clock, log: r.log });
  const repo = new Repo({ api: r.api, cache, clock: r.clock, log: r.log });
  return { mem, l2, cache, repo };
}

const l2Keys = (mem: MemoryStorage): string[] => {
  const out: string[] = [];
  for (let i = 0; i < mem.length; i++) {
    const k = mem.key(i);
    if (k?.startsWith("kp.l2.")) out.push(k.slice("kp.l2.".length));
  }
  return out.sort();
};

const dump = (mem: MemoryStorage): string => {
  let s = "";
  for (let i = 0; i < mem.length; i++) {
    const k = mem.key(i) ?? "";
    s += `${k}=${mem.getItem(k) ?? ""}\n`;
  }
  return s;
};

/** Ждёт условие в реальном времени; поддельные часы тем временем обслуживают таймеры фоновых запросов. */
async function until(r: Rig, what: string, pred: () => boolean): Promise<void> {
  const wait = async (): Promise<void> => {
    for (let i = 0; i < 2000 && !pred(); i++) await realSleep(5);
    assert.ok(pred(), `timed out waiting for ${what}`);
  };
  await r.run(wait());
}

describe("Repo", () => {
  const env = useKpApiMock((router) => {
    for (const id of [1, 12, 9001]) router.add("GET", `/v1/items/${id}`, () => ({ status: 200, json: rawCard(id) }));
  });
  const count = (path: string): number => env.calls(path).length;

  it("listPage: one mock call within 10 min; after 11 min — cached value at once and one background refresh", async () => {
    const r = env.rig();
    const { cache, repo } = setup(r);
    const first = await r.run(repo.listPage(CATALOG, 1));
    assert.equal(first.source, "net");
    assert.equal(first.value.items.length, 48);
    const c = env.calls("/v1/items")[0];
    assert.deepEqual([q(c).get("type"), q(c).get("sort"), q(c).get("page"), q(c).get("perpage")], ["movie", "-updated", "1", "48"]);

    await r.clock.advance(9 * MIN);
    const again = await r.run(repo.listPage({ sort: "-updated", type: "movie", kind: "catalog" }, 1));
    assert.deepEqual([again.source, again.stale, again.fetchedAt], ["l1", false, first.fetchedAt]);
    assert.equal(count("/v1/items"), 1);

    await r.clock.advance(2 * MIN);
    const old = await repo.listPage(CATALOG, 1);
    assert.deepEqual([old.source, old.stale], ["l1", true]);
    assert.deepEqual(old.value, first.value);
    await until(r, "background refresh", () => (cache.peek(cacheKeys.list(CATALOG, 1))?.fetchedAt ?? 0) > first.fetchedAt);
    assert.equal(count("/v1/items"), 2);
    assert.equal((await repo.listPage(CATALOG, 1)).stale, false);
    assert.equal(count("/v1/items"), 2);
  });

  it("listPage: similar and folder become a Page; only page 1 of a list goes to L2", async () => {
    const r = env.rig();
    const { mem, l2, repo } = setup(r);
    const sim = await r.run(repo.listPage({ kind: "similar", id: FIX.MOVIE_SIMPLE }, 1));
    assert.equal(sim.value.items.length, 12);
    assert.deepEqual(sim.value.pagination, { total: 1, current: 1, perpage: 48, totalItems: 12 });
    const sim2 = await r.run(repo.listPage({ kind: "similar", id: FIX.MOVIE_SIMPLE }, 2));
    assert.deepEqual([sim2.value.items.length, sim2.value.pagination.current, sim2.value.pagination.total], [0, 2, 1]);
    assert.equal(count("/v1/items/similar"), 1);

    const folder = await r.run(repo.listPage(FOLDER1, 1));
    assert.deepEqual(folder.value.items.map((it) => it.id).sort(), [FIX.SERIAL_BIG, FIX.MOVIE_SIMPLE].sort());
    assert.equal(folder.value.pagination.current, 1);
    assert.equal(q(env.calls("/v1/bookmarks/1")[0]).get("perpage"), "48");

    await r.run(repo.listPage(CATALOG, 1));
    await r.run(repo.listPage(CATALOG, 2));
    await r.run(repo.search("Простой", 1));
    l2.flush();
    assert.deepEqual(l2Keys(mem), [cacheKeys.list(CATALOG, 1), cacheKeys.list(FOLDER1, 1)].sort(), "only page 1 lists are persisted");
  });

  it("policies: TTL of each kind, then a stale value with a background refresh; L2 only where allowed", async () => {
    const r = env.rig();
    const cases: { name: string; path: string; ttl: number; l2: boolean; call: (repo: Repo) => Promise<Got<unknown>> }[] = [
      { name: "user", path: "/v1/user", ttl: HOUR, l2: true, call: (x) => x.user() },
      { name: "genres", path: "/v1/genres", ttl: DAY, l2: true, call: (x) => x.genres("movie") },
      { name: "locations", path: "/v1/references/server-location", ttl: DAY, l2: true, call: (x) => x.serverLocations() },
      { name: "voiceovers", path: "/v1/references/voiceover-type", ttl: DAY, l2: true, call: (x) => x.voiceoverTypes() },
      { name: "shelf", path: "/v1/items/popular", ttl: 10 * MIN, l2: true, call: (x) => x.shelf("popular", "movie") },
      { name: "search", path: "/v1/items/search", ttl: 5 * MIN, l2: false, call: (x) => x.search("Простой", 1) },
      { name: "similar", path: "/v1/items/similar", ttl: HOUR, l2: false, call: (x) => x.listPage({ kind: "similar", id: FIX.MOVIE_SIMPLE }, 1) },
      { name: "history", path: "/v1/history", ttl: MIN, l2: true, call: (x) => x.history() },
      { name: "serials", path: "/v1/watching/serials", ttl: MIN, l2: true, call: (x) => x.serials() },
      { name: "movies", path: "/v1/watching/movies", ttl: MIN, l2: true, call: (x) => x.watchingMovies() },
      { name: "bm", path: "/v1/bookmarks", ttl: 5 * MIN, l2: true, call: (x) => x.bookmarkFolders() },
      { name: "folder", path: "/v1/bookmarks/1", ttl: 2 * MIN, l2: true, call: (x) => x.listPage(FOLDER1, 1) },
    ];
    for (const c of cases) {
      const { mem, l2, repo } = setup(r);
      const before = count(c.path);
      const first = await r.run(c.call(repo));
      assert.equal(first.source, "net", c.name);
      await r.clock.advance(c.ttl - 1);
      assert.deepEqual([(await c.call(repo)).stale, count(c.path) - before], [false, 1], `${c.name}: fresh within TTL`);
      await r.clock.advance(1);
      const old = await c.call(repo);
      assert.deepEqual([old.stale, old.fetchedAt], [true, first.fetchedAt], `${c.name}: stale after TTL`);
      await until(r, `${c.name} refresh`, () => count(c.path) - before === 2);
      l2.flush();
      assert.equal(l2Keys(mem).length > 0, c.l2, `${c.name}: L2 ${c.l2 ? "expected" : "forbidden"}`);
    }
    const { repo } = setup(r);
    const shelf = await r.run(repo.shelf("hot", "serial"));
    assert.equal(shelf.value.length, 7);
    const sc = env.calls("/v1/items/hot")[0];
    assert.deepEqual([q(sc).get("type"), q(sc).get("perpage")], ["serial", "7"]);
    assert.equal(q(env.calls("/v1/history")[0]).get("perpage"), "50");
  });

  it("search: stale-max 1 h — after it the network is awaited", async () => {
    const r = env.rig();
    const { repo } = setup(r);
    await r.run(repo.search("Простой", 1));
    await r.clock.advance(HOUR + 1);
    const got = await r.run(repo.search("Простой", 1));
    assert.deepEqual([got.source, got.stale, count("/v1/items/search")], ["net", false, 2]);
  });

  it("item (D-41): fresh card — no request; card older than 10 min and mock 300 ms — waits and returns fresh data", async () => {
    const r = env.rig();
    const { repo } = setup(r);
    const id = FIX.MOVIE_SIMPLE;
    const old = await r.run(repo.item(id, { freshWithinMs: 600_000, waitMs: 500 }));
    assert.equal(old.source, "net");
    assert.equal(old.value.videos[0].watching.time, 1200);
    assert.equal((await repo.item(id, { freshWithinMs: 600_000, waitMs: 500 })).source, "l1");
    assert.equal(count(`/v1/items/${id}`), 1);

    await r.run(r.api.marktime(id, 1, 3000));
    await r.clock.advance(11 * MIN);
    env.mock().setScenario({ rules: [{ path: `^/v1/items/${id}$`, delayMs: 300, times: 1 }] });
    r.clock.ioGraceMs = 1500;
    const t0 = r.clock.now();
    const got = await r.run(repo.item(id, { freshWithinMs: 600_000, waitMs: 500 }));
    assert.deepEqual([got.source, got.stale, got.value.videos[0].watching.time], ["net", false, 3000]);
    assert.ok(r.clock.now() - t0 < 500);
  });

  it("item (D-41): mock 2000 ms — cached card after 500 ms, the refresh lands in the background", async () => {
    const r = env.rig();
    const { repo } = setup(r);
    const id = FIX.MOVIE_SIMPLE;
    await r.run(repo.item(id));
    await r.run(r.api.marktime(id, 1, 3000));
    await r.clock.advance(11 * MIN);
    env.mock().setScenario({ rules: [{ path: `^/v1/items/${id}$`, delayMs: 2000, times: 1 }] });
    const t0 = r.clock.now();
    const got = await r.run(repo.item(id, { freshWithinMs: 600_000, waitMs: 500 }));
    assert.equal(r.clock.now() - t0, 500);
    assert.deepEqual([got.source, got.stale, got.value.videos[0].watching.time], ["l1", true, 1200]);
    r.clock.ioGraceMs = 5000;
    await until(r, "card refresh", () => repo.peekItem(id)?.value.videos[0].watching.time === 3000);
    assert.equal(repo.peekItem(id)?.stale, false);
    assert.equal(count(`/v1/items/${id}`), 2);
  });

  it("links: prefetch + resolve → one media-links; new call after 601 s; fresh: true — always new; never stored", async () => {
    const r = env.rig();
    const { mem, l2, repo } = setup(r);
    const mid = FIX.MOVIE_SIMPLE * 1000 + 1;
    const [a, b] = await r.run(Promise.all([repo.links(mid, { cls: "bg" }), repo.links(mid, { cls: "fg" })]));
    assert.equal(a, b);
    assert.ok(a.files[0].urls.hls?.includes("/cdn/hls/"));
    assert.equal(count("/v1/items/media-links"), 1);
    await r.clock.advance(599 * SEC);
    await r.run(repo.links(mid, { cls: "fg" }));
    assert.equal(count("/v1/items/media-links"), 1);
    await r.clock.advance(2 * SEC);
    await r.run(repo.links(mid, { cls: "fg" }));
    assert.equal(count("/v1/items/media-links"), 2);
    await r.run(repo.links(mid, { cls: "fg", fresh: true }));
    await r.run(repo.links(mid, { cls: "fg", fresh: true }));
    assert.equal(count("/v1/items/media-links"), 4);

    // Просроченные ссылки не отдаются вместо ошибки (stale-max 0).
    await r.clock.advance(601 * SEC);
    env.mock().setScenario({ rules: [{ path: "^/v1/items/media-links$", status: 404, times: 1 }] });
    await assert.rejects(r.run(repo.links(mid, { cls: "fg" })), kp("KP-404", 404));

    await r.run(repo.item(FIX.MOVIE_SIMPLE));
    await r.clock.advance(2 * SEC);
    l2.flush();
    const all = dump(mem);
    assert.ok(l2Keys(mem).length > 0);
    assert.ok(!all.includes("links") && !all.includes("/cdn/"), "stream links never reach the storage");
  });

  it("request class: cls from item/listPage reaches the transport; without it requests stay fg", async () => {
    const r = env.rig();
    const { repo } = setup(r);
    const cls = (path: string): string[] => r.t.reqs.filter((x) => x.path === path).map((x) => x.cls);
    await r.run(repo.item(1, { cls: "bg" }));
    await r.run(repo.item(12));
    await r.run(repo.listPage(CATALOG, 2, { cls: "bg" }));
    await r.run(repo.listPage({ kind: "shelf", shelf: "hot" }, 1, { cls: "bg" }));
    await r.run(repo.listPage(FOLDER1, 1, { cls: "bg" }));
    await r.run(repo.listPage({ kind: "similar", id: FIX.MOVIE_SIMPLE }, 1, { cls: "bg" }));
    await r.run(repo.listPage(CATALOG, 1));
    assert.deepEqual(cls("/v1/items/1"), ["bg"]);
    assert.deepEqual(cls("/v1/items/12"), ["fg"]);
    assert.deepEqual(cls("/v1/items"), ["bg", "fg"]);
    assert.deepEqual([cls("/v1/items/hot"), cls("/v1/bookmarks/1"), cls("/v1/items/similar")], [["bg"], ["bg"], ["bg"]]);
    assert.equal(r.t.reqs.find((x) => x.path === "/v1/items/1")?.timeoutMs, 15_000);
  });

  it("compact card in kp.l2.*: no stream urls, no subtitles, plot ≤ 600; L1 keeps the full card; cold start hydrates", async () => {
    const r = env.rig();
    const { mem, l2, repo } = setup(r);
    const full = await r.run(repo.item(9001));
    assert.equal(full.value.videos[0].subtitles.length, 1);
    assert.ok(full.value.videos[0].files[0].urls.hls?.includes("cdn/hls"));
    assert.equal(full.value.plot?.length, LONG_PLOT.length);
    await r.run(repo.item(FIX.SERIAL_BIG));
    l2.flush();
    const raw = dump(mem);
    assert.ok(l2Keys(mem).some((k) => k.startsWith(cacheKeys.item(9001))));
    assert.ok(l2Keys(mem).some((k) => k.startsWith(cacheKeys.item(FIX.SERIAL_BIG))));
    assert.ok(!raw.includes("cdn/hls") && !raw.includes("/cdn/") && !raw.includes("subtitles"), raw.slice(0, 400));

    const cold = setup(r, mem).repo;
    const got = await cold.item(9001);
    assert.deepEqual([got.source, got.stale], ["l2", false]);
    const v = got.value.videos[0];
    assert.deepEqual([v.subtitles, v.files[0].urls, v.files[0].quality], [[], {}, "1080p"]);
    assert.ok((got.value.plot ?? "").length <= 600);
    const serial = await cold.item(FIX.SERIAL_BIG);
    assert.equal(serial.value.seasons[0].episodes[3].watching.time, 600);
    assert.deepEqual(serial.value.seasons[0].episodes[0].subtitles, []);
    assert.equal(count("/v1/items/9001"), 1);

    // Холодный старт с устаревшей карточкой: значение сразу, полная карточка — фоном.
    await r.clock.advance(11 * MIN);
    const cold2 = setup(r, mem).repo;
    const stale = await cold2.item(9001);
    assert.deepEqual([stale.source, stale.stale], ["l2", true]);
    await until(r, "full card", () => cold2.peekItem(9001)?.value.videos[0].subtitles.length === 1);
    assert.equal(count("/v1/items/9001"), 2);
  });

  it("invalidateAfterProgress marks, not deletes: old values at once, refresh in background; item 12 untouched", async () => {
    const r = env.rig();
    const { repo } = setup(r);
    const c1 = await r.run(repo.item(1));
    await r.run(repo.item(12));
    await r.run(repo.history());
    await r.run(repo.serials());
    await r.run(repo.watchingMovies());
    repo.invalidateAfterProgress(1);

    const g1 = await repo.item(1);
    assert.deepEqual([g1.source, g1.stale, g1.fetchedAt], ["l1", true, c1.fetchedAt]);
    assert.equal(g1.value, c1.value);
    assert.equal((await repo.item(12)).stale, false);
    assert.equal(repo.peekItem(12)?.stale, false);
    assert.equal((await repo.history()).stale, true);
    assert.equal((await repo.serials()).stale, true);
    assert.equal((await repo.watchingMovies()).stale, true);
    await until(r, "refreshes", () => ["/v1/items/1", "/v1/history", "/v1/watching/serials", "/v1/watching/movies"].every((p) => count(p) === 2));
    assert.equal(count("/v1/items/12"), 1);
    assert.equal(repo.peekItem(1)?.stale, false);
  });

  it("invalidateAfterBookmark marks bm, the card and pages of that folder only", async () => {
    const r = env.rig();
    const { cache, repo } = setup(r);
    const folder12: ListSource = { kind: "folder", folder: 12 };
    const policy = { ttlMs: HOUR, staleMaxMs: DAY, persist: false };
    await cache.get(cacheKeys.list(folder12, 1), policy, async () => ({ items: [], pagination: { total: 1, current: 1, perpage: 48, totalItems: 0 } }));
    await r.run(repo.bookmarkFolders());
    await r.run(repo.item(FIX.MOVIE_SIMPLE));
    await r.run(repo.listPage(FOLDER1, 1));
    await r.run(repo.listPage(CATALOG, 1));
    repo.invalidateAfterBookmark(FIX.MOVIE_SIMPLE, 1);
    const marked = (key: string): boolean | undefined => cache.peek(key)?.stale;
    assert.equal(marked(cacheKeys.bookmarks()), true);
    assert.equal(repo.peekItem(FIX.MOVIE_SIMPLE)?.stale, true);
    assert.equal(marked(cacheKeys.list(FOLDER1, 1)), true);
    assert.equal(marked(cacheKeys.list(folder12, 1)), false);
    assert.equal(marked(cacheKeys.list(CATALOG, 1)), false);
  });

  it("cacheKeys: canonical source JSON in base64url; no key is a prefix of another entity's key", () => {
    const k = cacheKeys.list({ kind: "catalog", type: "movie", sort: "-rating" }, 1);
    assert.equal(k, cacheKeys.list({ sort: "-rating", type: "movie", kind: "catalog", genre: undefined }, 1));
    const m = /^list:([A-Za-z0-9_-]+):1:$/.exec(k);
    assert.ok(m, k);
    assert.deepEqual(JSON.parse(b64urlDecode(m[1])), { kind: "catalog", type: "movie", sort: "-rating" });
    assert.ok(!cacheKeys.item(12).startsWith(cacheKeys.item(1)));
    assert.ok(!cacheKeys.list(CATALOG, 10).startsWith(cacheKeys.list(CATALOG, 1)));
    assert.ok(!cacheKeys.list({ kind: "folder", folder: 12 }, 1).startsWith(cacheKeys.listSource(FOLDER1)));
    assert.ok(cacheKeys.list(FOLDER1, 3).startsWith(cacheKeys.listSource(FOLDER1)));
    assert.ok(!cacheKeys.links(12).startsWith(cacheKeys.links(1)));
    assert.ok(!cacheKeys.genres("movies").startsWith(cacheKeys.genres("movie")));
  });
});
