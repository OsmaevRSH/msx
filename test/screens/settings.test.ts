import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { fmtDate } from "../../src/core/format.ts";
import { chain, commitMsg, contentAction, panelAction } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { ids, msgs } from "../../src/router/ids.ts";
import { onCdnSet } from "../../src/probe/cdn.ts";
import { onSettingsAct } from "../../src/screens/settings.ts";
import { answerIssues } from "../../tools/crawl-rules.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";

const P = TEST_P;
const CHECK = "{ico:check} ";
const BACK_RELOAD = "[back|reload:content]";
const FORM = "application/x-www-form-urlencoded";

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(o: TestAppOptions = { loggedIn: true }): Promise<TestApp> {
  const t = await createTestApp(o);
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
  it("«Настройки»: 12×6 list of 12×1 control rows with group headers, flag «settings», not cached", async () => {
    const t = await make();
    const s = await screen(t);
    assert.equal(s.type, "list");
    assert.equal(s.flag, "settings");
    assert.equal(s.headline, "Настройки");
    assert.equal(s.cache, false);
    assert.equal(s.compress, undefined);
    // SET-10: без счётчика MSX «(N/21)» в заголовке.
    assert.deepEqual(s.template, { type: "control", layout: "0,0,12,1", enumerate: false });
    const groups = (s.items ?? []).filter((i) => i.type === "space");
    assert.deepEqual(groups.map((g) => g.headline), ["Меню и главная", "Воспроизведение", "Это устройство KinoPub", "Аккаунт", "Для опытных", "Для разработчика"]);
    // V-33: заголовок в нижней половине своей строки — вплотную к группе, без пустой полосы под ним.
    for (const g of groups) assert.deepEqual([g.layout, g.offset], ["0,0,12,1", "0,0.5,0,-0.5"]);
  });

  it("V-33: technical rows are in «Для опытных»; «Выйти из KinoPub» is a row of «Аккаунт»; v1.13: the menu and home order first", async () => {
    const t = await make();
    const s = await screen(t);
    const byGroup: string[][] = [];
    for (const i of s.items ?? []) {
      if (i.type === "space") byGroup.push([]);
      else byGroup.at(-1)?.push(String(i.id).slice(2));
    }
    assert.deepEqual(byGroup, [
      ["menu", "home"],
      ["quality", "audioLang", "audioType", "authors", "subs", "seek", "cdn"],
      ["uhd", "device"],
      ["account", "logout"],
      ["mode", "loc", "ac3", "hevc", "bufferInit", "bufferResume", "posterSize", "cardBackgrounds"],
      ["probe", "msx"],
    ]);
    assert.deepEqual(labels(s).filter((l) => l !== undefined), [
      "Порядок и видимость пунктов меню", "Порядок и видимость секций главной",
      "Максимальное качество", "Язык озвучки", "Тип озвучки", "Любимые студии", "Субтитры по умолчанию", "Шаг перемотки",
      "Скорость серверов KinoPub",
      "4K", "Название", "Подписка", "Выйти из KinoPub",
      "Способ воспроизведения", "CDN-сервер", "Разрешить AC3", "HEVC", "Буфер старта", "Буфер продолжения", "Размер постеров", "Фоны карточек",
      "Диагностика", "Системные настройки MSX",
    ]);
  });

  it("every row of the S12 table shows the current value: defaults, 4K and HEVC off", async () => {
    const t = await make();
    const s = await screen(t);
    // V-33: значения с заглавной буквы.
    const want: Record<string, string> = {
      // SET-13: один вид переключателей «Вкл/Выкл»; у CDN по умолчанию — страна сервера устройства, как в панели.
      quality: "1080p", mode: "Авто", loc: "По умолчанию (Нидерланды)", audioLang: "Русский", audioType: "Любой", authors: "Нет",
      ac3: "Выкл", subs: "Выключены", hevc: "Выкл", uhd: "Выкл", device: "kpmock TV",
      bufferInit: "4 с", bufferResume: "6 с", posterSize: "Средние", cardBackgrounds: "Выкл", seek: "10 с",
      menu: "По умолчанию", home: "По умолчанию",
    };
    for (const [k, v] of Object.entries(want)) assert.equal(ext(s, k), v, k);
  });

  it("rows open their panels; CDN — the S10 location panel; «Диагностика» — the probe; the device name and the subscription are display only (SET-12: readable, focusable)", async () => {
    const t = await make();
    const s = await screen(t);
    assert.equal(row(s, "quality").action, panelAction(P, ids.panel("setting", "quality")));
    assert.equal(row(s, "logout").action, panelAction(P, ids.panel("setting", "account")));
    assert.equal(row(s, "menu").action, panelAction(P, ids.panel("menu")));
    assert.equal(row(s, "home").action, panelAction(P, ids.panel("home")));
    // SET-12: выключенная строка — тёмно-серый текст, срок подписки не читается с дивана; строка в фокусе, без действия.
    assert.equal(row(s, "account").enable, undefined);
    assert.equal(row(s, "account").action, undefined);
    assert.equal(row(s, "loc").action, panelAction(P, ids.panel("loc")));
    assert.equal(row(s, "probe").action, contentAction(P, ids.probe()));
    // v1.20: тест скорости CDN — экран probe.js (§16.7), строка — последняя в «Воспроизведении».
    assert.equal(row(s, "cdn").action, contentAction(P, ids.probe("cdn")));
    assert.equal(row(s, "cdn").extensionLabel, "");
    assert.equal(row(s, "msx").action, "settings");
    assert.equal(row(s, "device").enable, undefined);
    assert.equal(row(s, "device").action, undefined);
  });

  it("account row: subscription end date and days left", async () => {
    const t = await make();
    const u = await t.run(t.ctx.api.user());
    const s = await screen(t);
    assert.equal(ext(s, "account"), `До ${fmtDate(u.subscription.endTime)}, осталось 30 дн.`);
  });

  it("stored choices are shown: 720p, «Способ 2», CDN country in Russian, voice type, studios count, subtitles", async () => {
    const t = await make();
    t.ctx.prefs.update({ maxQuality: 720, streamMode: "hls2", loc: "de", audioType: 2, audioAuthors: [11, 12], subsLang: "eng", allowAc3: true });
    const s = await screen(t);
    assert.equal(ext(s, "quality"), "720p");
    assert.equal(ext(s, "mode"), "Способ 2 (HLS2)");
    assert.equal(ext(s, "loc"), "Германия");
    assert.equal(ext(s, "audioType"), "Многоголосый");
    assert.equal(ext(s, "authors"), "2");
    assert.equal(ext(s, "subs"), "Английские");
    assert.equal(ext(s, "ac3"), "Вкл");
  });

  it("SET-13: «Разрешить AC3» offers «Вкл» and «Выкл», like HEVC, 4K and card backgrounds", async () => {
    const t = await make();
    const p = await panel(t, "ac3");
    assert.deepEqual(p.items?.map((i) => i.label?.replace(CHECK, "")), ["Вкл", "Выкл"]);
  });

  it("SET-13: «2160p» whose 4K fails says «4K не включён» with the reason", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "/settings$", method: "POST", status: 500 }] });
    await act(t, "quality", 2160);
    assert.equal(t.ctx.prefs.get().maxQuality, 2160);
    assert.deepEqual(actions(t), ["[back|reload:content|info:4K не включён: KinoPub не отвечает]"]);
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

