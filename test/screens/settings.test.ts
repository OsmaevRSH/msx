import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fmtDate } from "../../src/core/format.ts";
import { commitMsg, contentAction, panelAction } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { ids, msgs } from "../../src/router/ids.ts";
import { onSettingsAct } from "../../src/screens/settings.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

const P = TEST_P;
const CHECK = "{ico:check} ";
const BACK_RELOAD = "[back|reload:content]";
const FORM = "application/x-www-form-urlencoded";

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

const screen = async (t: TestApp): Promise<MsxContentRoot> => (await t.request(ids.settings())) as MsxContentRoot;
const panel = async (t: TestApp, key: string): Promise<MsxContentRoot> => (await t.request(ids.panel("setting", key))) as MsxContentRoot;
const row = (s: MsxContentRoot, key: string): MsxContentItem => {
  const found = (s.items ?? []).find((i) => i.id === `s_${key}`);
  assert.ok(found, `no row ${key}`);
  return found;
};
const ext = (s: MsxContentRoot, key: string): string | undefined => row(s, key).extensionLabel;
const labels = (s: MsxContentRoot): (string | undefined)[] => (s.items ?? []).map((i) => i.label);
const act = (t: TestApp, name: string, ...args: (string | number)[]): Promise<void> =>
  t.run(onSettingsAct(t.ctx, name, args.map(String)));
const actions = (t: TestApp): string[] => t.host.actions.map((a) => a.action);
const deviceId = (t: TestApp): number => [...t.mock.state.devices.keys()][0] as number;
const device = (t: TestApp): Record<string, number> => t.mock.state.devices.get(deviceId(t))?.settings ?? {};

describe("settingsScreen (S12)", () => {
  it("12×6 list of 12×1 control rows with group headers, flag «settings», not cached", async () => {
    const t = await make();
    const s = await screen(t);
    assert.equal(s.type, "list");
    assert.equal(s.flag, "settings");
    assert.equal(s.cache, false);
    assert.equal(s.compress, undefined);
    assert.deepEqual(s.template, { type: "control", layout: "0,0,12,1" });
    const groups = (s.items ?? []).filter((i) => i.type === "space");
    assert.deepEqual(groups.map((g) => g.headline), ["Воспроизведение", "Это устройство KinoPub", "Аккаунт", "Для опытных", "Диагностика"]);
    for (const g of groups) assert.equal(g.layout, "0,0,12,1");
  });

  it("every row of the S12 table shows the current value: defaults, 4K and HEVC off", async () => {
    const t = await make();
    const s = await screen(t);
    const want: Record<string, string> = {
      quality: "1080p", mode: "Авто", loc: "По умолчанию", audioLang: "Русский", audioType: "Любой", authors: "нет",
      ac3: "нет", subs: "Выключены", hevc: "выкл", uhd: "выкл", device: "kpmock TV",
      bufferInit: "4 с", bufferResume: "6 с", posterSize: "Средние", cardBackgrounds: "выкл",
    };
    for (const [k, v] of Object.entries(want)) assert.equal(ext(s, k), v, k);
  });

  it("rows open their panels; CDN — the S10 location panel; «Диагностика» — the probe; the device name is display only", async () => {
    const t = await make();
    const s = await screen(t);
    assert.equal(row(s, "quality").action, panelAction(P, ids.panel("setting", "quality")));
    assert.equal(row(s, "account").action, panelAction(P, ids.panel("setting", "account")));
    assert.equal(row(s, "loc").action, panelAction(P, ids.panel("loc")));
    assert.equal(row(s, "probe").action, contentAction(P, ids.probe()));
    assert.equal(row(s, "device").enable, false);
    assert.equal(row(s, "device").action, undefined);
  });

  it("account row: subscription end date and days left", async () => {
    const t = await make();
    const u = await t.run(t.ctx.api.user());
    const s = await screen(t);
    assert.equal(ext(s, "account"), `до ${fmtDate(u.subscription.endTime)}, осталось 30 дн.`);
  });

  it("stored choices are shown: 720p, HLS2, CDN name, voice type, studios count, subtitles", async () => {
    const t = await make();
    t.ctx.prefs.update({ maxQuality: 720, streamMode: "hls2", loc: "de", audioType: 2, audioAuthors: [11, 12], subsLang: "eng", allowAc3: true });
    const s = await screen(t);
    assert.equal(ext(s, "quality"), "720p");
    assert.equal(ext(s, "mode"), "HLS2");
    assert.equal(ext(s, "loc"), "Germany");
    assert.equal(ext(s, "audioType"), "Многоголосый");
    assert.equal(ext(s, "authors"), "2");
    assert.equal(ext(s, "subs"), "ENG");
    assert.equal(ext(s, "ac3"), "да");
  });

  it("device info unavailable — the screen still opens, device rows show a dash", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/device/info$", status: 404 }] });
    const s = await screen(t);
    assert.equal(ext(s, "quality"), "1080p");
    assert.equal(ext(s, "hevc"), "—");
    assert.equal(ext(s, "uhd"), "—");
    assert.equal(ext(s, "device"), "—");
  });
});

