import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "../../tools/kpmock/server.ts";
import type { MockServer } from "../../tools/kpmock/server.ts";

const ACAO = "access-control-allow-origin";
const CLIENT = { client_id: "xbmc", client_secret: "cgg3gtifu46urtfp2zp1nqtba0k2ezxh" };

interface Reply { status: number; acao: string | null; body: Record<string, unknown> }
interface TokenBody { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: null }

describe("kpmock OAuth device flow", () => {
  let mock: MockServer;

  /** POST с параметрами в query (как у простого запроса без тела) или в форме URLSearchParams. */
  const post = async (path: string, params: Record<string, string>, via: "query" | "form" = "query"): Promise<Reply> => {
    const qs = new URLSearchParams(params);
    const r = via === "query"
      ? await fetch(`${mock.url}${path}?${qs}`, { method: "POST" })
      : await fetch(mock.url + path, { method: "POST", body: qs });
    return { status: r.status, acao: r.headers.get(ACAO), body: (await r.json()) as Record<string, unknown> };
  };
  const deviceCode = async (via: "query" | "form" = "query"): Promise<string> => {
    const r = await post("/oauth2/device", { grant_type: "device_code", ...CLIENT }, via);
    assert.equal(r.status, 200);
    return r.body.code as string;
  };
  const poll = (code: string, via: "query" | "form" = "query"): Promise<Reply> =>
    post("/oauth2/device", { grant_type: "device_token", code, ...CLIENT }, via);
  const refresh = (rt: string, path = "/oauth2/token", via: "query" | "form" = "query"): Promise<Reply> =>
    post(path, { grant_type: "refresh_token", refresh_token: rt, ...CLIENT }, via);
  const apiStatus = async (access: string): Promise<number> =>
    (await fetch(`${mock.url}/v1/types?access_token=${access}`)).status;
  /** Полный вход: опрашивать, пока не придёт пара. */
  const login = async (): Promise<TokenBody> => {
    const code = await deviceCode();
    for (let i = 0; i < 10; i++) {
      const r = await poll(code);
      if (r.status === 200) return r.body as unknown as TokenBody;
    }
    throw new Error("device flow did not finish");
  };

  before(async () => { mock = await startMock({ port: 0 }); });
  after(async () => { await mock.close(); });
  beforeEach(() => { mock.reset(); });

  it("issues a device code with string interval and 6-letter user code", async () => {
    const r = await post("/oauth2/device", { grant_type: "device_code", ...CLIENT });
    assert.equal(r.status, 200);
    assert.equal(r.acao, "*");
    assert.match(r.body.code as string, /^\S+$/);
    assert.match(r.body.user_code as string, /^[A-Z]{6}$/);
    assert.equal(r.body.verification_uri, "https://kino.watch/device");
    assert.equal(r.body.expires_in, 600);
    assert.equal(r.body.interval, "5");
    const other = await post("/oauth2/device", { grant_type: "device_code", ...CLIENT });
    assert.notEqual(other.body.code, r.body.code);
    assert.notEqual(other.body.user_code, r.body.user_code);
  });

  it("answers authorization_pending twice, then a token pair bound to a new device", async () => {
    const code = await deviceCode();
    for (let i = 0; i < 2; i++) {
      const r = await poll(code);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "authorization_pending");
    }
    const devicesBefore = mock.state.devices.size;
    const ok = await poll(code);
    assert.equal(ok.status, 200);
    const pair = ok.body as unknown as TokenBody;
    assert.equal(pair.token_type, "bearer");
    assert.equal(pair.expires_in, 3600);
    assert.equal(pair.scope, null);
    assert.match(pair.access_token, /^mock-at-\d+$/);
    assert.match(pair.refresh_token, /^mock-rt-\d+$/);
    assert.equal(mock.state.devices.size, devicesBefore + 1);
    const deviceId = mock.state.tokens.get(pair.access_token)?.deviceId;
    assert.ok(deviceId !== undefined && mock.state.devices.has(deviceId));
    assert.equal(await apiStatus(pair.access_token), 200);
    const again = await poll(code);
    assert.equal(again.status, 400);
    assert.equal(again.body.error, "code_expired", "a used code cannot be redeemed twice");
  });

  it("gives every activation its own device slot", async () => {
    const a = await login();
    const b = await login();
    const da = mock.state.tokens.get(a.access_token)?.deviceId;
    const db = mock.state.tokens.get(b.access_token)?.deviceId;
    assert.notEqual(da, db);
  });

  it("uses scenario pendingPolls and accessTtlSec", async () => {
    mock.setScenario({ pendingPolls: 0, accessTtlSec: 120 });
    const r = await poll(await deviceCode());
    assert.equal(r.status, 200);
    assert.equal(r.body.expires_in, 120);
  });

  it("answers slow_down on slowDownAtPoll", async () => {
    mock.setScenario({ slowDownAtPoll: 1 });
    const code = await deviceCode();
    const first = await poll(code);
    assert.equal(first.status, 400);
    assert.equal(first.body.error, "slow_down");
    assert.equal(first.acao, "*");
    assert.equal((await poll(code)).body.error, "authorization_pending");
    assert.equal((await poll(code)).status, 200);
  });

  it("answers code_expired on codeExpiredAtPoll and keeps the code dead", async () => {
    mock.setScenario({ codeExpiredAtPoll: 2 });
    const code = await deviceCode();
    assert.equal((await poll(code)).body.error, "authorization_pending");
    const expired = await poll(code);
    assert.equal(expired.status, 400);
    assert.equal(expired.body.error, "code_expired");
    assert.equal(expired.acao, "*");
    assert.equal((await poll(code)).body.error, "code_expired");
  });

  it("answers code_expired for an unknown code", async () => {
    const r = await poll("mock-dc-unknown");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "code_expired");
  });

  it("rotates the pair on refresh: old access → 401, old refresh → invalid_refresh_token", async () => {
    const old = await login();
    const r = await refresh(old.refresh_token);
    assert.equal(r.status, 200);
    assert.equal(r.acao, "*");
    const fresh = r.body as unknown as TokenBody;
    assert.notEqual(fresh.access_token, old.access_token);
    assert.notEqual(fresh.refresh_token, old.refresh_token);
    assert.equal(fresh.token_type, "bearer");
    assert.equal(fresh.expires_in, 3600);
    assert.equal(await apiStatus(old.access_token), 401);
    assert.equal(await apiStatus(fresh.access_token), 200);
    const reused = await refresh(old.refresh_token);
    assert.equal(reused.status, 400);
    assert.equal(reused.body.error, "invalid_refresh_token");
    assert.equal(reused.acao, "*");
    assert.equal((await refresh(fresh.refresh_token)).status, 200, "the new refresh works once");
  });

  it("keeps the device across refresh", async () => {
    const old = await login();
    const deviceId = mock.state.tokens.get(old.access_token)?.deviceId;
    const fresh = (await refresh(old.refresh_token)).body as unknown as TokenBody;
    assert.equal(mock.state.tokens.get(fresh.access_token)?.deviceId, deviceId);
  });

  it("refreshes an expired access token", async () => {
    const old = await login();
    mock.state.expireAllAccess();
    assert.equal(await apiStatus(old.access_token), 401);
    const r = await refresh(old.refresh_token);
    assert.equal(r.status, 200);
    assert.equal(await apiStatus((r.body as unknown as TokenBody).access_token), 200);
  });

  it("accepts grant_type=refresh_token on /oauth2/device", async () => {
    const old = await login();
    const r = await refresh(old.refresh_token, "/oauth2/device");
    assert.equal(r.status, 200);
    assert.equal(await apiStatus(old.access_token), 401);
  });

  it("rejects refresh with refreshInvalid and with an unknown token", async () => {
    const pair = await login();
    mock.setScenario({ refreshInvalid: true });
    const r = await refresh(pair.refresh_token);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "invalid_refresh_token");
    assert.equal(r.acao, "*");
    mock.setScenario({ refreshInvalid: false });
    assert.equal((await refresh("mock-rt-0")).body.error, "invalid_refresh_token");
  });

  it("rejects a wrong client_secret or a missing client with invalid_client", async () => {
    for (const [path, grant] of [["/oauth2/device", "device_code"], ["/oauth2/token", "refresh_token"]]) {
      const bad = await post(path, { grant_type: grant, client_id: "xbmc", client_secret: "wrong" });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, "invalid_client");
      assert.equal(bad.acao, "*");
      const none = await post(path, { grant_type: grant });
      assert.equal(none.body.error, "invalid_client");
    }
  });

  it("rejects an unknown grant_type", async () => {
    const r = await post("/oauth2/token", { grant_type: "password", ...CLIENT });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "unsupported_grant_type");
  });

  it("treats form and query parameters the same way", async () => {
    const code = await deviceCode("form");
    assert.equal((await poll(code, "form")).body.error, "authorization_pending");
    assert.equal((await poll(code, "query")).body.error, "authorization_pending");
    const ok = await poll(code, "form");
    assert.equal(ok.status, 200);
    const r = await refresh((ok.body as unknown as TokenBody).refresh_token, "/oauth2/token", "form");
    assert.equal(r.status, 200);
  });

  it("ignores a body with a wrong Content-Type (Apple trap)", async () => {
    const body = new URLSearchParams({ grant_type: "device_code", ...CLIENT }).toString();
    const r = await fetch(`${mock.url}/oauth2/device`, { method: "POST", body, headers: { "Content-Type": "text/plain" } });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as { error: string }).error, "invalid_client");
  });
});