// v1.16: «Диагностика» и системные настройки MSX ушли из меню в последнюю группу настроек — и без входа: при проблемах
// со входом они нужны первыми. Без входа экран не ходит в API: остальные строки — настройки аккаунта и устройства.
describe("settingsScreen: «Для разработчика» (v1.16)", () => {
  const DEV = [
    { id: "s_probe", label: "Диагностика", action: contentAction(P, ids.probe()) },
    { id: "s_msx", label: "Системные настройки MSX", action: "settings" },
  ];
  const devRows = (s: MsxContentRoot): MsxContentItem[] => {
    const items = s.items ?? [];
    const head = items.findIndex((i) => i.type === "space" && i.headline === "Для разработчика");
    assert.ok(head >= 0, "no «Для разработчика»");
    return items.slice(head + 1).filter((i) => i.type !== "space" && i.selection === undefined);
  };

  it("the last group: «Диагностика» opens the probe, «Системные настройки MSX» — the MSX settings (action `settings`)", async () => {
    const t = await make();
    const s = await screen(t);
    const groups = (s.items ?? []).filter((i) => i.type === "space" && i.headline !== undefined);
    assert.equal(groups.at(-1)?.headline, "Для разработчика");
    assert.deepEqual(devRows(s).map(({ id, label, action }) => ({ id, label, action })), DEV);
    assert.deepEqual(answerIssues(ids.settings(), s), []);
  });

  it("without login: only «Для разработчика», no API requests, the probe is not loaded; the router answers it instead of the login screen", async () => {
    const t = await make({ probe: "lazy" });
    const s = await screen(t);
    assert.equal(s.headline, "Настройки");
    assert.equal(s.flag, "settings");
    assert.deepEqual((s.items ?? []).filter((i) => i.type === "space" && i.headline !== undefined).map((i) => i.headline), ["Для разработчика"]);
    assert.deepEqual(devRows(s).map(({ id, label, action }) => ({ id, label, action })), DEV);
    assert.equal(devRows(s)[0]?.focus, true, "focus on «Диагностика»");
    assert.deepEqual(answerIssues(ids.settings(), s), []);
    assert.equal(t.mock.calls().length, 0, "no API requests");
    assert.equal(t.ctx.probe, undefined, "probe.js is loaded only by «Диагностика»");
    assert.equal(t.ctx.current.get(), ids.settings());
    assert.equal(t.ctx.log.entries().filter((e) => e.msg === "login required").length, 0);
  });

  it("logged in: opening the settings does not load probe.js either", async () => {
    const t = await make({ loggedIn: true, probe: "lazy" });
    await screen(t);
    assert.equal(t.ctx.probe, undefined);
    await t.request(ids.probe());
    assert.ok(t.ctx.probe !== undefined);
  });

  it("without login a setting panel is still the login screen: only the screen is public", async () => {
    const t = await make({});
    const p = await panel(t, "quality");
    assert.notEqual(p.headline, "Максимальное качество");
    assert.equal(t.ctx.log.entries().filter((e) => e.msg === "login required").length, 1);
  });
});

