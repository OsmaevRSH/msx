import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import { replaceContent } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { ids } from "../../src/router/ids.ts";
import { refreshAfterPlayback } from "../../src/screens/refresh.ts";
import { MAX_BYTES, WINDOW, bytes, onExtend } from "../../src/screens/list.ts";
import { FIX, catalog } from "../../tools/kpmock/fixtures.ts";
import { watchKey } from "../../tools/kpmock/state.ts";
import { FAKE_EPOCH, FakeClock } from "../helpers/fake-clock.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";
import { waitFor } from "../progress/progress-rig.ts";

// «Я смотрю» S15 (спец. §11, v1.11): сериалы «Я смотрю» с новыми сериями первыми, начатые фильмы с прогрессом,
// плитки и окно списков, SWR, «нет связи», сверка после просмотра.

const P = TEST_P;
const DAY = 86_400_000;
const EXTEND = "interaction:commit:message:extend:";

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(o: Omit<TestAppOptions, "loggedIn"> = {}): Promise<TestApp> {
  const t = await createTestApp({ ...o, loggedIn: true });
  apps.push(t);
  return t;
}

const screen = async (t: TestApp): Promise<MsxContentRoot> => (await t.request(ids.watching())) as MsxContentRoot;
const tiles = (s: MsxContentRoot): MsxContentItem[] => s.items ?? [];
const tile = (s: MsxContentRoot, id: number): MsxContentItem | undefined => tiles(s).find((i) => i.id === `i${id}`);
const actions = (t: TestApp): string[] => t.host.actions.map((a) => a.action);
const paths = (t: TestApp): string[] => t.mock.calls().map((c) => c.path);

/** Сериал «Я смотрю»: первая серия просмотрена, `fresh` новых. */
function watchSerial(t: TestApp, id: number, fresh = 0): void {
  t.mock.state.watching.set(watchKey(id, 1, 1), { time: 60, status: 1, updated: Math.floor(Date.now() / 1000) - id });
  if (fresh > 0) t.mock.state.newEpisodes.set(id, fresh);
}

