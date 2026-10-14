import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FetchLike } from "../../src/api/transport.ts";
import type { MsxContentRoot } from "../../src/msx/types.ts";
import { loadRun } from "../../src/probe/cdn.ts";
import { ids } from "../../src/router/ids.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";
import { actions, commit, follow, pick, until } from "./rig.ts";

// Тест скорости CDN против kpmock (спец. §16.7, §14.3) только по действиям из ответов: «Настройки» → «Скорость серверов
// KinoPub» → «Проверить» → таблица → строка сервера → настройка устройства в mock. Сеть настоящая (HTTP к mock за
// эмулятором CORS): плейлисты и сегменты с `?loc=` каждой локации, лимит байт, темп запросов, ступени точности.

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

const MB = 1024 * 1024;
const CDN = /^\/cdn\//;

/** Старты запросов к CDN по поддельным часам: `ctx.fetch` берёт только пробник, API ходит через транспорт. */
function recordStarts(t: TestApp): { url: string; at: number }[] {
  const starts: { url: string; at: number }[] = [];
  const orig = t.ctx.fetch;
  const wrapped: FetchLike = (url, init) => {
    if (CDN.test(new URL(url).pathname)) starts.push({ url, at: t.clock.perf() });
    return orig(url, init);
  };
  t.ctx.fetch = wrapped;
  return starts;
}

async function openTest(t: TestApp): Promise<MsxContentRoot> {
  const settings = (await t.request(ids.settings())) as MsxContentRoot;
  const row = pick(settings.items, (i) => i.id === "s_cdn", "row «Скорость серверов KinoPub»");
  assert.equal(row.label, "Скорость серверов KinoPub");
  const id = follow(row.action, "content");
  assert.equal(id, ids.probe("cdn"));
  return (await t.request(id)) as MsxContentRoot;
}

async function check(t: TestApp, s: MsxContentRoot): Promise<MsxContentRoot> {
  const run = pick(s.items, (i) => i.id === "cdn_run", "«Проверить»");
  const [info, msg] = (run.action ?? "").slice(1, -1).split("|");
  assert.match(info ?? "", /^info:/);
  commit(t, msg);
  await t.run(until(() => actions(t).some((a) => a.includes("reload:content") && a.startsWith("[info:"))));
  return (await t.request(ids.probe("cdn"))) as MsxContentRoot;
}

describe("CDN speed test against kpmock (§16.7)", () => {
  it("CDN with CORS: each location by its `loc`, ≤ 3 MB each, one request at a time ≥ 200 ms apart; a row choice changes the device", async () => {
    const t = await createTestApp({ loggedIn: true });
    apps.push(t);
    t.mock.setScenario({ cdnCors: true });
    const starts = recordStarts(t);
    const before = await openTest(t);
    assert.equal(pick(before.items, (i) => i.id === "cdn_nl", "row nl").extensionLabel, "—");
    const c0 = t.mock.calls().length;

    const after = await check(t, before);
    const calls = t.mock.calls().slice(c0);
    const cdn = calls.filter((c) => CDN.test(c.path));
    const locs = cdn.map((c) => new URLSearchParams(c.query).get("loc"));
    assert.deepEqual(locs, ["nl", "nl", "nl", "nl", "de", "de", "de", "de", "ru", "ru", "ru", "ru"], "one location after another");
    assert.deepEqual(cdn.slice(0, 4).map((c) => c.path.split("/").at(-1)), ["master-v1a1.m3u8", "index-v1a1.m3u8", "seg-1-v1-a1.ts", "seg-2-v1-a1.ts"]);
    assert.ok(cdn.every((c) => c.status === 200));
    assert.ok(calls.filter((c) => c.path.startsWith("/v1/")).length <= 4, "API: the shelf, the title, its links — through the limiter");
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i]!.at - starts[i - 1]!.at >= 200, `CDN start ${i} too soon`);

    const run = loadRun(t.ctx.store);
    assert.ok(run !== undefined);
    for (const r of run.rows) {
      assert.deepEqual([r.ok, r.acc, r.host], [true, "full", "127.0.0.1"], r.code);
      assert.ok(r.bytes > 2 * MB && r.bytes <= 3 * MB + 64 * 1024, `${r.code}: ${r.bytes} B`);
      assert.ok(r.segMs !== undefined, `${r.code}: the first 2 MB segment is read whole`);
    }
    assert.equal(run.bytes, run.rows.reduce((n, r) => n + r.bytes, 0));
    const de = pick(after.items, (i) => i.id === "cdn_de", "row de");
    assert.match(String(de.extensionLabel), /мс · \d+ Мбит\/с · сегмент/);

    t.host.clearActions();
    commit(t, de.action);
    await t.run(until(() => actions(t).length > 0));
    assert.deepEqual(actions(t), ["[info:CDN-сервер: Германия|reload:content]"]);
    const dev = t.mock.state.devices.get([...t.mock.state.devices.keys()][0] as number);
    assert.equal(dev?.settings.serverLocation, 2, "the device setting changed in the mock");
    const reread = t.mock.calls().filter((c) => c.path === "/v1/device/info").length;
    assert.ok(reread >= 2, "the device was read again after the POST");
    const shown = (await t.request(ids.probe("cdn"))) as MsxContentRoot;
    assert.equal(pick(shown.items, (i) => i.id === "cdn_de", "row de").label?.startsWith("{ico:check} Германия"), true);
  });

  it("CDN without CORS (the default of the mock): only the time to the opaque master answer, no segments, nothing to compare", async () => {
    const t = await createTestApp({ loggedIn: true });
    apps.push(t);
    const c0 = t.mock.calls().length;
    const after = await check(t, await openTest(t));
    const cdn = t.mock.calls().slice(c0).filter((c) => CDN.test(c.path));
    assert.deepEqual(cdn.map((c) => c.path.split("/").at(-1)), Array(6).fill("master-v1a1.m3u8"), "cors and no-cors of each master");
    const run = loadRun(t.ctx.store);
    assert.deepEqual(run?.rows.map((r) => [r.code, r.acc, r.bytes]), [["nl", "front", 0], ["de", "front", 0], ["ru", "front", 0]]);
    assert.equal(pick(after.items, (i) => i.id === "cdn_best", "best").enable, false);
    assert.match(String(pick(after.items, (i) => i.id === "cdn_ru", "row ru").extensionLabel), /^≈ \d+ мс · до плейлистов$/);
  });
});
