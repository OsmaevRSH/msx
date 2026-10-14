process.env.TZ = "UTC";

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cacheKeys } from "../../src/cache/repo.ts";
import { chain, commitMsg, contentAction } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { applyLocation, bestOf, loadRun, onCdnRun, onCdnSet, rowText } from "../../src/probe/cdn.ts";
import type { CdnRow } from "../../src/probe/cdn.ts";
import { ids, msgs } from "../../src/router/ids.ts";
import { edgeIssues, rootIssues } from "../../tools/crawl-rules.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { startMock } from "../../tools/kpmock/server.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";
import { MOVIE, kpProps, load, player } from "../progress/progress-rig.ts";

// «Скорость серверов KinoPub» (спец. §11 S12, §16.7): выбор лучшего, текст строк, экран, применение сервера
// устройства со сверкой чтением, устаревание ссылок, защита видео от теста.

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps.reverse()) await t.close();
  apps = [];
});

async function make(o: TestAppOptions = { loggedIn: true }): Promise<TestApp> {
  const t = await createTestApp(o);
  apps.push(t);
  return t;
}

const P = TEST_P;
const row = (code: string, r: Partial<CdnRow>): CdnRow => ({ code, ok: true, bytes: 0, ...r });
const full = (code: string, latencyMs: number, mbps: number): CdnRow => row(code, { acc: "full", latencyMs, mbps });
const screen = async (t: TestApp): Promise<MsxContentRoot> => (await t.request(ids.probe("cdn"))) as MsxContentRoot;
const byId = (s: MsxContentRoot, id: string): MsxContentItem => {
  const it = (s.items ?? []).find((i) => i.id === id);
  assert.ok(it, `no ${id}: ${(s.items ?? []).map((i) => i.id).join(",")}`);
  return it;
};
const deviceId = (t: TestApp): number => [...t.mock.state.devices.keys()][0] as number;
const serverLocation = (t: TestApp): number | undefined => t.mock.state.devices.get(deviceId(t))?.settings.serverLocation;
const actions = (t: TestApp): string[] => t.host.actions.map((a) => a.action);
const cdnCalls = (t: TestApp): string[] => t.mock.calls().filter((c) => c.path.startsWith("/cdn/")).map((c) => `${c.path.split("/").at(-1)}?${c.query}`);

describe("bestOf: the fastest server", () => {
  it("by speed; within 10 % — by latency; the current one among equals stays", () => {
    const rows = [full("nl", 40, 50), full("de", 20, 47), full("ru", 10, 20)];
    assert.equal(bestOf(rows), "de", "47 is within 10 % of 50 and has less latency");
    assert.equal(bestOf(rows, "nl"), "nl", "the current server is as fast — no reason to switch");
    assert.equal(bestOf(rows, "ru"), "de", "the current one is far slower");
    assert.equal(bestOf([full("nl", 40, 50), full("de", 20, 30)]), "nl");
  });

  it("without speed — by latency to the node; latency to the front host (no CORS) does not compare locations", () => {
    const node = (code: string, ms: number): CdnRow => row(code, { acc: "node", latencyMs: ms });
    assert.equal(bestOf([node("nl", 50), node("de", 30), node("ru", 32)]), "de");
    assert.equal(bestOf([node("nl", 50), node("de", 30), node("ru", 32)], "ru"), "ru", "32 ms ≈ 30 ms");
    assert.equal(bestOf([full("nl", 80, 5), node("de", 10)]), "nl", "a measured speed beats a mere latency");
    const front = (code: string, ms: number): CdnRow => row(code, { acc: "front", latencyMs: ms });
    assert.equal(bestOf([front("nl", 50), front("de", 30)]), undefined);
    assert.equal(bestOf([row("nl", { ok: false, err: "net" }), row("de", { ok: false, err: "timeout" })]), undefined);
    assert.equal(bestOf([]), undefined);
  });
});

