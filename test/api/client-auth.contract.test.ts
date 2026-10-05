import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ApiRequest } from "../../src/api/transport.ts";
import { KP_CLIENT } from "../../src/config/client.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { kp, q, useKpApiMock } from "./kpapi-rig.ts";

// Contract-тесты KpApi против kpmock: OAuth device flow и refresh, один повтор после 401,
// политика повторов и таймаутов по методам (спец. §5.2–5.3, план §0.6.5).

describe("KpApi OAuth, 401 and request policy (contract)", () => {
  const env = useKpApiMock();

  describe("oauth (query parameters, empty body, no access_token)", () => {
    it("deviceCode: interval string → number; client pair in query", async () => {
      const r = env.rig();
      const dc = await r.run(r.api.deviceCode());
      assert.match(dc.code, /^mock-dc-/);
      assert.match(dc.userCode, /^[A-Z]{6}$/);
      assert.equal(dc.verificationUri, "https://kino.watch/device");
      assert.equal(dc.interval, 5);
      assert.equal(dc.expiresIn, 600);
      const c = env.calls("/oauth2/device")[0];
      assert.equal(c.method, "POST");
      assert.equal(c.contentType, undefined, "empty body");
      assert.deepEqual([q(c).get("grant_type"), q(c).get("client_id"), q(c).get("client_secret")], ["device_code", KP_CLIENT.id, KP_CLIENT.secret]);
      const logged = JSON.stringify(r.log.entries());
      assert.equal(logged.includes(KP_CLIENT.secret), false);
      assert.equal(logged.includes(dc.code), false);
    });

    it("deviceToken: pending until the user enters the code, then ok", async () => {
      const r = env.rig();
      const { code } = await r.run(r.api.deviceCode());
      assert.deepEqual(await r.run(r.api.deviceToken(code)), { kind: "pending" });
      assert.deepEqual(await r.run(r.api.deviceToken(code)), { kind: "pending" });
      const ok = await r.run(r.api.deviceToken(code));
      assert.equal(ok.kind, "ok");
      assert.ok(ok.kind === "ok" && ok.pair.access.startsWith("mock-at-") && ok.pair.refresh.startsWith("mock-rt-") && ok.pair.expiresIn === 3600);
      const polls = env.calls("/oauth2/device").slice(1);
      assert.ok(polls.every((c) => q(c).get("grant_type") === "device_token" && q(c).get("code") === code));
    });

    it("deviceToken: slow_down, expired and denied", async () => {
      const r = env.rig();
      env.mock().setScenario({ slowDownAtPoll: 1, codeExpiredAtPoll: 2 });
      const { code } = await r.run(r.api.deviceCode());
      assert.deepEqual(await r.run(r.api.deviceToken(code)), { kind: "slow_down" });
      assert.deepEqual(await r.run(r.api.deviceToken(code)), { kind: "expired" });
      assert.deepEqual(await r.run(r.api.deviceToken("mock-dc-unknown")), { kind: "expired" });
      assert.deepEqual(await r.run(r.api.deviceToken("")), { kind: "denied" });
    });

    it("refreshToken rotates the pair; the old refresh is rejected with KP-AUTH", async () => {
      const r = env.rig();
      const old = r.tokens.pair?.refresh ?? "";
      const pair = await r.run(r.api.refreshToken(old));
      assert.notEqual(pair.access, r.tokens.pair?.access);
      const c = env.calls("/oauth2/token")[0];
      assert.deepEqual([q(c).get("grant_type"), q(c).get("client_id"), q(c).get("client_secret"), q(c).get("refresh_token")],
        ["refresh_token", KP_CLIENT.id, KP_CLIENT.secret, old]);
      assert.equal(c.contentType, undefined);
      await assert.rejects(r.run(r.api.refreshToken(old)), kp("KP-AUTH", 400));
    });

    it("refreshInvalid → KP-AUTH after exactly one call", async () => {
      env.mock().setScenario({ refreshInvalid: true });
      const r = env.rig();
      await assert.rejects(r.run(r.api.refreshToken(r.tokens.pair?.refresh ?? "")), kp("KP-AUTH"));
      assert.equal(env.calls("/oauth2/token").length, 1);
    });
  });

  describe("401 → one refresh → one retry", () => {
    it("expired access: refresh called once, the retry uses the new token and succeeds", async () => {
      const r = env.rig();
      await env.control("/__mock/expire-access");
      const old = r.tokens.pair?.access;
      const user = await r.run(r.api.user());
      assert.equal(user.username, "tester");
      assert.deepEqual(r.tokens.refreshCalls, [1]);
      assert.deepEqual(env.calls().map((c) => `${c.method} ${c.path} ${c.status}`), ["GET /v1/user 401", "POST /oauth2/token 200", "GET /v1/user 200"]);
      const [first, , retry] = env.calls();
      assert.equal(q(first).get("access_token"), old);
      assert.equal(q(retry).get("access_token"), r.tokens.pair?.access);
    });

    it("a second 401 is KP-AUTH; refresh is not repeated", async () => {
      const r = env.rig();
      r.tokens.repair = false;
      await env.control("/__mock/expire-access");
      await assert.rejects(r.run(r.api.items({ page: 1, perpage: 10 })), kp("KP-AUTH", 401));
      assert.deepEqual(r.tokens.refreshCalls, [1]);
      assert.equal(env.calls("/v1/items").length, 2);
    });

    it("a rejected refresh propagates; the request is not retried", async () => {
      env.mock().setScenario({ refreshInvalid: true });
      const r = env.rig();
      await env.control("/__mock/expire-access");
      await assert.rejects(r.run(r.api.mediaLinks(FIX.MOVIE_SIMPLE * 1000 + 1, "bg")), kp("KP-AUTH", 400));
      assert.equal(env.calls("/v1/items/media-links").length, 1);
    });

    it("no token → KP-AUTH without a request", async () => {
      const r = env.rig();
      r.tokens.pair = undefined;
      await assert.rejects(r.run(r.api.user()), kp("KP-AUTH"));
      assert.equal(env.calls().length, 0);
    });
  });

  describe("request policy (spec §5.2, §5.3; plan §0.6.5)", () => {
    it("retry, timeout and class per method", async () => {
      const r = env.rig();
      const mid = FIX.MOVIE_SIMPLE * 1000 + 1;
      const { code } = await r.run(r.api.deviceCode());
      await r.run(r.api.deviceToken(code));
      const info = await r.run(r.api.deviceInfo());
      await r.run(r.api.deviceNotify("t", "h", "s"));
      await r.run(r.api.deviceSettingsSave(info.id, { mixedPlaylist: 1 }));
      await r.run(r.api.items({ page: 1, perpage: 5 }));
      await r.run(r.api.item(FIX.MOVIE_SIMPLE));
      await r.run(r.api.mediaLinks(mid, "fg"));
      await r.run(r.api.mediaLinks(mid, "bg"));
      await r.run(r.api.marktime(FIX.MOVIE_SIMPLE, 1, 10));
      await r.run(r.api.toggle(FIX.MOVIE_SIMPLE, 1));
      const folder = await r.run(r.api.bookmarkCreate("x"));
      await r.run(r.api.bookmarkAdd(FIX.MOVIE_SIMPLE, folder.id));
      await r.run(r.api.bookmarkRemove(FIX.MOVIE_SIMPLE, folder.id));
      const rotated = await r.run(r.api.refreshToken(r.tokens.pair?.refresh ?? ""));
      r.tokens.pair = { access: rotated.access, refresh: rotated.refresh };
      await r.run(r.api.deviceUnlink());

      const row = (req: ApiRequest): string => `${req.method} ${req.path} ${req.retry} ${req.timeoutMs} ${req.cls}`;
      assert.deepEqual(r.t.reqs.map(row), [
        "POST /oauth2/device none 15000 fg",
        "POST /oauth2/device none 15000 fg",
        "GET /v1/device/info auto 8000 fg",
        "POST /v1/device/notify auto 8000 fg",
        `POST /v1/device/${info.id}/settings auto 8000 fg`,
        "GET /v1/items auto 8000 fg",
        `GET /v1/items/${FIX.MOVIE_SIMPLE} auto 15000 fg`,
        "GET /v1/items/media-links auto 6000 fg",
        "GET /v1/items/media-links auto 10000 bg",
        "GET /v1/watching/marktime auto 5000 fg",
        "GET /v1/watching/toggle none 5000 fg",
        "POST /v1/bookmarks/create none 8000 fg",
        "POST /v1/bookmarks/add auto 8000 fg",
        "POST /v1/bookmarks/remove-item auto 8000 fg",
        "POST /oauth2/token none 15000 fg",
        "POST /v1/device/unlink none 8000 fg",
      ]);
      for (const req of r.t.reqs.filter((x) => x.path.startsWith("/oauth2/"))) {
        assert.equal(req.form, undefined, "OAuth: empty body");
        assert.equal(req.query?.access_token, undefined);
      }
      assert.deepEqual(r.t.reqs[4].form, { mixedPlaylist: 1 });
    });
  });

  it("no preflight in the whole file (CC-01, CNFR-19)", () => {
    assert.equal(env.cors.preflights, 0);
  });
});