describe("settingPanel", () => {
  it("quality: four ceilings, the current one checked, a choice commits act:set:quality:<q>", async () => {
    const t = await make();
    const s = await panel(t, "quality");
    assert.equal(s.headline, "Качество (потолок)");
    assert.deepEqual(labels(s), ["2160p", `${CHECK}1080p`, "720p", "480p"]);
    assert.equal(s.items?.[2]?.action, commitMsg(msgs.act("set", "quality", 720)));
  });

  it("stream mode: Авто, HLS1, HLS2", async () => {
    const t = await make();
    const s = await panel(t, "mode");
    assert.deepEqual(labels(s), [`${CHECK}Авто`, "HLS1", "HLS2"]);
    assert.equal(s.items?.[0]?.action, commitMsg(msgs.act("set", "mode", "auto")));
  });

  it("voice type: «Любой» and the reference list", async () => {
    const t = await make();
    const s = await panel(t, "audioType");
    assert.deepEqual(labels(s), [`${CHECK}Любой`, "Дубляж", "Многоголосый", "Двухголосый", "Одноголосый", "Оригинал"]);
    assert.equal(s.items?.[1]?.action, commitMsg(msgs.act("set", "audioType", 1)));
  });

  it("favourite studios: one reset row with the count", async () => {
    const t = await make();
    t.ctx.prefs.update({ audioAuthors: [11, 12, 13] });
    const s = await panel(t, "authors");
    assert.deepEqual(labels(s), ["Сбросить любимые студии (3)"]);
  });

  it("account: «Выйти из KinoPub» commits act:set:logout", async () => {
    const t = await make();
    const s = await panel(t, "account");
    assert.deepEqual(s.items?.map((i) => [i.label, i.action]), [["Выйти из KinoPub", commitMsg(msgs.act("set", "logout"))]]);
  });

  it("HEVC panel marks the device value", async () => {
    const t = await make();
    t.mock.state.devices.get(deviceId(t))!.settings.supportHevc = 1;
    const s = await panel(t, "hevc");
    assert.deepEqual(labels(s), [`${CHECK}вкл`, "выкл"]);
  });

  it("unknown key — error inside the panel", async () => {
    const t = await make();
    const s = await panel(t, "nope");
    assert.match(String(s.pages?.[0]?.items[0]?.text), /KP-BAD/);
  });

  it("device info is cached (Plan B §7.2, crawler): the screen and the 4K/HEVC panels again — no device/info request", async () => {
    const t = await make();
    const reads = (): number => t.mock.calls().filter((c) => c.path === "/v1/device/info").length;
    await screen(t);
    assert.equal(reads(), 1);
    await screen(t);
    await panel(t, "hevc");
    await panel(t, "uhd");
    assert.equal(reads(), 1);
  });
});