describe("rowText: cells of a server row", () => {
  it("latency · speed · first segment; approximations and failures in words", () => {
    assert.equal(rowText(undefined), "—");
    assert.equal(rowText({ ...full("nl", 42, 38.46), segMs: 740 }), "42 мс · 38 Мбит/с · сегмент 0,7 с");
    assert.equal(rowText(full("nl", 42, 7.26)), "42 мс · 7,3 Мбит/с");
    assert.equal(rowText(row("nl", { acc: "node", latencyMs: 31 })), "≈ 31 мс · скорость не измерена");
    assert.equal(rowText(row("nl", { acc: "front", latencyMs: 120 })), "≈ 120 мс · до плейлистов");
    assert.equal(rowText(row("nl", { ok: false, err: "net" })), "нет ответа");
    assert.equal(rowText(row("nl", { ok: false, err: "timeout" })), "нет ответа за срок");
    assert.equal(rowText(row("nl", { ok: false, err: "csp" })), "хост не разрешён (CSP)");
    assert.equal(rowText(row("nl", { ok: false, err: "http-403" })), "ошибка 403");
  });
});

describe("the screen probe:cdn (S12 «Скорость серверов KinoPub»)", () => {
  it("before a run: «Проверить» in focus with time and traffic, the best disabled, a row per server, the device's one checked", async () => {
    const t = await make();
    const s = await screen(t);
    assert.deepEqual([s.type, s.flag, s.headline, s.cache], ["list", "cdn", "Скорость серверов KinoPub", false]);
    assert.deepEqual(rootIssues(s, "probe:cdn"), []);
    assert.deepEqual(edgeIssues(s, "probe:cdn"), []);
    const run = byId(s, "cdn_run");
    assert.deepEqual([run.label, run.extensionLabel, run.focus], ["Проверить", "≈ 10–30 с, до 9 МБ", true]);
    assert.equal(run.action, chain(["info:Проверка серверов: 10–30 секунд", commitMsg(msgs.act("probe", "cdnRun"))]));
    const best = byId(s, "cdn_best");
    assert.deepEqual([best.enable, best.action, best.extensionLabel], [false, undefined, "Сначала проверьте"]);
    assert.deepEqual(["cdn_nl", "cdn_de", "cdn_ru"].map((id) => [byId(s, id).label, byId(s, id).extensionLabel]), [
      ["{ico:check} Нидерланды", "—"], ["Германия", "—"], ["Россия", "—"],
    ]);
    assert.equal(byId(s, "cdn_de").action, commitMsg(msgs.act("probe", "cdnSet", "de")));
    assert.equal(cdnCalls(t).length, 0, "opening the screen does not test");
  });

  it("no locations in the reference: an explanation row (the bottom edge guard needs an item); a failed reference — S14", async () => {
    const mock = await startMock({
      port: 0, extraRoutes: (r) => r.add("GET", "/v1/references/server-location", () => ({ status: 200, json: { status: 200, items: [] } })),
    });
    try {
      const t = await make({ loggedIn: true, mock });
      const s = await screen(t);
      assert.deepEqual([byId(s, "cdn_none").label, byId(s, "cdn_none").enable], ["KinoPub не отдал список серверов", false]);
      assert.deepEqual(edgeIssues(s, "probe:cdn"), []);
      assert.equal(byId(s, "cdn_run").extensionLabel, "≈ 10–30 с, до 0 МБ");
    } finally {
      await mock.close();
    }
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/references/server-location$", status: 404 }] });
    assert.match(JSON.stringify(await screen(t)), /KP-404/);
  });

  it("the TV's own `loc` (CDN panel) is the current one", async () => {
    const t = await make();
    t.ctx.prefs.update({ loc: "ru" });
    assert.equal(byId(await screen(t), "cdn_ru").label, "{ico:check} Россия");
  });

  it("without login — the login screen of S14 (the row is not shown to a guest anyway)", async () => {
    const t = await make({});
    const s = await screen(t);
    assert.match(JSON.stringify(s), /KP-AUTH/);
    assert.match(JSON.stringify(s), new RegExp(contentAction(P, ids.login()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("run: act:probe:cdnRun", () => {
  it("in the background: «Идёт проверка…» at once, the table after; the summary as a notification; the run is kept", async () => {
    const t = await make();
    t.mock.setScenario({ cdnCors: true });
    await screen(t);
    const p = onCdnRun(t.ctx);
    const during = await screen(t);
    assert.equal(byId(during, "cdn_run").extensionLabel, "Идёт проверка…");
    assert.equal(byId(during, "cdn_run").action, "info:Проверка уже идёт");
    assert.equal(byId(during, "cdn_best").enable, false);
    await t.run(p);
    const run = loadRun(t.ctx.store);
    assert.ok(run !== undefined);
    assert.deepEqual(run.rows.map((r) => [r.code, r.ok, r.acc]), [["nl", true, "full"], ["de", true, "full"], ["ru", true, "full"]]);
    assert.equal(actions(t).at(-1), "[info:Текущий сервер — самый быстрый|reload:content]", "all equal in the mock: keep the current");
    const s = await screen(t);
    assert.match(String(byId(s, "cdn_nl").extensionLabel), /^\d+ мс · \d+ Мбит\/с · сегмент \d+,\d с$/);
    assert.match(String(byId(s, "cdn_run").extensionLabel), /^01\.01\.2026 \d\d:\d\d · 9,\d МБ за \d+,\d с$/);
    assert.equal(byId(s, "cdn_best").extensionLabel, "Текущий — самый быстрый");
    assert.equal(byId(s, "cdn_nl").label, "{ico:check} Нидерланды · самый быстрый");
  });

  it("a faster server: «Выбрать самый быстрый» names it, takes the focus and commits its code", async () => {
    const t = await make();
    t.ctx.store.set("cfg", "probe.cdn", { at: 0, ms: 9000, bytes: 9 * 1024 * 1024, rows: [full("nl", 60, 8), full("de", 20, 41.2), full("ru", 150, 2)] });
    const s = await screen(t);
    const best = byId(s, "cdn_best");
    assert.deepEqual([best.extensionLabel, best.action, best.focus, best.enable], ["Германия", commitMsg(msgs.act("probe", "cdnSet", "de")), true, undefined]);
    assert.equal(byId(s, "cdn_run").focus, undefined);
    assert.equal(byId(s, "cdn_de").label, "Германия · самый быстрый");
    assert.deepEqual(edgeIssues(s, "probe:cdn"), []);
  });

  it("no CORS anywhere: only latency to the playlist server — nothing to compare, the header says why", async () => {
    const t = await make();
    await screen(t);
    await t.run(onCdnRun(t.ctx));
    const s = await screen(t);
    assert.equal(byId(s, "cdn_nl").extensionLabel?.startsWith("≈ "), true);
    assert.equal(byId(s, "cdn_best").extensionLabel, "Без CORS не сравнить — выберите строку");
    assert.ok((s.items ?? []).some((i) => i.headline === "Серверы: ≈ задержка до плейлистов — без CORS сам CDN не виден"));
    assert.equal(actions(t).at(-1), "[info:Сравнить не удалось — см. таблицу|reload:content]");
  });

  it("a video is playing: the test does not start; a video started during the run stops it", async () => {
    const t = await make();
    load(t, kpProps(MOVIE), 0, MOVIE.duration);
    assert.ok(t.ctx.tracker.session() !== undefined, "a playback session is open");
    await t.run(onCdnRun(t.ctx));
    assert.deepEqual(actions(t), ["info:Сначала закройте видео"]);
    assert.equal(cdnCalls(t).length, 0);
    player(t, "stop", { position: 10 });
    assert.equal(t.ctx.tracker.session(), undefined);
    t.host.clearActions();
    // Видео стартует, пока меряется первая локация: остальные не меряются.
    const p = onCdnRun(t.ctx);
    const opened = (): boolean => cdnCalls(t).length > 0;
    await t.run(new Promise<void>((resolve) => {
      const tick = (): void => (opened() ? resolve() : void t.ctx.clock.setTimeout(tick, 10));
      tick();
    }));
    load(t, kpProps(MOVIE), 0, MOVIE.duration);
    await t.run(p);
    const run = loadRun(t.ctx.store);
    assert.equal(run?.stopped, "video");
    assert.deepEqual(run?.rows.map((r) => r.code), ["nl"]);
    assert.equal(actions(t).at(-1), "info:Проверка прервана: началось видео", "the screen is not current — only the notification");
  });

  it("a second press while running gets «Проверка уже идёт» and one run", async () => {
    const t = await make();
    const a = onCdnRun(t.ctx);
    await t.run(onCdnRun(t.ctx));
    await t.run(a);
    assert.ok(actions(t).includes("info:Проверка уже идёт"));
    assert.equal(cdnCalls(t).filter((c) => c.startsWith("master-")).length, 6, "3 servers × (cors + no-cors) of one run");
  });
});

describe("choice: applyLocation / act:probe:cdnSet", () => {
  it("POST serverLocation, re-read and check; stream links in the cache go stale; the TV's own loc is dropped", async () => {
    const t = await make();
    t.ctx.prefs.update({ loc: "ru" });
    const item = (await t.run(t.ctx.repo.item(FIX.MOVIE_SIMPLE))).value;
    const mid = item.videos[0]!.id;
    await t.run(t.ctx.repo.links(mid, { cls: "fg" }));
    assert.equal(t.ctx.cache.peek(cacheKeys.links(mid))?.stale, false);
    await t.run(t.ctx.repo.serverLocations());
    await t.run(t.ctx.repo.deviceInfo());
    const before = t.mock.calls().length;
    const l = await t.run(applyLocation(t.ctx, "de"));
    assert.deepEqual([l.id, l.location], [2, "de"]);
    assert.equal(serverLocation(t), 2, "the device setting changed in the mock");
    const calls = t.mock.calls().slice(before).map((c) => `${c.method} ${c.path.replace(/\/\d+\//, "/N/")} ${new URLSearchParams(c.query).has("access_token")}`);
    assert.deepEqual(calls, ["POST /v1/device/N/settings true", "GET /v1/device/info true"], "POST, then a fresh re-read");
    assert.equal(t.ctx.cache.peek(cacheKeys.links(mid))?.stale, true, "stream links are stale");
    assert.equal(t.ctx.prefs.get().loc, undefined, "the TV override would hide the choice");
    const again = t.mock.calls().length;
    await t.run(t.ctx.repo.links(mid, { cls: "fg" }));
    assert.equal(t.mock.calls().slice(again).filter((c) => c.path === "/v1/items/media-links").length, 1, "fresh links are fetched");
  });

  it("the device setting did not change (re-read differs) → error, nothing else changes", async () => {
    const t = await make();
    t.ctx.prefs.update({ loc: "ru" });
    t.mock.setScenario({ rules: [{ path: "^/v1/device/\\d+/settings$", method: "POST", status: 200 }] });
    await assert.rejects(t.run(applyLocation(t.ctx, "de")), /device-settings-mismatch/);
    assert.equal(serverLocation(t), undefined);
    assert.equal(t.ctx.prefs.get().loc, "ru");
  });

  it("the message: a notification, the open screen redrawn with the new check mark; a bad code is ignored", async () => {
    const t = await make();
    await screen(t);
    await t.run(onCdnSet(t.ctx, "de"));
    assert.deepEqual(actions(t), ["[info:CDN-сервер: Германия|reload:content]"]);
    assert.equal(byId(await screen(t), "cdn_de").label, "{ico:check} Германия");
    t.host.clearActions();
    await t.run(onCdnSet(t.ctx, "x:y"));
    assert.deepEqual(actions(t), [], "not a location code: ignored");
    await t.run(onCdnSet(t.ctx, "zz"));
    assert.deepEqual(actions(t), ["[info:Сервер не сменён: KP-BAD|reload:content]"], "not in references/server-location");
    assert.equal(serverLocation(t), 2);
  });

  it("the same server as the device's: no POST", async () => {
    const t = await make();
    await t.run(t.ctx.repo.serverLocations());
    await t.run(t.ctx.repo.deviceInfo());
    const before = t.mock.calls().length;
    await t.run(applyLocation(t.ctx, "nl"));
    assert.deepEqual(t.mock.calls().slice(before), []);
  });
});
