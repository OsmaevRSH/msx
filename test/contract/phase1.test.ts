import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MsxContentItem, MsxContentRoot, MsxMenuRoot, MsxResolveResponse } from "../../src/msx/types.ts";
import type { TrackerEvent } from "../../src/progress/tracker.ts";
import { encodeListKey, ids } from "../../src/router/ids.ts";
import { ROW } from "../../src/screens/tiles.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { startMock } from "../../tools/kpmock/server.ts";
import type { MockServer } from "../../tools/kpmock/server.ts";
import { FakeClock } from "../helpers/fake-clock.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";
import { apiCalls, load, marktimes, player, recordEvents, snapshot, toggles, waitFor, watchingReads } from "../progress/progress-rig.ts";
import {
  CHAIN_DONE, actions, assertCleanTraffic, assertLogClean, bytes, commit, follow, menuItem, message, pageItems, pick, until,
} from "./rig.ts";

// Контрольная точка M1 (план §0.8, этап 29): сценарий «смотрю кино» целиком против kpmock за эмулятором CORS —
// вход по коду → меню → «Сериалы» с догрузкой → карточка → «Продолжить» → события плеера → marktime →
// «просмотрено» ≥ 90 % → перерисовка → автопереход → outbox через перезапуск. Шаги идут по порядку на одном
// хранилище и одном mock; каждый следующий dataId берётся из действия предыдущего ответа, как это сделал бы MSX.

const SERIALS = encodeListKey({ src: "catalog", type: "serial", sort: "-updated" });
const SMALL = FIX.SERIAL_SMALL;
/** `SERIAL_SMALL`: 2 сезона по 3 серии по 60 с; mid = id × 1000 + порядковый номер; S1E1 в mock уже просмотрена. */
const mid = (season: number, episode: number): number => SMALL * 1000 + (season - 1) * 3 + episode;
const DURATION = 60;
const WINDOW = 96;
const STEP = 48;

const watchedResults = (ev: TrackerEvent[]): string[] =>
  ev.flatMap((e) => (e.kind === "watched" ? [e.result] : []));

