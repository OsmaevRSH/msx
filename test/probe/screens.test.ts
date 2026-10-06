import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chain, commitMsg, contentAction, panelAction, resolveAction } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot, MsxResolveResponse } from "../../src/msx/types.ts";
import { pickTestTitle } from "../../src/probe/checks-api.ts";
import { API_CHECKS, CHECK_IDS } from "../../src/probe/runner.ts";
import { devScreen, onProbeAct } from "../../src/probe/screens.ts";
import type { TestTitle } from "../../src/probe/store.ts";
import { sessionFromProps } from "../../src/progress/session.ts";
import { encodeListKey, ids, msgs } from "../../src/router/ids.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps.reverse()) await t.close();
  apps = [];
});

async function make(o: TestAppOptions = {}): Promise<TestApp> {
  const t = await createTestApp(o);
  apps.push(t);
  return t;
}

const P = TEST_P;
const GRID = ids.list(encodeListKey({ src: "catalog", type: "movie", sort: "-updated" }));
const act = (name: string, ...args: (string | number)[]): string => commitMsg(msgs.act("probe", name, ...args));
const labels = (root: MsxContentRoot): string[] => (root.items ?? []).flatMap((i) => (i.label === undefined ? [] : [i.label]));
const byLabel = (root: MsxContentRoot, label: string): MsxContentItem | undefined => root.items?.find((i) => i.label === label);
const actions = (root: MsxContentRoot): string[] => (root.items ?? []).flatMap((i) => (i.action === undefined ? [] : [i.action]));
const checkRows = (root: MsxContentRoot): string[] =>
  (root.items ?? []).flatMap((i) => /^c_CDG-\d\d$/.test(i.id ?? "") ? [(i.id ?? "").slice(2)] : []);

async function probe(t: TestApp): Promise<MsxContentRoot> {
  return (await t.request(ids.probe())) as MsxContentRoot;
}

/** Обработчик сообщения запускается маршрутизатором без ожидания: двигаем поддельное время, пока он не закончит. */
async function until(t: TestApp, cond: () => boolean, what: string): Promise<void> {
  await t.run(new Promise<void>((resolve, reject) => {
    const limit = t.clock.now() + 110_000;
    const tick = (): void => {
      if (cond()) resolve();
      else if (t.clock.now() > limit) reject(new Error(`until: ${what}`));
      else t.clock.setTimeout(tick, 50);
    };
    tick();
  }));
}

