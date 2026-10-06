import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { loginScreen, onLoginAct } from "../../src/screens/login.ts";
import { FAKE_EPOCH } from "../helpers/fake-clock.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(o: Omit<TestAppOptions, "mock"> = {}): Promise<TestApp> {
  const t = await createTestApp(o);
  apps.push(t);
  t.mock.setScenario({ pendingPolls: 2 });
  return t;
}

const REFRESH_MENU = `replace:menu:menu:request:interaction:init@${TEST_P}`;
const DONE = `[info:Вход выполнен|${REFRESH_MENU}]`;
const RETRY = "[invalidate:content|reload:content]";
const CODE_TTL_MS = 600_000;   // expires_in у kpmock

/** Ждать в поддельном времени (через `t.run`), пока условие не выполнится. */
async function until(pred: () => boolean): Promise<void> {
  while (!pred()) await new Promise<void>((resolve) => setImmediate(resolve));
}

const items = (s: MsxContentRoot): MsxContentItem[] => s.pages?.[0]?.items ?? [];
const codeOf = (s: MsxContentRoot): string | undefined => items(s).find((i) => i.layout === "2,2,8,2")?.headline;
const texts = (s: MsxContentRoot): string[] => items(s).flatMap((i) => [i.headline, i.text]).filter((x): x is string => x !== undefined);
const buttons = (s: MsxContentRoot): { label?: string; action?: string }[] =>
  items(s).filter((i) => i.type === "button").map((i) => ({ label: i.label, action: i.action }));
const actions = (t: TestApp): string[] => t.host.actions.map((a) => a.action);
const mockCodes = (t: TestApp): string[] => [...t.mock.state.deviceCodes.values()].map((r) => r.userCode);
const oauthCalls = (t: TestApp): number => t.mock.calls().filter((c) => c.path === "/oauth2/device").length;
const codeGrants = (t: TestApp): number =>
  t.mock.calls().filter((c) => c.path === "/oauth2/device" && new URLSearchParams(c.query).get("grant_type") === "device_code").length;
const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

