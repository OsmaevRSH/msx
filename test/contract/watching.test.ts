import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MsxContentItem, MsxContentRoot, MsxMenuRoot, MsxResolveResponse } from "../../src/msx/types.ts";
import { ids } from "../../src/router/ids.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";
import { watchKey } from "../../tools/kpmock/state.ts";
import { load, marktimes, player, snapshot, toggles, waitFor, watchingReads } from "../progress/progress-rig.ts";
import { actions, assertCleanTraffic, follow, menuItem, pageItems, pick } from "./rig.ts";

// Contract «Я смотрю» (v1.11, спец. §11 S15): только по действиям из ответов, как MSX — пункт меню → экран «Я смотрю» →
// плитка фильма → карточка → «Продолжить» → события плеера → `marktime` → «Назад» к «Я смотрю»: экран из кэша сразу, с
// позицией ТВ (оверлей записан после загрузки истории), а фоновая сверка с KinoPub её подтверждает (спец. §6.3, §8.4).

const MOVIE = FIX.MOVIE_SIMPLE;
const DURATION = 5400;

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

const tile = (s: MsxContentRoot, id: number): MsxContentItem => pick(s.items, (i) => i.id === `i${id}`, `tile ${id}`);
const serialsCalls = (t: TestApp): URLSearchParams[] =>
  t.mock.calls().filter((c) => c.path === "/v1/watching/serials").map((c) => new URLSearchParams(c.query));

