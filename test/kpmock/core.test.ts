import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { startMock } from "../../tools/kpmock/server.ts";
import type { MockServer } from "../../tools/kpmock/server.ts";
import { HttpError, Router, requireAuth } from "../../tools/kpmock/router.ts";
import { DEFAULT_SCENARIO } from "../../tools/kpmock/scenario.ts";

const ACAO = "access-control-allow-origin";

describe("kpmock core server", () => {
  let mock: MockServer;
  const api = (path: string, init?: RequestInit): Promise<Response> => fetch(mock.url + path, init);
  const token = async (): Promise<string> => {
    const r = await api("/__mock/token", { method: "POST" });
    const body = (await r.json()) as { access: string; refresh: string; expires_in: number };
    assert.equal(body.expires_in, 3600);
    return body.access;
  };

  before(async () => {
    mock = await startMock({
      port: 0,
      extraRoutes: (r) => {
        r.add("POST", "/v1/test/echo", (ctx) => ({
          status: 200, json: { formAccepted: ctx.formAccepted, form: ctx.form ? Object.fromEntries(ctx.form) : null, base: ctx.base },
        }));
        r.add("GET", "/v1/test/whoami", (ctx) => ({ status: 200, json: { device: requireAuth(ctx).deviceId } }));
        r.add("GET", "/v1/test/teapot", () => { throw new HttpError(418, { status: 418, error: "teapot" }); });
      },
    });
  });
  after(async () => { await mock.close(); });
  beforeEach(() => { mock.reset(); });

  it("answers 401 without a token, with production-like CORS headers", async () => {
    const r = await api("/v1/types");
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { status: 401, error: "unauthorized" });
    assert.equal(r.headers.get(ACAO), "*");
    assert.equal(r.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
    assert.equal(r.headers.get("access-control-allow-headers"), "*");
    assert.equal(r.headers.get("www-authenticate"), 'Bearer realm="api"');
    assert.equal(r.headers.get("cache-control"), "private, no-store");
  });

  it("serves 7 types with a token from /__mock/token", async () => {
    const r = await api(`/v1/types?access_token=${await token()}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get(ACAO), "*");
    const body = (await r.json()) as { status: number; items: { id: string; title: string }[] };
    assert.equal(body.status, 200);
    assert.deepEqual(body.items.map((t) => t.id), ["movie", "serial", "3D", "concert", "documovie", "docuserial", "tvshow"]);
  });

  it("ignores the Authorization header (token only in query)", async () => {
    const t = await token();
    const r = await api("/v1/types", { headers: { Authorization: `Bearer ${t}` } });
    assert.equal(r.status, 401);
    assert.equal(mock.calls()[0].hasAuthHeader, true);
  });

  it("rejects any OPTIONS with 405 and no CORS, and logs it", async () => {
    const r = await api("/v1/items", { method: "OPTIONS" });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get(ACAO), null);
    const opts = mock.calls().filter((c) => c.method === "OPTIONS");
    assert.equal(opts.length, 1);
    assert.equal(opts[0].path, "/v1/items");
    assert.equal(opts[0].status, 405);
  });

  it("applies a rule with times and noCors to 5xx", async () => {
    mock.setScenario({ rules: [{ path: "^/v1/types", status: 502, times: 1, noCors: true }] });
    const t = await token();
    const first = await api(`/v1/types?access_token=${t}`);
    assert.equal(first.status, 502);
    assert.equal(first.headers.get(ACAO), null);
    assert.deepEqual(await first.json(), { status: 502, error: "mock" });
    const second = await api(`/v1/types?access_token=${t}`);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get(ACAO), "*");
  });

  it("drops the connection for a drop rule", async () => {
    mock.setScenario({ rules: [{ path: "^/v1/types", drop: true }] });
    await assert.rejects(api("/v1/types"), TypeError);
    assert.equal(mock.calls()[0].status, 0);
  });

  it("applies a rule only to the matching method", async () => {
    mock.setScenario({ rules: [{ path: "^/v1/types", method: "POST", status: 500 }] });
    assert.equal((await api("/v1/types")).status, 401);
  });

  it("rate-limits API requests with 429 (CORS kept unless noCorsErrors)", async () => {
    mock.setScenario({ rateLimit: { max: 2, windowMs: 1000 } });
    assert.equal((await api("/v1/types")).status, 401);
    assert.equal((await api("/v1/types")).status, 401);
    const third = await api("/v1/types");
    assert.equal(third.status, 429);
    assert.equal(third.headers.get(ACAO), "*");
  });

  it("drops CORS from 429/5xx only with noCorsErrors", async () => {
    mock.setScenario({ noCorsErrors: true, rateLimit: { max: 1, windowMs: 1000 }, rules: [{ path: "^/v1/items", status: 503 }] });
    const unauth = await api("/v1/types");
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get(ACAO), "*");
    const limited = await api("/v1/types");
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get(ACAO), null);
    const down = await api("/v1/items");
    assert.equal(down.status, 503);
    assert.equal(down.headers.get(ACAO), null);
  });

  it("removes all CORS headers with corsOff", async () => {
    mock.setScenario({ corsOff: true });
    const r = await api("/v1/types");
    assert.equal(r.status, 401);
    assert.equal(r.headers.get(ACAO), null);
    assert.equal(r.headers.get("access-control-allow-methods"), null);
  });

  it("counts concurrent requests", async () => {
    mock.setScenario({ delayMs: 100 });
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => api("/v1/types")));
    assert.deepEqual(rs.map((r) => r.status), [401, 401, 401, 401, 401]);
    assert.equal(mock.stats().maxInFlight, 5);
    const viaHttp = (await (await api("/__mock/stats")).json()) as { maxInFlight: number };
    assert.equal(viaHttp.maxInFlight, 5);
  });

  it("invalidates current access tokens on /__mock/expire-access", async () => {
    const t = await token();
    assert.equal((await api(`/v1/types?access_token=${t}`)).status, 200);
    const r = await api("/__mock/expire-access", { method: "POST" });
    assert.equal(r.status, 200);
    assert.equal((await api(`/v1/types?access_token=${t}`)).status, 401);
    assert.equal(mock.state.tokens.get(t)?.refresh.startsWith("mock-rt-"), true, "refresh stays usable");
  });

  it("issueToken() binds the token to a fresh device", async () => {
    const { access } = mock.issueToken();
    const r = await api(`/v1/test/whoami?access_token=${access}`);
    const body = (await r.json()) as { device: number };
    assert.ok(mock.state.devices.has(body.device));
  });

  it("journals method, path, full query, content type and origin", async () => {
    await api("/v1/types?access_token=x&a=1", { headers: { Origin: "http://127.0.0.1:8080" } });
    await api("/v1/test/echo?x=2", { method: "POST", body: new URLSearchParams({ k: "v" }) });
    const [get, post] = mock.calls();
    assert.deepEqual(
      { method: get.method, path: get.path, query: get.query, origin: get.origin, hasAuthHeader: get.hasAuthHeader, status: get.status },
      { method: "GET", path: "/v1/types", query: "access_token=x&a=1", origin: "http://127.0.0.1:8080", hasAuthHeader: false, status: 401 },
    );
    assert.equal(post.method, "POST");
    assert.match(post.contentType ?? "", /^application\/x-www-form-urlencoded/);
    assert.ok(get.t > 0);
  });

  it("parses the body only for application/x-www-form-urlencoded", async () => {
    const form = await (await api("/v1/test/echo", { method: "POST", body: new URLSearchParams({ title: "TV" }) })).json();
    assert.deepEqual(form, { formAccepted: true, form: { title: "TV" }, base: mock.url });
    const text = await (await api("/v1/test/echo", { method: "POST", body: "title=TV", headers: { "Content-Type": "text/plain" } })).json();
    assert.deepEqual(text, { formAccepted: false, form: null, base: mock.url });
  });

  it("maps HttpError to its status with CORS", async () => {
    const r = await api("/v1/test/teapot");
    assert.equal(r.status, 418);
    assert.equal(r.headers.get(ACAO), "*");
    assert.deepEqual(await r.json(), { status: 418, error: "teapot" });
  });

  it("answers 404 JSON with CORS for unknown API paths and 404 without CORS for CDN", async () => {
    const r = await api("/v1/nope");
    assert.equal(r.status, 404);
    assert.equal(r.headers.get(ACAO), "*");
    assert.deepEqual(await r.json(), { status: 404, error: "Not found" });
    const cdn = await api("/cdn/nope.m3u8");
    assert.equal(cdn.status, 404);
    assert.equal(cdn.headers.get(ACAO), null);
  });

  it("serves /__mock/* with ACAO and keeps it out of the journal", async () => {
    const r = await api("/__mock/calls");
    assert.equal(r.headers.get(ACAO), "*");
    assert.deepEqual(await r.json(), []);
    const s = await api("/__mock/scenario", { method: "POST", body: JSON.stringify({ delayMs: 5, pendingPolls: 4 }) });
    assert.equal(s.status, 200);
    const merged = (await s.json()) as { delayMs: number; pendingPolls: number; accessTtlSec: number };
    assert.deepEqual([merged.delayMs, merged.pendingPolls, merged.accessTtlSec], [5, 4, 3600]);
    assert.equal(mock.calls().length, 0);
    const bad = await api("/__mock/scenario", { method: "POST", body: "{" });
    assert.equal(bad.status, 400);
  });

  it("reset() clears the journal and the scenario", async () => {
    mock.setScenario({ delayMs: 50, corsOff: true, rules: [{ path: "^/", status: 500 }] });
    await api("/v1/types");
    assert.equal(mock.calls().length, 1);
    mock.reset();
    assert.equal(mock.calls().length, 0);
    assert.equal(mock.stats().maxInFlight, 0);
    const r = await api("/v1/types");
    assert.equal(r.status, 401);
    assert.equal(r.headers.get(ACAO), "*");
    const viaHttp = await api("/__mock/reset", { method: "POST" });
    assert.equal(viaHttp.status, 200);
    assert.equal(mock.calls().length, 0);
  });

  it("does not let setScenario() mutate the caller's rules", async () => {
    const rules = [{ path: "^/v1/types", status: 500, times: 1 }];
    mock.setScenario({ rules });
    await api("/v1/types");
    assert.equal(rules[0].times, 1);
    assert.deepEqual(DEFAULT_SCENARIO.rules, []);
  });
});

describe("kpmock router", () => {
  const h = (name: string) => () => ({ status: 200, text: name });

  it("extracts named params and prefers static routes over params", () => {
    const r = new Router();
    r.add("GET", "/v1/items/:id", h("item"));
    r.add("GET", "/v1/items/fresh", h("fresh"));
    r.add("GET", /^\/cdn\/hls\/(?<rest>.+)$/, h("hls"));
    const item = r.match("GET", "/v1/items/42");
    assert.deepEqual(item?.params, { id: "42" });
    assert.equal(r.match("GET", "/v1/items/fresh")?.handler, r.match("GET", "/v1/items/fresh")?.handler);
    assert.notEqual(r.match("GET", "/v1/items/fresh")?.handler, item?.handler);
    assert.deepEqual(r.match("GET", "/cdn/hls/a/b.m3u8")?.params, { rest: "a/b.m3u8" });
    assert.equal(r.match("POST", "/v1/items/42"), undefined);
    assert.equal(r.match("GET", "/v1/items/42/x"), undefined);
  });

  it("matches HEAD against GET routes and * against any method", () => {
    const r = new Router();
    r.add("GET", "/poster/:size/:file", h("poster"));
    r.add("*", "/v1/device/:id/settings", h("settings"));
    assert.deepEqual(r.match("HEAD", "/poster/medium/1000.svg")?.params, { size: "medium", file: "1000.svg" });
    assert.ok(r.match("POST", "/v1/device/7/settings"));
    assert.ok(r.match("GET", "/v1/device/7/settings"));
  });
});
