import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { ids } from "../../src/router/ids.ts";
import { CHANNELS } from "../../tools/kpmock/fixtures.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";
import { player } from "../progress/progress-rig.ts";

// «Спорт» S16 (спец. §11, v1.11): каналы эфира `/v1/tv`, запуск `video:<stream>` без resolve и без прогресса.

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(): Promise<TestApp> {
  const t = await createTestApp({ loggedIn: true });
  apps.push(t);
  return t;
}

const screen = async (t: TestApp): Promise<MsxContentRoot> => (await t.request(ids.tv())) as MsxContentRoot;
const tiles = (s: MsxContentRoot): MsxContentItem[] => s.items ?? [];

describe("tvScreen «Спорт» (S16)", () => {
  it("channels as 3×2 tiles (4 in a row): logo, name, «Эфир»; the tile plays the live stream directly", async () => {
    const t = await make();
    const s = await screen(t);
    assert.equal(s.type, "list");
    assert.equal(s.flag, "tv");
    assert.equal(s.headline, "Спорт");
    assert.equal(s.extension, "Эфир · 6 каналов");
    assert.equal(s.template?.layout, "0,0,3,2");
    assert.equal(s.template?.badgeColor, "msx-red");
    assert.equal(tiles(s).length, CHANNELS.length);
    const first = tiles(s)[0];
    assert.equal(first?.focus, true);
    assert.equal(first?.titleHeader, "Тестовый спорт 1");
    assert.equal(first?.playerLabel, "Тестовый спорт 1");
    assert.equal(first?.badge, "Эфир");
    assert.equal(first?.image, `${t.mock.url}/poster/logo/1.svg`);
    assert.equal(first?.action, `video:${t.mock.url}/cdn/tv/sport1/playlist.m3u8`);
    assert.ok(s.inserts !== undefined, "edge guards");
    assert.deepEqual(t.mock.calls().map((c) => c.path), ["/v1/tv"]);
  });

  it("the live stream is an HLS playlist without #EXT-X-ENDLIST", async () => {
    const t = await make();
    const url = (tiles(await screen(t))[0]?.action ?? "").slice("video:".length);
    const text = await (await fetch(url)).text();
    assert.match(text, /^#EXTM3U/);
    assert.match(text, /#EXT-X-MEDIA-SEQUENCE:\d+/);
    assert.doesNotMatch(text, /ENDLIST/);
  });

  it("playing a channel is not a viewing: no kp:* → no session, no marktime, no redraw after stop", async () => {
    const t = await make();
    const s = await screen(t);
    t.ctx.current.onRequest(ids.tv());
    const url = (tiles(s)[0]?.action ?? "").slice("video:".length);
    t.app.handleEvent({ event: "video:load", info: { id: "tv1", url, label: "Тестовый спорт 1", properties: {} }, data: { state: 0, position: 0, duration: 0 } });
    player(t, "play", { position: 0, duration: 0 });
    t.app.handleData({ video: { info: { properties: {} }, data: { position: 600, duration: 0 } } });
    player(t, "stop", { position: 900, duration: 0 });
    await realSleep(30);
    assert.equal(t.ctx.tracker.session(), undefined);
    assert.ok(t.ctx.log.entries().some((e) => e.msg === "load_without_kp"));
    assert.deepEqual(t.mock.calls().filter((c) => c.path.startsWith("/v1/watching")), []);
    assert.deepEqual(t.host.actions, []);
  });

  it("the channel list is kept in L1 only: stream addresses may be signed", async () => {
    const t = await make();
    await screen(t);
    t.ctx.l2.flush();
    assert.deepEqual(t.ctx.store.keys("l2").filter((k) => k.includes("tv")), []);
    const n = t.mock.calls().length;
    await screen(t);
    assert.equal(t.mock.calls().length, n, "a repeat within 2 min — from L1");
  });

  it("no broadcasts: a text and «Обновить»; KinoPub fails — the error screen", async () => {
    const t = await make();
    t.ctx.api.tv = async () => [];
    const s = await screen(t);
    assert.equal(s.items, undefined);
    assert.deepEqual((s.pages?.[0]?.items ?? []).map((i) => i.type), ["space", "button"]);
    assert.equal(s.pages?.[0]?.items[1]?.action, "[invalidate:content|reload:content]");

    const u = await make();
    u.mock.setScenario({ rules: [{ path: "^/v1/tv$", status: 404, times: 5 }] });
    const e = await screen(u);
    assert.match(JSON.stringify(e), /KP-404/);
  });

  it("the action of a tile goes through the router like MSX would: «Спорт» in the menu leads here", async () => {
    const t = await make();
    const menu = (await t.request(ids.init())) as { menu: { id?: string; data?: string }[] };
    assert.equal(menu.menu.find((i) => i.id === "sport")?.data, `request:interaction:tv@${TEST_P}`);
  });
});