describe("onSettingsAct", () => {
  it("quality 720 → prefs.maxQuality, [back|reload:content]; the row then shows 720p (CAC-20)", async () => {
    const t = await make();
    await act(t, "quality", 720);
    assert.equal(t.ctx.prefs.get().maxQuality, 720);
    assert.deepEqual(actions(t), [BACK_RELOAD]);
    assert.equal(ext(await screen(t), "quality"), "720p");
    assert.equal(device(t).support4k, 0);
  });

  it("quality 2160 → also support4k = 1 on this TV's KinoPub device", async () => {
    const t = await make();
    await act(t, "quality", 2160);
    assert.equal(t.ctx.prefs.get().maxQuality, 2160);
    assert.equal(device(t).support4k, 1);
    assert.deepEqual(actions(t), [BACK_RELOAD]);
  });

  it("HEVC on → device form POST with the right Content-Type, then re-read; selection allows HEVC", async () => {
    const t = await make();
    await act(t, "hevc", 1);
    assert.equal(device(t).supportHevc, 1);
    assert.equal(t.ctx.prefs.get().allowHevc, true);
    const calls = t.mock.calls();
    const post = calls.findIndex((c) => c.method === "POST" && c.path === `/v1/device/${deviceId(t)}/settings`);
    assert.ok(post >= 0, "no settings POST");
    assert.ok(calls[post]?.contentType?.startsWith(FORM), String(calls[post]?.contentType));
    assert.ok(calls.slice(post + 1).some((c) => c.method === "GET" && c.path === "/v1/device/info"), "not re-read");
    assert.deepEqual(actions(t), [BACK_RELOAD]);
    assert.equal(ext(await screen(t), "hevc"), "вкл");
  });

  it("a save after the screen was opened: the re-read goes to the API, the reloaded screen shows it from the cache", async () => {
    const t = await make();
    assert.equal(ext(await screen(t), "uhd"), "выкл");
    await act(t, "uhd", 1);
    const reads = t.mock.calls().filter((c) => c.path === "/v1/device/info").length;
    assert.equal(ext(await screen(t), "uhd"), "вкл");
    assert.equal(t.mock.calls().filter((c) => c.path === "/v1/device/info").length, reads);
  });

  it("the re-read fails → the error, not a mismatch against the cached value", async () => {
    const t = await make();
    await screen(t);
    t.mock.setScenario({ rules: [{ path: "^/v1/device/info$", status: 502 }] });
    await act(t, "hevc", 1);
    assert.equal(device(t).supportHevc, 1);
    assert.deepEqual(actions(t), ["[back|reload:content|info:KinoPub не отвечает]"]);
  });

  it("4K off → support4k = 0", async () => {
    const t = await make();
    t.mock.state.devices.get(deviceId(t))!.settings.support4k = 1;
    await act(t, "uhd", 0);
    assert.equal(device(t).support4k, 0);
  });

  it("device save fails → value unchanged, the error is shown over the reloaded screen", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "/settings$", method: "POST", status: 500 }] });
    await act(t, "hevc", 1);
    assert.equal(device(t).supportHevc, 0);
    assert.equal(t.ctx.prefs.get().allowHevc, false);
    assert.deepEqual(actions(t), ["[back|reload:content|info:KinoPub не отвечает]"]);
  });

  it("server answers 200 but keeps the old value → the re-read catches it (Plan B §6.2.1)", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "/settings$", method: "POST", status: 200 }] });
    await act(t, "hevc", 1);
    assert.equal(device(t).supportHevc, 0);
    assert.equal(t.ctx.prefs.get().allowHevc, false);
    assert.deepEqual(actions(t), ["[back|reload:content|info:Неожиданный ответ KinoPub]"]);
  });

  it("TV prefs: mode, voice, studios reset, AC3, subtitles, advanced", async () => {
    const t = await make();
    t.ctx.prefs.update({ audioAuthors: [11, 12] });
    await act(t, "mode", "hls2");
    await act(t, "audioLang", "eng");
    await act(t, "audioType", 4);
    await act(t, "authors", "reset");
    await act(t, "ac3", "true");
    await act(t, "subs", "rus");
    await act(t, "bufferInit", 8);
    await act(t, "bufferResume", 10);
    await act(t, "posterSize", "small");
    await act(t, "cardBackgrounds", "true");
    const p = t.ctx.prefs.get();
    assert.deepEqual(
      [p.streamMode, p.audioLang, p.audioType, p.audioAuthors, p.allowAc3, p.subsLang, p.bufferInit, p.bufferResume, p.posterSize, p.cardBackgrounds],
      ["hls2", "eng", 4, [], true, "rus", 8, 10, "small", true],
    );
    await act(t, "mode", "auto");
    await act(t, "audioType", "auto");
    assert.equal(t.ctx.prefs.get().streamMode, undefined);
    assert.equal(t.ctx.prefs.get().audioType, undefined);
    assert.ok(actions(t).every((a) => a === BACK_RELOAD));
  });

  it("invalid value or key is ignored", async () => {
    const t = await make();
    await act(t, "quality", 999);
    await act(t, "nope", 1);
    await act(t, "hevc", 2);
    assert.equal(t.ctx.prefs.get().maxQuality, 1080);
    assert.deepEqual(actions(t), []);
    assert.equal(t.mock.calls().filter((c) => c.method === "POST").length, 0);
  });

  it("logout → device unlink on the server, kp.auth.* is empty, replace:menu (CAC-24: other TVs keep their devices)", async () => {
    const t = await make();
    const other = t.mock.issueToken();
    t.ctx.prefs.update({ maxQuality: 720 });
    t.ctx.outbox.putMarktime(FIX.SERIAL_SMALL, 1, 2, 300);
    const keys = (): (string | null)[] => Array.from({ length: t.storage.length }, (_, i) => t.storage.key(i));
    const kept = keys().filter((k) => k?.startsWith("kp.cfg.") || k?.startsWith("kp.out."));
    assert.ok(kept.length >= 2, kept.join());
    await act(t, "logout");
    assert.ok(t.mock.calls().some((c) => c.method === "POST" && c.path === "/v1/device/unlink"));
    assert.deepEqual(keys().filter((k) => k?.startsWith("kp.auth.")), []);
    assert.deepEqual(kept.filter((k) => !keys().includes(k)), [], "logout removes only kp.auth.* (спец. §7.3)");
    assert.equal(t.ctx.auth.isLoggedIn(), false);
    assert.ok(actions(t).some((a) => a.includes(`replace:menu:menu:request:interaction:init@${TEST_P}`)), JSON.stringify(actions(t)));
    assert.ok(t.mock.state.tokens.has(other.access), "another TV's token survived");
  });

  it("logout forgets the cached device: after a new login the screen and a save use the new KinoPub device", async () => {
    const t = await make();
    assert.equal(ext(await screen(t), "device"), "kpmock TV");
    await act(t, "logout");
    await t.run(t.ctx.auth.completeLogin({ ...t.mock.issueToken(), expiresIn: 3600 }, "Новый ТВ"));
    assert.equal(ext(await screen(t), "device"), "Новый ТВ");
    const id = [...t.mock.state.devices.keys()].at(-1);
    await act(t, "hevc", 1);
    assert.deepEqual(actions(t).at(-1), BACK_RELOAD);
    assert.ok(t.mock.calls().some((c) => c.method === "POST" && c.path === `/v1/device/${id}/settings`));
  });
});
