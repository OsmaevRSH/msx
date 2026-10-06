import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MsxContentItem, MsxContentRoot, MsxMenuRoot, MsxResolveResponse } from "../../src/msx/types.ts";
import { ids } from "../../src/router/ids.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";
import { load, marktimes, player, snapshot, waitFor } from "../progress/progress-rig.ts";
import { actions, assertCleanTraffic, follow, menuItem, pageItems, pick } from "./rig.ts";

// Contract «Я смотрю» (v1.11, спец. §11 S15): только по действиям из ответов, как MSX — пункт меню → экран «Я смотрю» →
// плитка фильма → карточка → «Продолжить» → события плеера → `marktime` → «Назад» к «Я смотрю»: экран из кэша сразу,
// а после фонового обновления — замена своим флагом с новым прогрессом (как «Продолжить» главной, спец. §6.3, §8.4).

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
  it("menu → «Я смотрю» → movie → card → play to 50 % → back: the tile is replaced with the new progress", async () => {
    const t = await createTestApp({ loggedIn: true });
    apps.push(t);

    const menu = (await t.request(ids.init())) as MsxMenuRoot;
    assert.deepEqual(menu.menu.slice(0, 4).map((m) => m.label), ["Главная", "Я смотрю", "Поиск", "Новинки"]);
    const watchingId = follow(menuItem(menu, "watching").data, "");
    assert.equal(watchingId, ids.watching());

    const w = (await t.request(watchingId)) as MsxContentRoot;
    assert.equal(t.ctx.current.get(), watchingId);
    assert.equal(tile(w, FIX.SERIAL_BIG).badge, "+2", "a serial with new episodes");
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

    // «Назад»: MSX перезапрашивает «Я смотрю». Данные помечены устаревшими — экран сразу из кэша, затем замена.
    t.host.clearActions();
    const back = (await t.request(watchingId)) as MsxContentRoot;
    assert.equal(tile(back, MOVIE).progress, 0.22, "at once from the cache, not waiting for KinoPub");
    const replace = `replace:content:watching:request:interaction:${watchingId}@${TEST_P}`;
    await waitFor(t, () => actions(t).includes(replace), "replace:content:watching");
    const fresh = (await t.request(watchingId)) as MsxContentRoot;
    assert.equal(tile(fresh, MOVIE).progress, 0.5);
    assert.equal(tile(fresh, MOVIE).stamp, "45 мин");
    assert.deepEqual(serialsCalls(t).map((q) => q.get("subscribed")), ["1", "1"], "the subscribed list refreshed once");
    assertCleanTraffic(t.mock.calls(), [t]);
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