describe("probeScreen (spec §16.2, decision R-11)", () => {
  it("without login: rows of CDG-01, 02, 09, 10, «Вход», no play tiles and no logout; no network", async () => {
    const t = await make();
    const root = await probe(t);
    assert.equal(root.type, "list");
    assert.equal(root.flag, "probe");
    assert.equal(root.cache, false);
    assert.deepEqual(checkRows(root), ["CDG-01", "CDG-02", "CDG-09", "CDG-10"]);
    assert.equal(byLabel(root, "Вход")?.action, contentAction(P, ids.login()));
    assert.ok(!actions(root).some((a) => a.startsWith("video:resolve:")));
    assert.equal(byLabel(root, "Выйти из KinoPub (освободить слот)"), undefined);
    for (const l of ["Запустить проверки API", "Записать маркер хранилища", "Отчёт", "Отчёт в консоль", "Для разработчика"]) {
      assert.ok(labels(root).includes(l), l);
    }
    assert.equal(t.mock.calls().length, 0);
  });

  it("with login: 12 rows, tiles of the test title, grid, report, console, dev and logout", async () => {
    const t = await make({ loggedIn: true });
    const root = await probe(t);
    assert.deepEqual(checkRows(root), [...CHECK_IDS]);
    const tt = await t.run(pickTestTitle(t.ctx)) as TestTitle;
    const play = (v: string, u = tt.s1e1): string => resolveAction(P, ids.probePlay(v, tt.id, u.mid, u.s, u.e));
    assert.match(byLabel(root, "a1")?.action ?? "", new RegExp(`^video:resolve:request:interaction:play:probe:a1:${tt.id}:\\d+:1:1@`));
    assert.ok((byLabel(root, "a1")?.action ?? "").endsWith(`@${P}`));
    assert.equal(byLabel(root, "a2")?.action, play("a2"));
    assert.equal(byLabel(root, "HLS2")?.action, play("hls2"));
    assert.equal(byLabel(root, "Свойства из resolve")?.action, play("props"));
    assert.equal(byLabel(root, "События и тики")?.action, play("ticks"));
    assert.equal(byLabel(root, "Автопереход")?.action, play("autonext", tt.s1Last));
    assert.equal(byLabel(root, "Сетка 150")?.action, chain([act("grid"), contentAction(P, GRID)]));
    assert.equal(byLabel(root, "Отчёт")?.action, contentAction(P, ids.probe("report:1")));
    assert.equal(byLabel(root, "Отчёт в консоль")?.action, act("console"));
    assert.equal(byLabel(root, "Для разработчика")?.action, contentAction(P, ids.dev()));
    assert.equal(byLabel(root, "Выйти из KinoPub (освободить слот)")?.action, act("logout"));
    assert.equal(byLabel(root, "Вход"), undefined);
    for (const id of API_CHECKS) {
      assert.equal(root.items?.find((i) => i.id === `c_${id}`)?.action, chain([`info:Проверка ${id} запущена`, act("run", id)]), id);
    }
  });

  it("rows show ✓/✗/— as MSX icons and the summary", async () => {
    const t = await make();
    t.ctx.probe!.record({ id: "CDG-01", ok: true, summary: "ответ 401 прочитан", values: {}, at: 1 });
    t.ctx.probe!.record({ id: "CDG-09", ok: false, summary: "квота {мала}", values: {}, at: 1 });
    const root = await probe(t);
    const row = (id: string): string => String(root.items?.find((i) => i.id === `c_${id}`)?.label);
    assert.equal(row("CDG-01"), "CDG-01 {ico:msx-green:check} ответ 401 прочитан");
    assert.equal(row("CDG-09"), "CDG-09 {ico:msx-red:close} квота (мала)");
    assert.equal(row("CDG-02"), "CDG-02 — не запускалась");
  });
});

describe("onProbeAct", () => {
  it("act:probe:runApi → results of all API checks, then reload:content of the current probe screen", async () => {
    const t = await make({ loggedIn: true });
    t.app.ready();
    await probe(t);
    t.host.clearActions();
    t.app.handleData({ message: msgs.act("probe", "runApi") });
    await until(t, () => t.host.actions.some((a) => a.action === "reload:content"), "reload:content");
    assert.deepEqual(t.ctx.probe!.results().map((r) => r.id), [...API_CHECKS]);
    for (const r of t.ctx.probe!.results()) assert.equal(r.ok, true, `${r.id}: ${r.summary}`);
  });

  it("run:<id> runs one API check; a TV check id or the screen not current → no reload", async () => {
    const t = await make();
    await t.run(onProbeAct(t.ctx, "run", ["CDG-05"]));
    assert.deepEqual(t.ctx.probe!.results(), []);
    await t.request(ids.dev());
    await t.run(onProbeAct(t.ctx, "run", ["CDG-01"]));
    assert.deepEqual(t.ctx.probe!.results().map((r) => r.id), ["CDG-01"]);
    assert.ok(!t.host.actions.some((a) => a.action.includes("reload:content")));
  });

  it("persistWrite writes the marker and toasts", async () => {
    const t = await make();
    await probe(t);
    await t.run(onProbeAct(t.ctx, "persistWrite", []));
    assert.notEqual(t.storage.getItem("kp.auth.probeMarker"), null);
    assert.match(t.host.actions.at(-1)?.action ?? "", /^\[info:Маркер записан.*\|reload:content\]$/);
  });

  it("act:probe:logout → device/unlink in the mock journal, tokens removed, reload:menu", async () => {
    const t = await make({ loggedIn: true });
    t.app.handleData({ message: msgs.act("probe", "logout") });
    await until(t, () => !t.ctx.auth.isLoggedIn(), "logout");
    assert.equal(t.mock.calls().filter((c) => c.method === "POST" && c.path === "/v1/device/unlink").length, 1);
    assert.equal(t.storage.getItem("kp.auth.pair"), null);
    assert.ok(t.host.actions.some((a) => a.action === "reload:menu"));
  });

  it("console → one console.log line «KPREPORT {…}» and a toast", async (tc) => {
    const t = await make();
    const log = tc.mock.method(console, "log", () => undefined);
    await t.run(onProbeAct(t.ctx, "console", []));
    assert.equal(log.mock.callCount(), 1);
    const line = String(log.mock.calls[0]?.arguments[0]);
    assert.ok(line.startsWith("KPREPORT {"));
    assert.equal(JSON.parse(line.slice("KPREPORT ".length)).version, t.ctx.build.version);
    assert.equal(t.host.actions.at(-1)?.action, "info:Отчёт выведен в консоль браузера");
  });

  it("an unknown act is only logged", async () => {
    const t = await make();
    await t.run(onProbeAct(t.ctx, "nope", ["1"]));
    assert.equal(t.ctx.log.entries().filter((e) => e.msg === "unknown_act").length, 1);
    assert.deepEqual(t.host.actions, []);
  });
});