describe("settingPanel", () => {
  it("«Максимальное качество»: four values, the current one checked, a choice commits act:set:quality:<q>", async () => {
    const t = await make();
    const s = await panel(t, "quality");
    assert.equal(s.headline, "Максимальное качество");
    assert.deepEqual(labels(s), ["2160p", `${CHECK}1080p`, "720p", "480p"]);
    assert.equal(s.items?.[2]?.action, commitMsg(msgs.act("set", "quality", 720)));
  });

  it("«Шаг перемотки»: 5, 10, 15, 30 с, 10 с checked; a choice commits act:set:seek:<s>", async () => {
    const t = await make();
    const s = await panel(t, "seek");
    assert.equal(s.headline, "Шаг перемотки");
    assert.deepEqual(labels(s), ["5 с", `${CHECK}10 с`, "15 с", "30 с"]);
    assert.equal(s.items?.[3]?.action, commitMsg(msgs.act("set", "seek", 30)));
  });

  it("«Способ воспроизведения»: Авто, Способ 1 (HLS1), Способ 2 (HLS2)", async () => {
    const t = await make();
    const s = await panel(t, "mode");
    assert.equal(s.headline, "Способ воспроизведения");
    assert.deepEqual(labels(s), [`${CHECK}Авто`, "Способ 1 (HLS1)", "Способ 2 (HLS2)"]);
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

  it("V-36: no favourite studios — how one is added, without a pointless reset", async () => {
    const t = await make();
    const s = await panel(t, "authors");
    assert.deepEqual(s.items?.map((i) => [i.label, i.action]), [["Студия добавляется, когда вы выбираете озвучку на карточке", "back"]]);
  });

  it("V-34: account is a logout confirmation «Выйти из KinoPub?»; focus on «Отмена», «Выйти» closes it and logs out", async () => {
    const t = await make();
    const s = await panel(t, "account");
    assert.equal(s.headline, "Выйти из KinoPub?");
    assert.deepEqual(s.template, { type: "button", layout: "0,0,8,1" });
    assert.deepEqual(s.items, [
      { label: "Выйти", action: chain(["back", commitMsg(msgs.act("set", "logout"))]) },
      { label: "Отмена", action: "back", focus: true },
    ]);
  });

  it("HEVC panel marks the device value", async () => {
    const t = await make();
    t.mock.state.devices.get(deviceId(t))!.settings.supportHevc = 1;
    const s = await panel(t, "hevc");
    assert.deepEqual(labels(s), [`${CHECK}Вкл`, "Выкл"]);
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
    assert.equal(ext(await screen(t), "hevc"), "Вкл");
  });

  it("a save after the screen was opened: the re-read goes to the API, the reloaded screen shows it from the cache", async () => {
    const t = await make();
    assert.equal(ext(await screen(t), "uhd"), "Выкл");
    await act(t, "uhd", 1);
    const reads = t.mock.calls().filter((c) => c.path === "/v1/device/info").length;
    assert.equal(ext(await screen(t), "uhd"), "Вкл");
    assert.equal(t.mock.calls().filter((c) => c.path === "/v1/device/info").length, reads);
  });

  it("the re-read fails → the error, not a mismatch against the cached value", async () => {
    const t = await make();
    await screen(t);
    t.mock.setScenario({ rules: [{ path: "^/v1/device/info$", status: 502 }] });
    await act(t, "hevc", 1);
    assert.equal(device(t).supportHevc, 1);
    assert.deepEqual(actions(t), ["[back|reload:content|info:Настройка «HEVC» не изменена: KinoPub не отвечает]"]);
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
    assert.deepEqual(actions(t), ["[back|reload:content|info:Настройка «HEVC» не изменена: KinoPub не отвечает]"]);
  });

  // SET-3 / API-14: на строгом mock (M-11) частичная форма сбросила бы 4K и HEVC.
  it("SET-3: «HEVC: Вкл», «4K: Вкл», then «Выбрать самый быстрый» — HEVC and 4K stay (strict mock, M-11)", async () => {
    const t = await make();
    await act(t, "hevc", 1);
    await act(t, "uhd", 1);
    await t.run(onCdnSet(t.ctx, "de"));
    const s = device(t);
    assert.deepEqual([s.supportHevc, s.support4k, s.serverLocation], [1, 1, 2]);
    assert.deepEqual(actions(t), [BACK_RELOAD, BACK_RELOAD, "info:CDN-сервер: Германия"]);
  });

  it("SET-3 / API-14: the re-read is checked on every field — a server that drops HEVC while saving 4K is caught", async () => {
    const t = await make();
    await act(t, "hevc", 1);
    const save = t.ctx.api.deviceSettingsSave.bind(t.ctx.api);
    t.ctx.api.deviceSettingsSave = async (base, change) => {
      const sent = await save(base, change);
      t.mock.state.devices.get(deviceId(t))!.settings.supportHevc = 0;
      return sent;
    };
    await act(t, "uhd", 1);
    assert.equal(actions(t).at(-1), "[back|reload:content|info:4K не включён: Неожиданный ответ KinoPub]");
  });

  it("server answers 200 but keeps the old value → the re-read catches it (Plan B §6.2.1)", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "/settings$", method: "POST", status: 200 }] });
    await act(t, "hevc", 1);
    assert.equal(device(t).supportHevc, 0);
    assert.equal(t.ctx.prefs.get().allowHevc, false);
    assert.deepEqual(actions(t), ["[back|reload:content|info:Настройка «HEVC» не изменена: Неожиданный ответ KinoPub]"]);
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

  it("seek step 30 → prefs.seekStep, the row shows «30 с», the next resolve seeks ◀◀/▶▶ by 30 s", async () => {
    const t = await make();
    await act(t, "seek", 30);
    assert.equal(t.ctx.prefs.get().seekStep, 30);
    assert.deepEqual(actions(t), [BACK_RELOAD]);
    assert.equal(ext(await screen(t), "seek"), "30 с");
    const res = (await t.request(ids.playContinue(FIX.SERIAL_BIG))) as { properties: Record<string, string> };
    assert.equal(res.properties["button:forward:action"], commitMsg(msgs.act("player", "seek", "+30")));
    assert.equal(res.properties["button:rewind:action"], commitMsg(msgs.act("player", "seek", "-30")));
    await act(t, "seek", 7);
    assert.equal(t.ctx.prefs.get().seekStep, 30, "not one of the steps — ignored");
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
    const cfg = keys().filter((k) => k?.startsWith("kp.cfg."));
    assert.ok(cfg.length >= 1 && keys().some((k) => k?.startsWith("kp.out.")), keys().join());
    await act(t, "logout");
    const paths = t.mock.calls().map((c) => c.path);
    assert.ok(paths.includes("/v1/device/unlink"));
    const marktime = paths.indexOf("/v1/watching/marktime");
    assert.ok(marktime >= 0 && marktime < paths.indexOf("/v1/device/unlink"), `SET-8: the outbox goes first: ${paths.join()}`);
    assert.deepEqual(keys().filter((k) => k?.startsWith("kp.auth.") || k?.startsWith("kp.out.")), []);
    assert.deepEqual(cfg.filter((k) => !keys().includes(k)), [], "kp.cfg.* (settings of this TV) stays");
    assert.equal(t.ctx.auth.isLoggedIn(), false);
    assert.ok(actions(t).some((a) => a.includes(`replace:menu:menu:request:interaction:init@${TEST_P}`)), JSON.stringify(actions(t)));
    assert.ok(t.mock.state.tokens.has(other.access), "another TV's token survived");
  });

  it("SET-8: an outbox that cannot be sent holds the logout back for at most 2 s", async () => {
    const t = await make();
    t.ctx.outbox.putMarktime(FIX.SERIAL_SMALL, 1, 2, 300);
    t.mock.setScenario({ rules: [{ path: "^/v1/watching/marktime$", hang: true }] });
    const t0 = t.clock.now();
    await act(t, "logout");
    assert.equal(t.ctx.auth.isLoggedIn(), false);
    const unlink = t.mock.calls().find((c) => c.path === "/v1/device/unlink");
    assert.ok(unlink !== undefined);
    assert.ok(t.clock.now() - t0 >= 2000 && t.clock.now() - t0 < 2100, `${t.clock.now() - t0} fake ms: waited for the outbox, but 2 s at most`);
  });

  // SET-2: «Максимальное качество 2160p» и HEVC в prefs переживают выход — новое устройство получает 4K и HEVC.
  it("SET-2: 2160p and HEVC on, logout, login again → the new KinoPub device has 4K and HEVC on, the screen agrees", async () => {
    const t = await make();
    await act(t, "quality", 2160);
    await act(t, "hevc", 1);
    await act(t, "logout");
    await t.run(t.ctx.auth.completeLogin({ ...t.mock.issueToken(), expiresIn: 3600 }, "Новый ТВ"));
    const s = await screen(t);
    assert.deepEqual([ext(s, "quality"), ext(s, "uhd"), ext(s, "hevc")], ["2160p", "Вкл", "Вкл"]);
    const dev = t.mock.state.devices.get([...t.mock.state.devices.keys()].at(-1) ?? -1)?.settings ?? {};
    assert.deepEqual([dev.support4k, dev.supportHevc], [1, 1]);
  });

  // SET-4: выход виден сразу; без связи — не дольше 6 с и честный текст, а не «Вы вышли из KinoPub».
  it("SET-4: logout says «Выхожу из KinoPub…» at once; a hanging unlink → within 6 s «устройство осталось в аккаунте»", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/device/unlink$", hang: true }] });
    const t0 = t.clock.now();
    const done = act(t, "logout");
    assert.deepEqual(actions(t), ["info:Выхожу из KinoPub…"]);
    await done;
    assert.ok(t.clock.now() - t0 <= 6000, `${t.clock.now() - t0} fake ms`);
    assert.equal(t.ctx.auth.isLoggedIn(), false);
    assert.equal(actions(t).length, 2);
    assert.ok(actions(t)[1]?.endsWith("|info:Вы вышли, но устройство осталось в аккаунте KinoPub — удалите его в списке устройств на сайте]"), actions(t)[1]);
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