describe("Phase 1 «Смотрю кино» end to end (M1)", () => {
  const storage = new MemoryStorage();
  let mock: MockServer;
  let a: TestApp;
  let b: TestApp | undefined;
  let userCode = "";
  /** Ответ resolve S2E1 после автоперехода (шаг 4) — вход шага 6. */
  let s2e1: MsxResolveResponse | undefined;

  before(async () => {
    mock = await startMock({ port: 0 });
    a = await createTestApp({ mock, storage });
  });

  after(async () => {
    await a.close();
    await b?.close();
    await mock.close();
  });

  it("1. init without login → «Вход» → code → two pending polls → replace:menu → full menu (CC-02, CAC-01, CAC-02)", async () => {
    mock.setScenario({ pendingPolls: 2 });
    a.app.ready();
    const guest = (await a.request("init")) as MsxMenuRoot;
    assert.deepEqual(guest.menu.map((m) => m.id), ["login", "probe", "msx_settings"]);

    const loginId = follow(menuItem(guest, "login").data, "");
    const screen = (await a.request(loginId)) as MsxContentRoot;
    // Код нарисован картинкой SVG (V-01): текст из `<text>` её `data:`-адреса.
    const image = decodeURIComponent(pick(pageItems(screen), (i) => i.id === "login_code", "login code").image ?? "");
    userCode = /<text[^>]*>([^<]*)<\/text>/.exec(image)?.[1] ?? "";
    assert.match(userCode, /^[A-Z]{6}$/);
    assert.deepEqual([...mock.state.deviceCodes.values()].map((r) => r.userCode), [userCode]);
    assert.equal(a.ctx.current.get(), "login");

    await a.run(until(() => actions(a).includes(CHAIN_DONE)));
    assert.ok(a.ctx.auth.isLoggedIn());
    assert.equal(apiCalls(a, "/oauth2/device").length, 4, "one code request and three polls (two pending)");
    assert.ok(storage.getItem("kp.auth.pair") !== null, "the pair is stored");
    await a.run(until(() => apiCalls(a, "/v1/device/notify").length > 0));

    const menu = (await a.request("init")) as MsxMenuRoot;
    assert.deepEqual(menu.menu.slice(0, 2).map((m) => m.id), ["home", "search"]);
    assert.equal(follow(menuItem(menu, "serials").data, ""), ids.list(SERIALS));
  });

  it("2. «Сериалы» → extend (window ≤ 96, shift 48, ≤ 32 KB) → SERIAL_SMALL found by following live edges (CC-05)", async () => {
    const menu = (await a.request("init")) as MsxMenuRoot;
    const listId = follow(menuItem(menu, "serials").data, "");
    let list = (await a.request(listId)) as MsxContentRoot;
    assert.equal(list.items?.length, STEP);
    /** Окно [from, to) по live-краям: `extend:<ключ>:up:<from>` у первой плитки, `…:down:<to>` у последней. */
    const edges = (r: MsxContentRoot): { from: number; to: number | undefined; last: string } => {
      const items = r.items ?? [];
      const up = items[0]?.live?.action;
      const down = items.at(-1)?.live?.action;
      return {
        from: up === undefined ? 0 : Number(/:up:(\d+)$/.exec(message(up))?.[1]),
        to: down === undefined ? undefined : Number(/:down:(\d+)$/.exec(message(down))?.[1]),
        last: String(items.at(-1)?.kid),
      };
    };

    let tile: MsxContentItem | undefined;
    for (let n = 0; (tile = list.items?.find((i) => i.kid === String(SMALL))) === undefined; n++) {
      assert.ok(n < 4, "SERIAL_SMALL is on the last page of 152 serials");
      const prev = edges(list);
      const live: MsxContentItem["live"] = list.items?.at(-1)?.live;
      assert.equal(live?.type, "setup");
      assert.equal(message(live?.action), `extend:${SERIALS}:down:${prev.to}`);
      a.host.clearActions();
      commit(a, live?.action);
      await a.run(until(() => actions(a).includes("reload:content")));
      list = (await a.request(listId)) as MsxContentRoot;

      const w = edges(list);
      const size = list.items?.length ?? 0;
      assert.ok(size <= WINDOW, `window of ${size} tiles`);
      assert.ok(bytes(list) <= 32 * 1024, `list response of ${bytes(list)} bytes`);
      assert.equal(w.from % ROW, 0, "the window starts at a row of tiles (a MSX page)");
      assert.ok((w.to ?? w.from + size) - (prev.to ?? 0) <= STEP, "the window moves by ≤ 48");
      assert.ok(list.items?.some((i) => String(i.kid) === prev.last), "the focused edge tile stays in the window");
    }
    assert.ok(edges(list).from > 0, "the window has moved down");
    assert.equal(list.items?.at(-1)?.kid, String(SMALL), "SERIAL_SMALL is the oldest serial");
    assert.equal(list.items?.at(-1)?.live, undefined, "the end of the list has no live edge");
    assert.equal(follow(tile.action, "content"), ids.item(SMALL));
  });

  it("3. focus prefetch → card from cache → «Продолжить» S1E2 → load/play/30/40/55 s/Back/stop → marktime, ✓ once, redraw (CC-07, CC-09, CC-11, CC-12, CAC-10, CAC-16)", async () => {
    // Фокус на плитке ≥ 350 мс: `selection` шаблона шлёт `pf:{context:kid}` (спец. §8.3); карточка открывается без сети.
    a.app.handleData({ message: `pf:${SMALL}` });
    await a.run(until(() => apiCalls(a, `/v1/items/${SMALL}`).length === 1 && a.ctx.repo.peekItem(SMALL) !== undefined));
    const card = (await a.request(ids.item(SMALL))) as MsxContentRoot;
    assert.equal(apiCalls(a, `/v1/items/${SMALL}`).length, 1, "the card comes from the focus prefetch");
    assert.equal(card.flag, `item_${SMALL}`);
    const main = pick(pageItems(card), (i) => i.id === "b_main", "main button");
    assert.equal(main.label, "▶ Смотреть: 1 сезон, 2 серия", "S1E1 is watched in the mock → the next episode from the start");

    const playId = follow(main.action, "video:resolve");
    assert.equal(playId, ids.playContinue(SMALL));
    const res = (await a.request(playId)) as MsxResolveResponse;
    assert.equal(res.error, undefined);
    assert.match(res.url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/.+\.m3u8/);
    assert.match(res.label ?? "", /· 1 сезон, 2 серия$/);
    const props = res.properties ?? {};
    assert.deepEqual(
      [props["kp:i"], props["kp:m"], props["kp:s"], props["kp:e"], props["kp:d"], props["kp:n"], props["resume:position"]],
      [String(SMALL), String(mid(1, 2)), "1", "2", String(DURATION), "1", "none"],
    );
    assert.equal(a.ctx.current.get(), ids.item(SMALL), "resolve does not change the current screen");

    const ev = recordEvents(a);
    const before = marktimes(a).length;
    load(a, props, 0, DURATION);
    player(a, "play", { state: 1, position: 0, duration: DURATION });
    assert.equal(a.ctx.tracker.session()?.mid, mid(1, 2));
    for (const pos of [30, 40]) {
      snapshot(a, pos, props, DURATION);
      await waitFor(a, () => marktimes(a).length > before && marktimes(a).at(-1)?.time === pos, `marktime ${pos}`);
    }
    assert.equal(toggles(a).length, 0, "no «просмотрено» before 90 % (40 of 60 s)");

    snapshot(a, 55, props, DURATION);
    await waitFor(a, () => watchedResults(ev).length === 1 && marktimes(a).at(-1)?.time === 55, "watched at 55 of 60 s");
    assert.deepEqual(watchedResults(ev), ["done"]);
    assert.equal(toggles(a).length, 1);
    assert.ok(watchingReads(a).length >= 1, "status check before the toggle (Р-20)");

    // Back: снимок до `eject`, `video:stop` после него приходит без позиции (Plan B M-02).
    snapshot(a, 56, props, DURATION);
    player(a, "stop");
    await waitFor(a, () => marktimes(a).at(-1)?.time === 56, "marktime from the Back snapshot");
    assert.deepEqual(
      marktimes(a).slice(before),
      [30, 40, 55, 56].map((time) => ({ id: SMALL, video: 2, season: 1, time })),
    );
    assert.equal(mock.state.watching.get(`${SMALL}:1:2`)?.status, 1);
    assert.equal(mock.state.watching.get(`${SMALL}:1:2`)?.time, 56);
    assert.equal(toggles(a).length, 1, "«просмотрено» once per episode");

    // После `stop` экран под плеером — карточка: фокус на «▶» (V-16), затем замена своим флагом (спец. §6.3).
    const replace = `replace:content:item_${SMALL}:request:interaction:${ids.item(SMALL)}@${TEST_P}`;
    await a.run(until(() => actions(a).includes(replace)));
    assert.ok(actions(a).indexOf("focus:b_main") >= 0 && actions(a).indexOf("focus:b_main") < actions(a).indexOf(replace));
    const redrawn = (await a.request(ids.item(SMALL))) as MsxContentRoot;
    assert.equal(pick(pageItems(redrawn), (i) => i.id === "b_main", "main button").label, "▶ Смотреть: 1 сезон, 3 серия");
  });

  it("4. «Сезоны» → ✓ on S1E2 → S1E3 → button:next crosses into S2E1, trigger:complete presses it (CC-08, CAC-16, CAC-17)", async () => {
    const card = (await a.request(ids.item(SMALL))) as MsxContentRoot;
    const seasons = pick(pageItems(card), (i) => i.id === "b_second", "«Сезоны»");
    const seasonId = follow(seasons.action, "content");
    assert.equal(seasonId, ids.season(SMALL, 1));
    const season = (await a.request(seasonId)) as MsxContentRoot;
    assert.equal(season.flag, `ep_${SMALL}_1`);
    assert.equal(pick(season.items, (i) => i.id === `e${mid(1, 2)}`, "S1E2").badge, "✓");
    const focused = pick(season.items, (i) => i.focus === true, "focused episode");
    assert.equal(focused.id, `e${mid(1, 3)}`);

    const s1e3 = (await a.request(follow(focused.action, "video:resolve"))) as MsxResolveResponse;
    const p3 = s1e3.properties ?? {};
    assert.equal(p3["kp:m"], String(mid(1, 3)));
    assert.equal(p3["kp:n"], "1");
    assert.equal(p3["trigger:complete"], "player:button:next:execute");
    const nextId = follow(p3["button:next:action"], "video:resolve");
    assert.equal(nextId, ids.playEp(SMALL, mid(2, 1), 2, 1));
    assert.equal(follow(p3["button:prev:action"], "video:resolve"), ids.playEp(SMALL, mid(1, 2), 1, 2));

    s2e1 = (await a.request(nextId)) as MsxResolveResponse;
    assert.equal(s2e1.error, undefined);
    assert.match(s2e1.label ?? "", /· 2 сезон, 1 серия$/);
    const p = s2e1.properties ?? {};
    assert.deepEqual([p["kp:m"], p["kp:s"], p["kp:e"], p["kp:n"]], [String(mid(2, 1)), "2", "1", "1"]);
    assert.equal(follow(p["button:prev:action"], "video:resolve"), ids.playEp(SMALL, mid(1, 3), 1, 3), "back across the season boundary");
    assert.equal(a.ctx.current.get(), seasonId);
  });

  it("5. audio chosen in the panel before the start plays and is named in label:extension (CAC-11)", async () => {
    const id = FIX.MOVIE_AUDIO12;
    const card = (await a.request(ids.item(id))) as MsxContentRoot;
    const audio = pick(pageItems(card), (i) => i.id === "b_audio", "«Озвучка»");
    const panel = (await a.request(follow(audio.action, "panel"))) as MsxContentRoot;
    assert.ok((panel.items?.length ?? 0) >= 5, "a title with ≥ 5 audio tracks");
    const row = pick(panel.items, (i) => (i.label ?? "").includes("Студия Гамма"), "audio row «Студия Гамма»");
    a.host.clearActions();
    commit(a, row.action);
    await a.run(until(() => actions(a).includes("[back|reload:content]")));

    const again = (await a.request(ids.item(id))) as MsxContentRoot;
    assert.equal(pick(pageItems(again), (i) => i.id === "b_audio", "«Озвучка»").label, "{ico:record-voice-over} Студия Гамма");
    const res = (await a.request(follow(pick(pageItems(again), (i) => i.id === "b_main", "main").action, "video:resolve"))) as MsxResolveResponse;
    assert.match(res.url ?? "", /master-v1a7\.m3u8/, "track 7 is «Студия Гамма» (AUDIO12 fixture)");
    assert.match(res.properties?.["label:extension"] ?? "", /Студия Гамма/);
  });

  it("6. VPN down: pause → marktime retried, then queued in kp.out.* → plugin restart on the same storage → ready() → delivered (CC-10, CAC-02, CAC-15)", async () => {
    const props = s2e1?.properties ?? {};
    const ev = recordEvents(a);
    load(a, props, 0, DURATION);
    player(a, "play", { state: 1, position: 0, duration: DURATION });
    await waitFor(a, () => ev.some((e) => e.kind === "started"), "started");

    mock.setScenario({ rules: [{ path: "^/v1/", drop: true }] });
    player(a, "pause", { state: 2, position: 45, duration: DURATION });
    await waitFor(a, () => a.ctx.outbox.size() === 1, "marktime queued", 60_000, 200);
    const key = `kp.out.m_${SMALL}_2_1`;
    assert.equal((JSON.parse(storage.getItem(key) ?? "{}") as { time?: number }).time, 45);
    const dropped = apiCalls(a, "/v1/watching/marktime").filter((c) => new URLSearchParams(c.query).get("season") === "2");
    assert.equal(dropped.length, 3, "auto retries 3 s and 6 s (marktime is absolute, CM-01)");
    assert.ok(dropped.every((c) => c.status === 0));
    assert.equal(mock.state.watching.get(`${SMALL}:2:1`), undefined);

    // «Перезапуск плагина»: новый iframe на том же localStorage; связь вернулась.
    mock.setScenario({ rules: [] });
    b = await createTestApp({ mock, storage, clock: new FakeClock(a.clock.now() + 60_000) });
    const restart = b;
    restart.app.ready();
    const menu = (await restart.request("init")) as MsxMenuRoot;
    assert.equal(menu.menu[0]?.id, "home", "the restart opens the menu without a new login");
    await waitFor(restart, () => restart.ctx.outbox.size() === 0, "outbox delivered after ready");
    assert.equal(storage.getItem(key), null);
    assert.deepEqual(marktimes(restart).at(-1), { id: SMALL, video: 1, season: 2, time: 45 });
    const rec = mock.state.watching.get(`${SMALL}:2:1`);
    assert.deepEqual([rec?.time, rec?.status], [45, 0]);

    // CAC-13: позиция «другого устройства» (MOVIE_SIMPLE 20:00 в mock) → «Продолжить» за 3 с до неё.
    const card = (await restart.request(ids.item(FIX.MOVIE_SIMPLE))) as MsxContentRoot;
    const main = pick(pageItems(card), (i) => i.id === "b_main", "main button");
    assert.equal(main.label, "▶ Продолжить с 19:57");
    const res = (await restart.request(follow(main.action, "video:resolve"))) as MsxResolveResponse;
    assert.equal(res.properties?.["resume:position"], "1197");
  });

  it("7. the whole run: 0 OPTIONS, no Authorization, form-only bodies, no-cors probes only GET /v1/types?access_token=x (CC-01, CNFR-19, CM-01)", () => {
    assert.ok(b, "step 6 ran");
    const calls = mock.calls();
    assert.ok(calls.length > 20, `${calls.length} calls in the run`);
    assertCleanTraffic(calls, [a, b]);
  });

  it("8. the plugin log has no tokens, no login codes and no user_code (CNFR-20)", () => {
    assert.ok(b, "step 6 ran");
    assert.notEqual(userCode, "");
    for (const t of [a, b]) {
      assert.ok(t.ctx.log.entries().length > 0);
      assertLogClean(t, [userCode]);
    }
    // Журнал в L2 (`kp.l2.log`) и прочие пространства, кроме `kp.auth.*`, тоже без токенов.
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i) ?? "";
      if (k.startsWith("kp.auth.")) continue;
      const v = storage.getItem(k) ?? "";
      for (const s of ["mock-at-", "mock-rt-", userCode]) assert.ok(!v.includes(s), `${k} contains ${s}`);
    }
  });
});