describe("«Для разработчика» (spec §16.6)", () => {
  it("a row per switch with the current value; changed ones are highlighted", async () => {
    const t = await make({ flags: { heartbeat: "timer" } });
    const root = await devScreen(t.ctx);
    assert.equal(root.flag, "dev");
    const rows = (root.items ?? []).filter((i) => i.id?.startsWith("f_") && i.id !== "f_reset");
    assert.deepEqual(rows.map((r) => r.id), [
      "f_streamMode", "f_playerPropsIn", "f_heartbeat", "f_events", "f_autonext", "f_focusPrefetch", "f_postBody", "f_apiBase",
      "f_apiFallbackBase",
    ]);
    const row = (k: string): MsxContentItem | undefined => rows.find((r) => r.id === `f_${k}`);
    assert.equal(row("streamMode")?.extensionLabel, "hls1");
    assert.equal(row("heartbeat")?.extensionLabel, "{txt:msx-yellow:timer}");
    assert.equal(row("streamMode")?.action, panelAction(P, ids.probe("flag:streamMode")));
    assert.equal(root.items?.find((i) => i.id === "f_reset")?.action, act("flagsReset"));
    assert.deepEqual(await t.request(ids.dev()), root);
  });

  it("the variants panel: each value commits act:probe:flag and closes the panel; the current one is checked", async () => {
    const t = await make();
    const panel = (await t.request(ids.probe("flag:streamMode"))) as MsxContentRoot;
    assert.deepEqual(panel.items?.map((i) => [i.label, i.action, i.extensionIcon]), [
      ["hls1", chain([act("flag", "streamMode", "hls1"), "back"]), "check"],
      ["hls2", chain([act("flag", "streamMode", "hls2"), "back"]), undefined],
    ]);
    const api = (await t.request(ids.probe("flag:apiBase"))) as MsxContentRoot;
    assert.equal(api.items?.length, 1, "in tests both API hosts are the mock");
  });

  it("act:probe:flag sets the switch (values with «:» too) and reloads; invalid values are ignored; flagsReset", async () => {
    const t = await make();
    await t.request(ids.dev());
    t.app.handleData({ message: msgs.act("probe", "flag", "streamMode", "hls2") });
    t.app.handleData({ message: msgs.act("probe", "flag", "apiBase", t.ctx.build.apiBase) });
    await t.run(Promise.resolve());
    assert.equal(t.ctx.flags.get().streamMode, "hls2");
    assert.deepEqual(t.host.actions.map((a) => a.action), ["reload:content", "reload:content"]);
    t.host.clearActions();
    await t.run(onProbeAct(t.ctx, "flag", ["streamMode", "hls4"]));
    await t.run(onProbeAct(t.ctx, "flag", ["nope", "x"]));
    assert.equal(t.host.actions.length, 0);
    assert.equal(t.ctx.flags.get().streamMode, "hls2");
    await t.run(onProbeAct(t.ctx, "flagsReset", []));
    assert.deepEqual(t.ctx.flags.overrides(), {});
    assert.match(t.host.actions.at(-1)?.action ?? "", /reload:content\]$/);
  });
});

