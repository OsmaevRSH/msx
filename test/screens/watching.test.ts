import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import { replaceContent } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { ids } from "../../src/router/ids.ts";
import { refreshAfterPlayback } from "../../src/screens/refresh.ts";
import { MAX_BYTES, WINDOW, bytes, onExtend } from "../../src/screens/list.ts";
import type { ListEntry } from "../../src/screens/list.ts";
import { FIX, catalog, findItem } from "../../tools/kpmock/fixtures.ts";
import { watchKey } from "../../tools/kpmock/state.ts";
import { FAKE_EPOCH, FakeClock } from "../helpers/fake-clock.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";
import { waitFor } from "../progress/progress-rig.ts";

// «Я смотрю» S15 (спец. §11, v1.11): сериалы «Я смотрю» с меньшим остатком серий первыми (QA-API-2), начатые фильмы
// с прогрессом, плитки и окно списков, SWR, «нет связи», сверка после просмотра.

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

/** Сериал «Я смотрю»: просмотрены первые `n` серий (по умолчанию одна). */
function watchSerial(t: TestApp, id: number, n = 1): void {
  const eps = (findItem(id)?.seasons ?? []).flatMap((x) => x.episodes.map((e) => [x.number, e.number] as const)).slice(0, n);
  for (const [season, e] of eps) t.mock.state.watching.set(watchKey(id, season, e), { time: 60, status: 1, updated: Math.floor(Date.now() / 1000) - id });
}

describe("watchingScreen «Я смотрю» (S15)", () => {
  it("the same large tiles as lists: serials (+N, share watched), then started movies (progress, time left)", async () => {
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
    assert.deepEqual(tiles(s).map((i) => i.id), [`i${FIX.SERIAL_SMALL}`, `i${FIX.SERIAL_BIG}`, `i${FIX.MOVIE_SIMPLE}`]);
    const big = tile(s, FIX.SERIAL_BIG);
    assert.equal(big?.badge, undefined, "197 episodes left — not «new» ones (QA-API-2)");
    assert.equal(big?.progress, 0.02, "3 of 200 episodes watched");
    assert.equal(big?.progressColor, "msx-blue");
    assert.equal(big?.kid, String(FIX.SERIAL_BIG), "kid is a string for {context:kid} (CD-10)");
    assert.equal(big?.action, `content:request:interaction:${ids.item(FIX.SERIAL_BIG)}@${P}`);
    assert.equal(tile(s, FIX.SERIAL_SMALL)?.badge, "+3", "3 of 6 left");
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

  it("QA-API-2: serials by fewer episodes left, not in the KinoPub order; «+N» only for 1–5 left; nothing left — last", async () => {
    const t = await make();
    // KinoPub отдаёт «Большой» первым (смотрели позже), но у «Короткого» осталось 5 серий из 6, а у «Большого» — 197.
    const s = await screen(t);
    assert.deepEqual(tiles(s).map((i) => [i.id, i.badge]), [
      [`i${FIX.SERIAL_SMALL}`, "+5"], [`i${FIX.SERIAL_BIG}`, undefined], [`i${FIX.MOVIE_SIMPLE}`, undefined],
    ]);
    // «Короткий» досмотрен, но оставлен в «Я смотрю» (ждёт новых серий): смотреть нечего — после «Большого».
    const t2 = await make();
    watchSerial(t2, FIX.SERIAL_SMALL, 6);
    t2.mock.state.watchlist.set(FIX.SERIAL_SMALL, true);
    const s2 = await screen(t2);
    assert.deepEqual(tiles(s2).map((i) => [i.id, i.badge]).slice(0, 2), [[`i${FIX.SERIAL_BIG}`, undefined], [`i${FIX.SERIAL_SMALL}`, undefined]]);
  });

  it("a movie marked watched on this TV after the history was loaded disappears (overlay, as on «Продолжить»)", async () => {
    // Часы ТВ (FakeClock, 2026-01-01) отстают от KinoPub (mock, сейчас): сравнение — с загрузкой истории, по часам ТВ.
    const t = await make();
    assert.ok(tile(await screen(t), FIX.MOVIE_SIMPLE));
    await t.clock.advance(1000);
    t.ctx.overlay.set(FIX.MOVIE_SIMPLE, 0, 1, { time: 5400, status: 1 });
    const s = await screen(t);
    assert.equal(tile(s, FIX.MOVIE_SIMPLE), undefined);
    assert.equal(s.extension, "2 сериала");
  });

  it("QA-API-8: a movie stopped at 87 % is watched, as KinoPub marks it from 85 % — gone, though watching/movies still lists it", async () => {
    const t = await make();
    const time = Math.round(0.87 * 5400);
    t.mock.state.watching.set(watchKey(FIX.MOVIE_SIMPLE, 0, 1), { time, status: 0, updated: Math.floor(Date.now() / 1000) });
    const h = t.mock.state.history.find((x) => x.item === FIX.MOVIE_SIMPLE);
    assert.ok(h);
    h.time = time;
    const s = await screen(t);
    assert.ok(t.mock.calls().some((c) => c.path === "/v1/watching/movies"));
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

  it("QA-API-12: KinoPub answers 429 with an L2 copy a week old → the tiles from L2 with «KinoPub занят», not «нет связи»", async () => {
    const a = await make();
    await screen(a);
    a.ctx.l2.flush();
    const b = await make({ mock: a.mock, storage: a.storage, clock: new FakeClock(FAKE_EPOCH + 8 * DAY) });
    b.mock.setScenario({ rules: [{ path: "^/v1/", status: 429 }] });
    await screen(b);
    await waitFor(b, () => actions(b).length > 0, "the late replace");
    const s = await screen(b);
    assert.equal(tiles(s).length, 3);
    assert.equal(s.extension, "2 сериала · 1 фильм · {ico:msx-yellow:history} KinoPub занят");
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
    const st = t.ctx.state.lists.get("watching") as ListEntry & { from: number };
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
    // Другой ТВ досмотрел вторую серию «Короткого»: осталось 4 из 6.
    watchSerial(t, FIX.SERIAL_SMALL, 2);
    refreshAfterPlayback(t.ctx, FIX.MOVIE_SIMPLE);
    await waitFor(t, () => actions(t).length > 0, "the replace");
    assert.deepEqual(actions(t), [replaceContent("watching", P, ids.watching())]);
    assert.equal(tile(await screen(t), FIX.SERIAL_SMALL)?.badge, "+4");
  });

  it("after playback with another screen current: no replace (the refresh is cancelled), the data is stale for the next visit", async () => {
    const t = await make();
    await screen(t);
    t.ctx.current.onRequest(ids.item(FIX.MOVIE_SIMPLE));
    watchSerial(t, FIX.SERIAL_SMALL, 2);
    refreshAfterPlayback(t.ctx, FIX.MOVIE_SIMPLE);
    await realSleep(30);
    assert.deepEqual(actions(t), []);
    t.ctx.current.onRequest(ids.watching());
    await screen(t);
    await waitFor(t, () => actions(t).length > 0, "the replace after the background refresh");
    assert.deepEqual(actions(t), [replaceContent("watching", P, ids.watching())]);
  });
});
