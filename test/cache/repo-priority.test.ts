import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KvStore } from "../../src/bridge/storage.ts";
import { L2 } from "../../src/cache/l2.ts";
import { Lru } from "../../src/cache/lru.ts";
import { Repo } from "../../src/cache/repo.ts";
import type { ListSource } from "../../src/cache/repo.ts";
import { SwrCache } from "../../src/cache/swr.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";
import { type Rig, useKpApiMock } from "../api/kpapi-rig.ts";

// Single-flight кэша и класс запроса: префетч (фон) и экран (передний план) делят один запрос (спец. §8.3, §8.5).

const CATALOG: ListSource = { kind: "catalog", type: "movie", sort: "-updated" };
const CARD = FIX.MOVIE_SIMPLE;

function setup(r: Rig): Repo {
  const l2 = new L2(new KvStore(new MemoryStorage(), r.log), r.clock, undefined, r.log);
  const cache = new SwrCache({ l1: new Lru(), l2, clock: r.clock, log: r.log });
  return new Repo({ api: r.api, cache, clock: r.clock, log: r.log });
}

describe("Repo: a fg caller joining a bg request", () => {
  const env = useKpApiMock();
  const count = (path: string): number => env.calls(path).length;

  it("prefetch, then open the same card: the queued bg request is promoted — one request, fg, never bg-dropped", async () => {
    const r = env.rig();
    const repo = setup(r);
    // Заняты 3 слота переднего плана и единственный фоновый: префетч встаёт в очередь фоновых.
    const releases: (() => void)[] = [];
    const held = (["fg", "fg", "fg", "bg"] as const).map((c) => r.limiter.run(c, () => new Promise<void>((res) => releases.push(res))));
    const prefetch = repo.item(CARD, { cls: "bg" });
    const open = repo.item(CARD);
    // Экран ждёт ещё один запрос переднего плана дольше 200 мс — фоновые из очереди сбрасываются.
    const other = r.limiter.run("fg", async () => "other");
    await r.clock.advance(250);
    (releases[0] as () => void)();

    const [opened, prefetched] = await r.run(Promise.all([open, prefetch]));
    assert.deepEqual([opened.source, opened.value.id], ["net", CARD]);
    assert.equal(prefetched.value, opened.value);
    assert.equal(count(`/v1/items/${CARD}`), 1);
    assert.equal(r.t.reqs.find((x) => x.path === `/v1/items/${CARD}`)?.prio?.cls(), "fg");
    releases.slice(1).forEach((f) => f());
    await r.run(Promise.all([...held, other]));
  });

  it("links, list pages and similar: a fg caller promotes the queued bg prefetch of the same key", async () => {
    const r = env.rig();
    const repo = setup(r);
    let release = (): void => {};
    const held = r.limiter.run("bg", () => new Promise<void>((res) => (release = res)));
    const mid = CARD * 1000 + 1;
    const similar: ListSource = { kind: "similar", id: CARD };
    const bg = [repo.links(mid, { cls: "bg" }), repo.listPage(CATALOG, 2, { cls: "bg" }), repo.listPage(similar, 1, { cls: "bg" })];
    const fg = [repo.links(mid, { cls: "fg" }), repo.listPage(CATALOG, 2), repo.listPage(similar, 1)];
    await r.run(Promise.all([...bg, ...fg]));
    assert.deepEqual(r.limiter.inFlight(), { fg: 0, bg: 1 }, "done while the only bg slot is still held");
    assert.deepEqual([count("/v1/items/media-links"), count("/v1/items"), count("/v1/items/similar")], [1, 1, 1]);
    release();
    await held;
  });

  it("a fg caller with nothing in flight does not touch an unrelated bg prefetch", async () => {
    const r = env.rig();
    const repo = setup(r);
    let release = (): void => {};
    const held = r.limiter.run("bg", () => new Promise<void>((res) => (release = res)));
    const prefetch = repo.listPage(CATALOG, 2, { cls: "bg" });
    await r.run(repo.listPage(CATALOG, 3));
    await r.clock.advance(0);
    assert.equal(count("/v1/items"), 1, "page 2 still waits for the bg slot");
    release();
    await r.run(Promise.all([held, prefetch]));
    assert.equal(count("/v1/items"), 2);
  });
});