describe("«Для разработчика»: the variants panel does not change the current screen (spec §6.3, CD-16)", () => {
  it("dev → panel probe:flag:… → choice: dev stays current and is reloaded", async () => {
    const t = await make();
    await t.request(ids.dev());
    await t.request(ids.probe("flag:streamMode"));
    assert.equal(t.ctx.current.get(), ids.dev());
    await t.run(onProbeAct(t.ctx, "flag", ["streamMode", "hls2"]));
    assert.deepEqual(t.host.actions.map((a) => a.action), ["reload:content"]);
  });

  it("the choice arrives when another screen is current → the switch is set, no reload", async () => {
    const t = await make();
    await t.request(ids.dev());
    await t.request(ids.probe("flag:streamMode"));
    t.ctx.current.onRequest(ids.probe("report:1"));
    await t.run(onProbeAct(t.ctx, "flag", ["streamMode", "hls2"]));
    assert.equal(t.ctx.flags.get().streamMode, "hls2");
    assert.deepEqual(t.host.actions, []);
  });
});

describe("probeResolve: forced parameters of the probe tiles", () => {
  async function play(t: TestApp, v: string, u?: "last"): Promise<{ res: MsxResolveResponse; tt: TestTitle }> {
    const tt = await t.run(pickTestTitle(t.ctx)) as TestTitle;
    const ref = u === "last" ? tt.s1Last : tt.s1e1;
    const res = (await t.request(ids.probePlay(v, tt.id, ref.mid, ref.s, ref.e))) as MsxResolveResponse;
    assert.equal(res.error, undefined, res.error ?? "");
    return { res, tt };
  }

  it("a1/a2: hls1 with the first/second audio; kp:p is the variant and the session sees it", async () => {
    const t = await make({ loggedIn: true });
    const a1 = (await play(t, "a1")).res;
    const a2 = (await play(t, "a2")).res;
    assert.match(a1.url ?? "", /master-v1a1\.m3u8/);
    assert.match(a2.url ?? "", /master-v1a2\.m3u8/);
    assert.equal(a2.properties?.["kp:p"], "a2");
    assert.equal(sessionFromProps(a2.properties, 0)?.probe, "a2");
    assert.equal(a1.properties?.["resume:position"], "none");
  });

  it("hls2: the hls2 stream even when TV prefs say hls1", async () => {
    const t = await make({ loggedIn: true });
    const { res } = await play(t, "hls2");
    assert.match(res.properties?.["label:extension"] ?? "", /HLS2/);
    assert.equal(res.properties?.["kp:p"], "hls2");
  });

  it("ticks: trigger every 10 ticks; autonext: duration − 20", async () => {
    const t = await make({ loggedIn: true });
    const ticks = (await play(t, "ticks")).res;
    assert.equal(ticks.properties?.["trigger:10t"], chain(["interaction:commit:video", "player:ticking:restart"]));
    assert.equal(ticks.properties?.["kp:p"], "ticks");
    const { res, tt } = await play(t, "autonext", "last");
    assert.equal(res.properties?.["resume:position"], String(tt.s1Last.duration - 20));
  });

  it("playerPropsIn=item: probe tiles have no item properties, so kp:* still come with resolve", async () => {
    const t = await make({ loggedIn: true, flags: { playerPropsIn: "item" } });
    const { res } = await play(t, "props");
    assert.equal(res.properties?.["kp:p"], "props");
    assert.ok(sessionFromProps(res.properties, 0) !== undefined);
    assert.equal(typeof res.properties?.["resume:position"], "string");
  });
});
