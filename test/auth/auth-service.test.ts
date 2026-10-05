import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { kp, q } from "../api/kpapi-rig.ts";
import { FAKE_EPOCH } from "../helpers/fake-clock.ts";
import { VERSION, useAuthMock } from "./auth-rig.ts";

// AuthService против kpmock: single-flight refresh (CC-03), отказ и обрыв refresh, проактивное продление,
// device/notify при смене версии, выход (спец. §7.1–7.3, §5.3).

describe("AuthService (spec §7.3, CC-03)", () => {
  const env = useAuthMock();

  describe("access token source", () => {
    it("isLoggedIn/access follow the stored pair", () => {
      const out = env.authRig();
      assert.equal(out.auth.isLoggedIn(), false);
      assert.equal(out.auth.access(), undefined);
      const r = env.authRig({ login: true });
      assert.equal(r.auth.isLoggedIn(), true);
      const pair = r.tokens.pair();
      assert.deepEqual(r.auth.access(), { token: pair?.access, gen: 1 });
    });
  });

  describe("single-flight refresh", () => {
    it("CC-03: expire-access, then 10 parallel api.items() → exactly one /oauth2/token, all 10 succeed", async () => {
      const r = env.authRig({ login: true });
      const before = r.tokens.pair();
      await env.control("/__mock/expire-access");
      const pages = await r.run(Promise.all(Array.from({ length: 10 }, () => r.api.items({ page: 1, perpage: 2 }))));
      assert.equal(pages.length, 10);
      assert.ok(pages.every((p) => p.items.length === 2));
      assert.equal(env.calls("/oauth2/token").length, 1);
      const items = env.calls("/v1/items");
      assert.equal(items.filter((c) => c.status === 401).length, 10);
      assert.equal(items.filter((c) => c.status === 200).length, 10);
      const after = r.tokens.pair();
      assert.equal(after?.gen, 2);
      assert.notEqual(after?.access, before?.access);
      assert.ok(items.filter((c) => c.status === 200).every((c) => q(c).get("access_token") === after?.access));
      assert.deepEqual(r.loggedOut, []);
    });

    it("concurrent refresh(gen) calls share one request; the pair is saved before the promise settles", async () => {
      const r = env.authRig({ login: true });
      const p1 = r.auth.refresh(1);
      const p2 = r.auth.refresh(1);
      const seen: (number | undefined)[] = [];
      const p3 = p1.then(() => seen.push(r.tokens.pair()?.gen));
      await r.run(Promise.all([p1, p2, p3]));
      assert.deepEqual(seen, [2]);
      assert.equal(env.calls("/oauth2/token").length, 1);
    });

    it("refresh(gen) with an outdated gen resolves without a request (someone already rotated the pair)", async () => {
      const r = env.authRig({ login: true });
      await r.run(r.auth.refresh(1));
      await r.run(r.auth.refresh(1));
      assert.equal(env.calls("/oauth2/token").length, 1);
      assert.equal(r.tokens.pair()?.gen, 2);
    });

    it("refreshInvalid → KP-AUTH, kp.auth.* is empty, onLoggedOut('refresh-rejected')", async () => {
      const r = env.authRig({ login: true });
      r.tokens.saveDevice({ id: 1, notifiedVersion: VERSION, title: "MSX T" });
      env.mock().setScenario({ refreshInvalid: true });
      await env.control("/__mock/expire-access");
      await assert.rejects(r.run(r.api.user()), kp("KP-AUTH", 400));
      assert.deepEqual(env.authKeys(r), []);
      assert.equal(r.auth.isLoggedIn(), false);
      assert.deepEqual(r.loggedOut, ["refresh-rejected"]);
      assert.equal(env.calls("/oauth2/token").length, 1);
      assert.equal(env.calls("/v1/user").length, 1, "the request is not retried after a rejected refresh");
    });

    it("dropped /oauth2/token → KP-NET, the same tokens, no automatic retry; the next 401 refreshes again", async () => {
      const r = env.authRig({ login: true });
      const before = r.tokens.pair();
      env.mock().setScenario({ rules: [{ path: "^/oauth2/token$", drop: true, times: 1 }] });
      await env.control("/__mock/expire-access");
      await assert.rejects(r.run(r.api.user()), kp("KP-NET"));
      assert.deepEqual(r.tokens.pair(), before);
      assert.equal(env.calls("/oauth2/token").length, 1, "refresh is never retried automatically (CM-01)");
      assert.deepEqual(r.loggedOut, []);

      const user = await r.run(r.api.user());
      assert.equal(user.username, "tester");
      assert.equal(env.calls("/oauth2/token").length, 2);
      assert.equal(r.tokens.pair()?.gen, 2);
    });

    it("refresh without a pair → KP-AUTH without a request", async () => {
      const r = env.authRig();
      await assert.rejects(r.run(r.auth.refresh(0)), kp("KP-AUTH"));
      assert.equal(env.calls().length, 0);
    });

    it("logout while a refresh is in flight: the rotated pair is not written back", async () => {
      const r = env.authRig({ login: true });
      // unlink оборван, поэтому mock не отзывает пару и refresh успевает её повернуть уже после выхода.
      env.mock().setScenario({ rules: [{ path: "^/oauth2/token$", delayMs: 50, times: 1 }, { path: "^/v1/device/unlink$", drop: true }] });
      const refreshing = r.auth.refresh(1);
      const loggingOut = r.auth.logout();
      await r.run(Promise.allSettled([refreshing, loggingOut]));
      assert.equal(env.calls("/oauth2/token")[0]?.status, 200);
      assert.equal(r.auth.isLoggedIn(), false);
      assert.deepEqual(env.authKeys(r), []);
      assert.deepEqual(r.loggedOut, ["logout"]);
    });
  });

  describe("proactive refresh (spec §7.3)", () => {
    it("ensureFreshFor(600): expiresAt in 5 min → refresh", async () => {
      const r = env.authRig({ login: true });
      const p = r.tokens.pair();
      assert.equal(p?.expiresAt, FAKE_EPOCH + 3570_000);
      await r.clock.advance(3570_000 - 5 * 60_000);
      await r.run(r.auth.ensureFreshFor(600));
      assert.equal(env.calls("/oauth2/token").length, 1);
      assert.equal(r.tokens.pair()?.gen, 2);
    });

    it("ensureFreshFor(600): expiresAt in 20 min → no refresh", async () => {
      const r = env.authRig({ login: true });
      await r.clock.advance(3570_000 - 20 * 60_000);
      await r.run(r.auth.ensureFreshFor(600));
      assert.equal(env.calls().length, 0);
    });

    it("ensureFreshFor: a network error does not throw and keeps the tokens", async () => {
      const r = env.authRig({ login: true });
      const before = r.tokens.pair();
      env.mock().setScenario({ rules: [{ path: "^/oauth2/token$", drop: true }] });
      await r.run(r.auth.ensureFreshFor(7200));
      assert.deepEqual(r.tokens.pair(), before);
      assert.equal(env.calls("/oauth2/token").length, 1);
    });

    it("ensureFreshFor: a rejected refresh throws KP-AUTH and logs out", async () => {
      const r = env.authRig({ login: true });
      env.mock().setScenario({ refreshInvalid: true });
      await assert.rejects(r.run(r.auth.ensureFreshFor(7200)), kp("KP-AUTH"));
      assert.deepEqual(r.loggedOut, ["refresh-rejected"]);
    });

    it("ensureFreshFor without login does nothing", async () => {
      const r = env.authRig();
      await r.run(r.auth.ensureFreshFor(600));
      assert.equal(env.calls().length, 0);
    });
  });

  describe("onReady (spec §7.1, research kinopub-api §10.5)", () => {
    it("another notifiedVersion → exactly one device/notify with the stored title; then not again", async () => {
      const r = env.authRig({ login: true });
      const info = await r.run(r.api.deviceInfo());
      r.tokens.saveDevice({ id: info.id, notifiedVersion: "0.9.0", title: "MSX UE55" });
      await r.run(r.auth.onReady());
      const notify = env.calls("/v1/device/notify");
      assert.equal(notify.length, 1);
      assert.equal(r.tokens.device().notifiedVersion, VERSION);
      const dev = env.mock().state.devices.get(info.id);
      assert.deepEqual([dev?.title, dev?.hardware, dev?.software], ["MSX UE55", "Samsung Tizen", `kpmsx-client/${VERSION}`]);
      await r.run(r.auth.onReady());
      assert.equal(env.calls("/v1/device/notify").length, 1);
      assert.equal(env.calls("/oauth2/token").length, 0, "the access token is fresh");
    });

    it("the same notifiedVersion → no requests at all", async () => {
      const r = env.authRig({ login: true });
      r.tokens.saveDevice({ id: 5, notifiedVersion: VERSION, title: "MSX T" });
      await r.run(r.auth.onReady());
      assert.equal(env.calls().length, 0);
    });

    it("refreshes first when the access token expires within 10 minutes", async () => {
      const r = env.authRig({ login: true });
      r.tokens.saveDevice({ id: 5, notifiedVersion: VERSION, title: "MSX T" });
      await r.clock.advance(3570_000 - 9 * 60_000);
      await r.run(r.auth.onReady());
      assert.deepEqual(env.calls().map((c) => c.path), ["/oauth2/token"]);
    });

    it("no device id (setup after login failed) → the full device setup is repeated", async () => {
      const r = env.authRig({ login: true });
      r.tokens.saveDevice({ title: "MSX UE55" });
      await r.run(r.auth.onReady());
      const id = r.tokens.device().id;
      assert.ok(id !== undefined && id > 0);
      assert.equal(r.tokens.device().notifiedVersion, VERSION);
      assert.equal(env.mock().state.devices.get(id)?.settings.mixedPlaylist, 1);
    });

    it("never throws: a rejected refresh is reported through onLoggedOut", async () => {
      const r = env.authRig({ login: true });
      env.mock().setScenario({ refreshInvalid: true });
      await r.clock.advance(3570_000);
      await r.run(r.auth.onReady());
      assert.deepEqual(r.loggedOut, ["refresh-rejected"]);
      assert.equal(env.calls("/v1/device/notify").length, 0);
    });

    it("without login does nothing", async () => {
      const r = env.authRig();
      await r.run(r.auth.onReady());
      assert.equal(env.calls().length, 0);
    });
  });

  describe("completeLogin (spec §7.1, Plan B §6.2.1)", () => {
    it("tokens → notify → info → device record → settings → verification", async () => {
      const r = env.authRig();
      const pair = { ...env.mock().issueToken(), expiresIn: 3600 };
      await r.run(r.auth.completeLogin(pair, "MSX QE65"));
      assert.equal(r.tokens.pair()?.access, pair.access);
      assert.deepEqual(env.calls().map((c) => `${c.method} ${c.path}`).map((s) => s.replace(/\/\d+\//, "/:id/")), [
        "POST /v1/device/notify", "GET /v1/device/info", "POST /v1/device/:id/settings", "GET /v1/device/info",
      ]);
      const dev = r.tokens.device();
      assert.equal(dev.notifiedVersion, VERSION);
      assert.equal(dev.title, "MSX QE65");
      const settings = env.mock().state.devices.get(dev.id ?? -1)?.settings;
      assert.deepEqual(settings && { ...settings }, { supportSsl: 1, supportHevc: 0, supportHdr: 0, support4k: 0, mixedPlaylist: 1 });
      assert.equal(r.log.entries().some((e) => e.level === "warn"), false);
    });

    it("failed steps after saving the tokens are logged and do not cancel the login", async () => {
      const r = env.authRig();
      env.mock().setScenario({ rules: [{ path: "^/v1/device/notify$", status: 500 }, { path: "^/v1/device/info$", drop: true }] });
      const pair = { ...env.mock().issueToken(), expiresIn: 3600 };
      await r.run(r.auth.completeLogin(pair, "MSX QE65"));
      assert.equal(r.auth.isLoggedIn(), true);
      assert.deepEqual(r.tokens.device(), { title: "MSX QE65" }, "neither id nor notifiedVersion: onReady will repeat the setup");
      assert.equal(env.calls("/v1/device/notify").length, 3, "notify is idempotent: auto retries 3 s, 6 s");
      assert.ok(r.log.entries().some((e) => e.level === "warn" && e.tag === "auth"));
    });

    it("settings that did not stick are reported with log.warn", async () => {
      const r = env.authRig();
      env.mock().setScenario({ rules: [{ path: "^/v1/device/\\d+/settings$", method: "POST", status: 200 }] });
      const pair = { ...env.mock().issueToken(), expiresIn: 3600 };
      await r.run(r.auth.completeLogin(pair, "MSX QE65"));
      const warn = r.log.entries().find((e) => e.level === "warn" && e.msg === "device_settings_mismatch");
      assert.ok(warn);
      assert.deepEqual(warn.data?.keys, ["mixedPlaylist"]);
    });

    it("a new login replaces the device record of the previous one", async () => {
      const r = env.authRig({ login: true });
      r.tokens.saveDevice({ id: 999_999, notifiedVersion: VERSION, title: "old" });
      const pair = { ...env.mock().issueToken(), expiresIn: 3600 };
      await r.run(r.auth.completeLogin(pair, "MSX new"));
      assert.notEqual(r.tokens.device().id, 999_999);
      assert.equal(r.tokens.pair()?.gen, 2);
    });
  });

  describe("logout", () => {
    it("unlink in the mock log, storage kp.auth.* is empty, onLoggedOut('logout')", async () => {
      const r = env.authRig({ login: true });
      r.tokens.saveDevice({ id: 1, notifiedVersion: VERSION, title: "MSX T" });
      r.store.set("cfg", "flags", { streamMode: "hls2" });
      const access = r.tokens.pair()?.access ?? "";
      await r.run(r.auth.logout());
      const unlink = env.calls("/v1/device/unlink");
      assert.equal(unlink.length, 1);
      assert.equal(q(unlink[0]).get("access_token"), access);
      assert.deepEqual(env.authKeys(r), []);
      assert.deepEqual(r.store.keys("cfg"), ["flags"]);
      assert.deepEqual(r.loggedOut, ["logout"]);
      assert.equal(env.mock().state.tokens.has(access), false, "the device and its tokens are gone in KinoPub");
    });

    it("an unlink error is ignored", async () => {
      const r = env.authRig({ login: true });
      env.mock().setScenario({ rules: [{ path: "^/v1/device/unlink$", drop: true }] });
      await r.run(r.auth.logout());
      assert.equal(env.calls("/v1/device/unlink").length, 1, "unlink is not retried");
      assert.deepEqual(env.authKeys(r), []);
      assert.deepEqual(r.loggedOut, ["logout"]);
    });

    it("after logout every API call is KP-AUTH without a request", async () => {
      const r = env.authRig({ login: true });
      await r.run(r.auth.logout());
      const n = env.calls().length;
      await assert.rejects(r.run(r.api.item(FIX.MOVIE_SIMPLE)), kp("KP-AUTH"));
      assert.equal(env.calls().length, n);
    });
  });

  it("no preflight in the whole file (CC-01)", () => {
    assert.equal(env.cors.preflights, 0);
  });
});