describe("loginScreen (S2)", () => {
  it("shows the user_code from the mock, the address without scheme and the expiry time", async () => {
    const t = await make();
    const s: MsxContentRoot = await t.request("login");
    assert.equal(t.ctx.current.get(), "login");
    assert.deepEqual(
      { type: s.type, flag: s.flag, cache: s.cache, reuse: s.reuse, headline: s.headline },
      { type: "pages", flag: "login", cache: false, reuse: false, headline: "Вход в KinoPub" },
    );
    assert.equal(mockCodes(t).length, 1);
    assert.equal(codeOf(s), mockCodes(t)[0]);
    assert.ok(texts(s).includes("1. Откройте на телефоне {txt:msx-white:kino.watch/device}{br}2. Введите код:"));
    assert.ok(texts(s).includes(`Код действует до ${hhmm(FAKE_EPOCH + CODE_TTL_MS)}`));
    assert.deepEqual(buttons(s), [
      { label: "Новый код", action: "interaction:commit:message:act:login:new" },
      { label: "Диагностика", action: `content:request:interaction:probe@${TEST_P}` },
    ]);
    for (const p of s.pages ?? []) assert.ok(p.items.some((i) => i.type !== "space"));
  });

  it("is reached from a content route without login", async () => {
    const t = await make();
    const s = await t.request("home");
    assert.equal(t.ctx.current.get(), "login");
    assert.equal(codeOf(s), mockCodes(t)[0]);
  });

  it("after the pending polls: toast + replace:menu, logged in, the device is named after the TV", async () => {
    const t = await make();
    t.ctx.state.msxInfo = { platform: "tizen", model: "QE55Q80" };
    await t.request("login");
    await t.run(until(() => actions(t).includes(DONE)));
    assert.ok(t.ctx.auth.isLoggedIn());
    assert.equal(oauthCalls(t), 4, "one code request and three polls (two pending)");
    assert.deepEqual(actions(t), [DONE]);
    assert.deepEqual([...t.mock.state.devices.values()].map((d) => d.title), ["MSX QE55Q80"]);
  });

  it("without MSX info the device is «MSX TV»; the platform is used when the model is unknown", async () => {
    const a = await make();
    await a.request("login");
    await a.run(until(() => a.ctx.auth.isLoggedIn() && actions(a).includes(DONE)));
    assert.deepEqual([...a.mock.state.devices.values()].map((d) => d.title), ["MSX TV"]);

    const b = await make();
    b.ctx.state.msxInfo = { platform: "tizen" };
    await b.request("login");
    await b.run(until(() => actions(b).includes(DONE)));
    assert.deepEqual([...b.mock.state.devices.values()].map((d) => d.title), ["MSX tizen"]);
  });

  it("an expired code while login is current → a new code and reload:content", async () => {
    const t = await make();
    t.mock.setScenario({ codeExpiredAtPoll: 1 });
    const first = codeOf(await t.request("login"));
    await t.run(until(() => actions(t).includes("reload:content")));
    assert.deepEqual(actions(t), ["reload:content"]);
    const next = codeOf(await t.request("login"));
    assert.ok(next !== undefined && next !== first);
    assert.equal(oauthCalls(t), 3, "code, poll, new code; the reloaded screen reuses the new code");
  });

  it("an expired code after the user moved to probe → new code without reload:content", async () => {
    const t = await make();
    t.mock.setScenario({ codeExpiredAtPoll: 1 });
    const first = codeOf(await t.request("login"));
    t.ctx.current.onRequest("probe");
    await t.run(until(() => {
      const st = t.ctx.state.login?.state();
      return st?.phase === "code" && st.userCode !== first;
    }));
    assert.deepEqual(actions(t), []);
  });

  it("a rejected code (denied) while login is current → reload:content, then a fresh code", async () => {
    const t = await make();
    const first = codeOf(await t.request("login"));
    t.mock.setScenario({ rules: [{ path: "^/oauth2/device$", status: 400, times: 1 }] });
    await t.run(until(() => actions(t).includes("reload:content")));
    assert.equal(t.ctx.state.login?.state().phase, "error");
    const next = codeOf(await t.request("login"));
    assert.ok(next !== undefined && next !== first);
    assert.equal(t.ctx.state.login?.state().phase, "code");
  });

  it("the code request fails → reason, code and «Повторить»; the retry gets a code", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/oauth2/device$", status: 502, times: 1 }] });
    const s = await t.request("login");
    assert.equal(s.flag, "login");
    assert.equal(codeOf(s), undefined);
    assert.ok(texts(s).includes("KinoPub не отвечает{br}Код: KP-5XX"), JSON.stringify(texts(s)));
    assert.deepEqual(buttons(s), [
      { label: "Повторить", action: RETRY },
      { label: "Диагностика", action: `content:request:interaction:probe@${TEST_P}` },
    ]);
    const again = await t.request("login");
    assert.equal(codeOf(again), mockCodes(t)[0]);
  });

  // Этап 33b: API заблокирован по SNI (упал VPN) — TLS-рукопожатие висит. Раньше «Нет связи» ждали таймаут OAuth 15 с.
  it("the code request hangs → «Нет связи … Проверьте VPN» (KP-NET) after 6 s, not after the OAuth timeout", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/oauth2/device$", hang: true }] });
    const t0 = t.clock.perf();
    const s = await t.request("login");
    assert.equal(t.clock.perf() - t0, 6000);
    assert.equal(s.flag, "login");
    assert.equal(codeOf(s), undefined);
    assert.ok(texts(s).includes("Нет связи с KinoPub. Проверьте VPN{br}Код: KP-NET"), JSON.stringify(texts(s)));
    assert.deepEqual(buttons(s)[0], { label: "Повторить", action: RETRY });
    assert.equal(codeGrants(t), 1);
  });

  it("a code that comes after the verdict (slow but alive network) replaces the error by reload:content", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/oauth2/device$", hang: true, times: 1 }] });
    assert.equal(codeOf(await t.request("login")), undefined);
    t.mock.release();
    const reloaded = (): boolean => actions(t).includes("reload:content");
    await t.run((async () => {
      for (let i = 0; i < 300 && !reloaded(); i++) await realSleep(10);
    })());
    assert.ok(reloaded(), "the late code redraws the current login screen");
    assert.equal(codeOf(await t.request("login")), mockCodes(t)[0]);
    assert.equal(codeGrants(t), 1, "the late code is shown, not a new one");
  });

  it("two requests at once share one code", async () => {
    const t = await make();
    const [a, b] = (await t.run(Promise.all([t.app.handleRequest("login", {}), t.app.handleRequest("login", {})]))) as MsxContentRoot[];
    assert.equal(mockCodes(t).length, 1);
    assert.equal(codeOf(a as MsxContentRoot), mockCodes(t)[0]);
    assert.equal(codeOf(b as MsxContentRoot), mockCodes(t)[0]);
  });

  it("when already logged in: no code request, a button to refresh the menu", async () => {
    const t = await make({ loggedIn: true });
    const s = await loginScreen(t.ctx);
    assert.equal(t.mock.calls().length, 0);
    assert.equal(t.ctx.state.login, undefined);
    assert.ok(texts(s).some((x) => x.includes("Вход выполнен")));
    assert.ok(buttons(s).some((b) => b.action === REFRESH_MENU));
  });
});

describe("onLoginAct", () => {
  it("«new» gives a new code and reloads the current login screen", async () => {
    const t = await make();
    const first = codeOf(await t.request("login"));
    await t.run(onLoginAct(t.ctx, "new", []));
    assert.deepEqual(actions(t), ["reload:content"]);
    const next = codeOf(await t.request("login"));
    assert.ok(next !== undefined && next !== first);
    assert.equal(next, mockCodes(t).at(-1));
  });

  it("«new» from the router message act:login:new", async () => {
    const t = await make();
    const first = codeOf(await t.request("login"));
    t.app.handleData({ message: "act:login:new" });
    await t.run(until(() => actions(t).includes("reload:content")));
    const st = t.ctx.state.login?.state();
    assert.ok(st?.phase === "code" && st.userCode !== first);
  });

  it("«new» without a flow (plugin reloaded) just reloads the login screen", async () => {
    const t = await make();
    t.ctx.current.onRequest("login");
    await t.run(onLoginAct(t.ctx, "new", []));
    assert.deepEqual(actions(t), ["reload:content"]);
    assert.equal(t.mock.calls().length, 0);
  });

  it("unknown names are ignored", async () => {
    const t = await make();
    await t.run(onLoginAct(t.ctx, "nope", []));
    assert.deepEqual(actions(t), []);
    assert.equal(t.mock.calls().length, 0);
  });
});
