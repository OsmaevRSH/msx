// Даты экранов (fmtDate, fmtTime) — в местной зоне: снимки одинаковы на любой машине только в одной зоне.
process.env.TZ = "UTC";

import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as realSleep } from "node:timers/promises";
import { sleep } from "../../src/core/clock.ts";
import { encodeListKey, ids, msgs } from "../../src/router/ids.ts";
import { FIX, findItem } from "../../tools/kpmock/fixtures.ts";
import { answerIssues } from "../../tools/crawl-rules.ts";
import { FAKE_EPOCH } from "../helpers/fake-clock.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";

// Golden JSON ключевых экранов (этап 32; Plan B §12.2 `msx`). Детерминизм: адрес плагина `TEST_P`, FakeClock с
// `now` = FAKE_EPOCH, свежий mock на каждый снимок (код входа — первый в его счётчике), а `Date` замёрзший на том же
// FAKE_EPOCH — mock считает от него подписку, историю и просмотры; случайный порт mock в адресах постеров и потока
// заменён на `MOCK`. Перезапись: `UPDATE_GOLDEN=1 npm test`.

const UPDATE = process.env.UPDATE_GOLDEN === "1";
const MOCK = "http://kpmock.invalid";
const MOVIES = encodeListKey({ src: "catalog", type: "movie", sort: "-updated" });
const A12_MID = findItem(FIX.MOVIE_AUDIO12)?.videos?.[0]?.id ?? 0;
/** С замёрзшим `Date` зависший промис FakeClock не распознаёт — тест падает по своему сроку. */
const LIMIT = { timeout: 60_000 };

let apps: TestApp[] = [];

before(() => {
  mock.timers.enable({ apis: ["Date"], now: FAKE_EPOCH });
});

after(async () => {
  for (const t of apps) await t.close();
  apps = [];
  mock.timers.reset();
});

async function make(o: TestAppOptions = {}): Promise<TestApp> {
  const t = await createTestApp(o);
  apps.push(t);
  return t;
}

/** Сравнить ответ со снимком `test/golden/<name>.json` (или записать его при `UPDATE_GOLDEN=1`). */
function golden(t: TestApp, name: string, dataId: string, answer: unknown): void {
  assert.deepEqual(answerIssues(dataId, answer), [], `${name}: MSX markup`);
  const file = new URL(`./${name}.json`, import.meta.url);
  const text = `${JSON.stringify(answer, null, 2)}\n`.split(t.mock.url).join(MOCK);
  if (UPDATE) {
    writeFileSync(file, text);
    return;
  }
  let want: string;
  try {
    want = readFileSync(file, "utf8");
  } catch {
    assert.fail(`no ${name}.json — record it with UPDATE_GOLDEN=1 npm test`);
  }
  assert.deepEqual(JSON.parse(text), JSON.parse(want), `${name}.json differs; if intended, UPDATE_GOLDEN=1 npm test`);
}

async function snap(name: string, dataId: string, o: TestAppOptions = { loggedIn: true }): Promise<void> {
  const t = await make(o);
  golden(t, name, dataId, await t.request(dataId));
}

describe("golden JSON of the key screens (stage 32)", () => {
  it("menu without and with login", LIMIT, async () => {
    await snap("menu-logged-out", ids.init(), {});
    await snap("menu", ids.init());
  });

  it("login: the first device code of a fresh mock", LIMIT, async () => {
    await snap("login", ids.login(), {});
  });

  it("home: every shelf (the second answer — after the first one has loaded them all)", LIMIT, async () => {
    const t = await make({ loggedIn: true });
    await t.request(ids.home());
    await t.run(sleep(t.clock, 10_000));
    golden(t, "home", ids.home(), await t.request(ids.home()));
  });

  it("«Фильмы» page 1, the card of SERIAL_BIG, its season 1", LIMIT, async () => {
    await snap("list-movies", ids.list(MOVIES));
    await snap("item-serial-big", ids.item(FIX.SERIAL_BIG));
    await snap("season-serial-big-1", ids.season(FIX.SERIAL_BIG, 1));
  });

  it("search «тест» typed on the keyboard", LIMIT, async () => {
    const t = await make({ loggedIn: true });
    await t.request(ids.search());
    for (const ch of "тест") t.app.handleData({ message: msgs.searchInput(ch) });
    await t.run(sleep(t.clock, 2_000));
    assert.equal(t.ctx.state.search.status, "ready");
    golden(t, "search-test", ids.search(), await t.request(ids.search()));
  });

  it("voice-over panel of MOVIE_AUDIO12, settings, «Диагностика»", LIMIT, async () => {
    await snap("panel-audio-movie-audio12", ids.panel("audio", FIX.MOVIE_AUDIO12, A12_MID, "c"));
    await snap("settings", ids.settings());
    await snap("probe", ids.probe());
  });

  it("v1.12: «Я смотрю», «Спорт», «Подборки», «История», the «Пункты меню» panel", LIMIT, async () => {
    await snap("watching", ids.watching());
    await snap("tv", ids.tv());
    await snap("list-collections", ids.list(encodeListKey({ src: "collections" })));
    await snap("list-history", ids.list(encodeListKey({ src: "history" })));
    await snap("panel-menu", ids.panel("menu"));
  });

  it("v1.13: the «Секции главной» panel", LIMIT, async () => {
    await snap("panel-home", ids.panel("home"));
  });

  it("v1.14: «Новинки» from the menu (the «Фильмы» tab) and its type panel", LIMIT, async () => {
    await snap("list-fresh", ids.list(encodeListKey({ src: "fresh" })));
    await snap("panel-type", ids.panel("type", encodeListKey({ src: "fresh" })));
  });

  it("error KP-NET: the network is down — «KinoPub не отвечает» after 6 s, before the retries end (V-40)", LIMIT, async () => {
    const t = await make({ loggedIn: true });
    t.mock.setScenario({ rules: [{ path: ".*", drop: true }] });
    golden(t, "error-slow", ids.item(FIX.MOVIE_SIMPLE), await t.request(ids.item(FIX.MOVIE_SIMPLE)));
  });

  it("resolve play:2001:continue", LIMIT, async () => {
    await snap("resolve-play-2001-continue", ids.playContinue(FIX.SERIAL_BIG));
  });

  // Последним: с замёрзшим `Date` FakeClock ждал бы висящий fetch вечно — этот стенд ввод-вывод не ждёт вовсе, а после
  // снимка висящие запросы обрываются; следующий стенд в этом процессе всё равно ждал бы их.
  it("error KP-NET: the network hangs — «Нет связи» from the transport after 6 s", LIMIT, async () => {
    const t = await make({ loggedIn: true });
    t.mock.setScenario({ rules: [{ path: ".*", hang: true }] });
    t.clock.ioGraceMs = 0;
    golden(t, "error-kp-net", ids.item(FIX.MOVIE_SIMPLE), await t.request(ids.item(FIX.MOVIE_SIMPLE)));
    t.mock.reset();
    await realSleep(100);
  });
});