describe("contract «Я смотрю»", () => {
  it("menu → «Я смотрю» → movie → card → play to 50 % → back: the new progress at once, the background refresh confirms it", async () => {
    const t = await createTestApp({ loggedIn: true });
    apps.push(t);

    const menu = (await t.request(ids.init())) as MsxMenuRoot;
    assert.deepEqual(menu.menu.slice(0, 4).map((m) => m.label), ["Главная", "Я смотрю", "Поиск", "Новинки"]);
    const watchingId = follow(menuItem(menu, "watching").data, "");
    assert.equal(watchingId, ids.watching());

    const w = (await t.request(watchingId)) as MsxContentRoot;
    assert.equal(t.ctx.current.get(), watchingId);
    // QA-API-2: «+N» — при остатке 1–5: «Короткий» (5 из 6) первым, у «Большого» (197 из 200) бейджа нет.
    assert.deepEqual([w.items?.[0]?.id, tile(w, FIX.SERIAL_SMALL).badge, tile(w, FIX.SERIAL_BIG).badge], [`i${FIX.SERIAL_SMALL}`, "+5", undefined]);
    assert.equal(tile(w, MOVIE).progress, 0.22);
    assert.deepEqual(serialsCalls(t).map((q) => q.get("subscribed")), ["1"]);

    // Плитка → карточка → «▶ Продолжить» (resolve), как MSX.
    const cardId = follow(tile(w, MOVIE).action, "content");
    assert.equal(cardId, ids.item(MOVIE));
    const card = (await t.request(cardId)) as MsxContentRoot;
    const main = pick(pageItems(card), (i) => i.id === "b_main", "main button");
    const res = (await t.request(follow(main.action, "video:resolve"))) as MsxResolveResponse;
    assert.equal(res.error, undefined);
    const props = res.properties ?? {};
    assert.equal(props["kp:i"], String(MOVIE));

    load(t, props, 1200, DURATION);
    player(t, "play", { state: 1, position: 1200, duration: DURATION });
    snapshot(t, 2700, props, DURATION);
    await waitFor(t, () => marktimes(t).at(-1)?.time === 2700, "marktime at 50 %");
    player(t, "stop", { position: 2700, duration: DURATION });
    const cardReplace = `replace:content:item_${MOVIE}:request:interaction:${cardId}@${TEST_P}`;
    await waitFor(t, () => actions(t).includes(cardReplace) || actions(t).includes(`focus:b_main`), "the card refresh after stop");
    assert.ok(!actions(t).some((a) => a.includes("replace:content:watching")), "«Я смотрю» is not current — not replaced");

    // «Назад»: MSX перезапрашивает «Я смотрю». Данные помечены устаревшими — экран сразу из кэша, не дожидаясь KinoPub,
    // и уже с позицией ТВ: оверлей записан после загрузки истории (оба времени — по часам ТВ). Сверка приносит ту же
    // позицию от KinoPub — экран не заменяется.
    t.host.clearActions();
    const back = (await t.request(watchingId)) as MsxContentRoot;
    assert.deepEqual([tile(back, MOVIE).progress, tile(back, MOVIE).stamp], [0.5, "45 мин"], "at once from the cache with the TV position");
    const unchanged = (): number => t.ctx.metrics.summary().counters["refresh:unchanged"] ?? 0;
    await waitFor(t, () => unchanged() > 0, "the background refresh");
    assert.ok(!actions(t).some((a) => a.includes("replace:content:watching")), "nothing to replace");
    const fresh = (await t.request(watchingId)) as MsxContentRoot;
    assert.equal(tile(fresh, MOVIE).progress, 0.5);
    assert.deepEqual(serialsCalls(t).map((q) => q.get("subscribed")), ["1", "1"], "the subscribed list refreshed once");
    assertCleanTraffic(t.mock.calls(), [t]);
  });

  /** Карточка фильма → «▶ Продолжить» → плеер с 1200 с; свойства ответа resolve — для событий плеера. */
  async function play(t: TestApp): Promise<Record<string, string>> {
    const card = (await t.request(ids.item(MOVIE))) as MsxContentRoot;
    const res = (await t.request(follow(pick(pageItems(card), (i) => i.id === "b_main", "main button").action, "video:resolve"))) as MsxResolveResponse;
    const props = res.properties ?? {};
    load(t, props, 1200, DURATION);
    player(t, "play", { state: 1, position: 1200, duration: DURATION });
    return props;
  }
  const continueIds = async (t: TestApp): Promise<string[]> =>
    ((await t.request(ids.home())) as MsxContentRoot).pages?.[0]?.items.filter((i) => i.action !== undefined).map((i) => String(i.id)) ?? [];
  const status = (t: TestApp): number | undefined => t.mock.state.watching.get(watchKey(MOVIE, 0, 1))?.status;

  it("M-1 / QA-API-8: KinoPub marks watched from 85 % — stopped at 87 %, the movie leaves «Продолжить» and «Я смотрю», no toggle", async () => {
    const t = await createTestApp({ loggedIn: true });
    apps.push(t);
    t.mock.setScenario({ autoWatched: 0.85 });
    assert.ok((await continueIds(t)).includes(`c${MOVIE}`));
    const props = await play(t);
    snapshot(t, 4698, props, DURATION);
    await waitFor(t, () => marktimes(t).at(-1)?.time === 4698, "marktime at 87 %");
    assert.equal(status(t), 1, "KinoPub: watched");
    player(t, "stop", { position: 4698, duration: DURATION });
    await waitFor(t, () => t.ctx.log.entries().some((e) => e.msg === "refresh_after_playback"), "refresh after playback");
    assert.ok(!(await continueIds(t)).includes(`c${MOVIE}`), "gone from «Продолжить»");
    assert.equal(((await t.request(ids.watching())) as MsxContentRoot).items?.some((i) => i.id === `i${MOVIE}`), false, "gone from «Я смотрю»");
    assert.deepEqual(toggles(t), []);
  });

  it("M-1: 87 % marks it watched in KinoPub; at 95 % the outbox reads the status, finds it watched and sends no toggle (it would unmark)", async () => {
    const t = await createTestApp({ loggedIn: true });
    apps.push(t);
    t.mock.setScenario({ autoWatched: 0.85 });
    const props = await play(t);
    snapshot(t, 4698, props, DURATION);
    await waitFor(t, () => marktimes(t).at(-1)?.time === 4698, "marktime at 87 %");
    assert.equal(status(t), 1);
    snapshot(t, 5130, props, DURATION);
    await waitFor(t, () => watchingReads(t).length > 0, "the outbox reads the status before a toggle");
    player(t, "stop", { position: 5130, duration: DURATION });
    await waitFor(t, () => t.ctx.log.entries().some((e) => e.msg === "refresh_after_playback"), "refresh after playback");
    assert.deepEqual(toggles(t), []);
    assert.equal(status(t), 1);
  });

  it("every tile of «Я смотрю» leads to a card of the plugin; the screen and its tiles fit the window rules", async () => {
    const t = await createTestApp({ loggedIn: true });
    apps.push(t);
    const w = (await t.request(ids.watching())) as MsxContentRoot;
    for (const it of w.items ?? []) {
      const id = follow(it.action, "content");
      const card = (await t.request(id)) as MsxContentRoot;
      assert.equal(card.flag, `item_${it.kid}`);
    }
    assert.ok((w.items?.length ?? 0) <= 96);
  });
});