describe("watchingScreen «Я смотрю» (S15)", () => {
  it("the same large tiles as lists: serials with new episodes (+N, share watched) in the KinoPub order, then started movies (progress, time left)", async () => {
    const t = await make();
    watchSerial(t, FIX.SERIAL_SMALL, 3);
    const s = await screen(t);
    assert.equal(s.type, "list");
    assert.equal(s.flag, "watching");
    assert.equal(s.headline, "Я смотрю");
    assert.equal(s.cache, false);
    assert.equal(s.extension, "2 сериала · 1 фильм");
    assert.equal(s.template?.layout, "0,0,2,4");
    assert.equal((s.template?.selection as { headline?: string } | undefined)?.headline, "{context:kt}");
    // Оба сериала с новыми сериями — порядок KinoPub (последний просмотр первым): «Короткий» отмечен только что.
    assert.deepEqual(tiles(s).map((i) => i.id), [`i${FIX.SERIAL_SMALL}`, `i${FIX.SERIAL_BIG}`, `i${FIX.MOVIE_SIMPLE}`]);
    const big = tile(s, FIX.SERIAL_BIG);
    assert.equal(big?.badge, "+2");
    assert.equal(big?.progress, 0.02, "3 of 200 episodes watched");
    assert.equal(big?.progressColor, "msx-blue");
    assert.equal(big?.kid, String(FIX.SERIAL_BIG), "kid is a string for {context:kid} (CD-10)");
    assert.equal(big?.action, `content:request:interaction:${ids.item(FIX.SERIAL_BIG)}@${P}`);
    assert.equal(tile(s, FIX.SERIAL_SMALL)?.badge, "+3");
    const movie = tile(s, FIX.MOVIE_SIMPLE);
    assert.equal(movie?.progress, 0.22, "1200 of 5400 s from the history");
    assert.equal(movie?.stamp, "1 ч 10 м");
    assert.equal(movie?.badge, undefined);
    assert.equal(tiles(s)[0]?.focus, true);
    assert.equal(tiles(s)[1]?.focus, undefined);
    assert.ok(s.inserts !== undefined && s.inserts.length > 0, "edge guards from msx/edges.ts");
  });

  it("asks /v1/watching/serials?subscribed=1, /v1/watching/movies and the history; a repeat within a minute — no requests (SWR)", async () => {
    const t = await make();
    await screen(t);
    const serials = t.mock.calls().find((c) => c.path === "/v1/watching/serials");
    assert.equal(new URLSearchParams(serials?.query).get("subscribed"), "1");
    assert.deepEqual(paths(t).sort(), ["/v1/history", "/v1/watching/movies", "/v1/watching/serials"]);
    const n = t.mock.calls().length;
    await screen(t);
    assert.equal(t.mock.calls().length, n);
  });

  it("serials with new episodes go first, the rest keep the KinoPub order", async () => {
    const t = await make();
    t.mock.state.newEpisodes.clear();
    watchSerial(t, FIX.SERIAL_SMALL, 1);
    const s = await screen(t);
    assert.deepEqual(tiles(s).map((i) => i.id).slice(0, 2), [`i${FIX.SERIAL_SMALL}`, `i${FIX.SERIAL_BIG}`]);
    assert.equal(tile(s, FIX.SERIAL_BIG)?.badge, undefined);
  });

  it("a movie marked watched on this TV after its history entry disappears (overlay, as on «Продолжить»)", async () => {
    const t = await make({ clock: new FakeClock(Date.now()) });
    t.ctx.overlay.set(FIX.MOVIE_SIMPLE, 0, 1, { time: 5400, status: 1 });
    const s = await screen(t);
    assert.equal(tile(s, FIX.MOVIE_SIMPLE), undefined);
    assert.equal(s.extension, "2 сериала");
  });

  it("nothing is being watched: a text and «Найти фильм» (a menu screen has no use for «Назад»)", async () => {
    const t = await make();
    t.mock.state.watching.clear();
    t.mock.state.newEpisodes.clear();
    const s = await screen(t);
    assert.equal(s.items, undefined);
    const page = s.pages?.[0]?.items ?? [];
    assert.deepEqual(page.map((i) => [i.type, i.text ?? i.label]), [
      ["space", "Здесь появятся сериалы и фильмы, которые вы смотрите"], ["button", "{ico:search} Найти фильм"],
    ]);
    assert.equal(page[1]?.action, `content:request:interaction:search@${P}`);
  });

  it("network down with an L2 copy a week old: «не отвечает» at 6 s, then the tiles from L2 with «нет связи» (X-1)", async () => {
    const a = await make();
    await screen(a);
    a.ctx.l2.flush();
    const b = await make({ mock: a.mock, storage: a.storage, clock: new FakeClock(FAKE_EPOCH + 8 * DAY) });
    b.mock.setScenario({ rules: [{ path: ".*", drop: true }] });
    assert.equal((await screen(b)).flag, "late_1");
    await waitFor(b, () => actions(b).length > 0, "the late replace");
    assert.deepEqual(actions(b), [replaceContent("late_1", P, ids.watching())]);
    const s = await screen(b);
    assert.equal(tiles(s).length, 3);
    assert.equal(s.extension, "2 сериала · 1 фильм · {ico:msx-yellow:history} нет связи");
  });

  it(`a long list: window ≤ ${WINDOW} tiles and ≤ 32 KB, live edge → extend shifts the window from memory, reload only while current`, async () => {
    const t = await make();
    const serials = catalog().filter((it) => it.seasons !== undefined && !it.unlisted && !it.deleted).slice(0, 150);
    for (const it of serials) watchSerial(t, it.id);
    const s = await screen(t);
    const first = tiles(s).length;
    assert.ok(first <= WINDOW && first >= 2 * 6, String(first));
    assert.ok(bytes(s) <= MAX_BYTES, String(bytes(s)));
    assert.deepEqual(tiles(s).at(-1)?.live, { type: "setup", action: `${EXTEND}watching:down:${first}` });
    const n = t.mock.calls().length;
    t.ctx.current.onRequest(ids.watching());
    await onExtend(t.ctx, `watching:down:${first}`);
    assert.deepEqual(actions(t), ["reload:content"]);
    const next = await screen(t);
    const st = t.ctx.state.lists.get("watching") as { from: number; to: number } & { items: unknown[] };
    assert.ok(st.from > 0, "the window moved down");
    assert.ok(tiles(next).length <= WINDOW && bytes(next) <= MAX_BYTES);
    assert.equal(tiles(next)[0]?.live?.action, `${EXTEND}watching:up:${st.from}`);
    assert.equal(t.mock.calls().length, n, "the window moves in memory, SWR answers from the cache");
    t.ctx.current.onRequest(ids.item(FIX.SERIAL_BIG));
    await onExtend(t.ctx, `watching:up:${st.from}`);
    assert.deepEqual(actions(t), ["reload:content"], "not current — no reload");
  });

  it("after playback while «Я смотрю» is current: marked stale, refreshed and replaced with flag watching", async () => {
    const t = await make();
    await screen(t);
    t.ctx.current.onRequest(ids.watching());
    // Другой ТВ досмотрел первую серию «Короткого» и в KinoPub вышли новые серии.
    t.mock.state.newEpisodes.set(FIX.SERIAL_SMALL, 4);
    refreshAfterPlayback(t.ctx, FIX.MOVIE_SIMPLE);
    await waitFor(t, () => actions(t).length > 0, "the replace");
    assert.deepEqual(actions(t), [replaceContent("watching", P, ids.watching())]);
    assert.equal(tile(await screen(t), FIX.SERIAL_SMALL)?.badge, "+4");
  });

  it("after playback with another screen current: no replace (the refresh is cancelled), the data is stale for the next visit", async () => {
    const t = await make();
    await screen(t);
    t.ctx.current.onRequest(ids.item(FIX.MOVIE_SIMPLE));
    t.mock.state.newEpisodes.set(FIX.SERIAL_SMALL, 4);
    refreshAfterPlayback(t.ctx, FIX.MOVIE_SIMPLE);
    await realSleep(30);
    assert.deepEqual(actions(t), []);
    t.ctx.current.onRequest(ids.watching());
    await screen(t);
    await waitFor(t, () => actions(t).length > 0, "the replace after the background refresh");
    assert.deepEqual(actions(t), [replaceContent("watching", P, ids.watching())]);
  });
});
