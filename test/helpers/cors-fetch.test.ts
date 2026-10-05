import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { startMock } from "../../tools/kpmock/server.ts";
import type { MockServer } from "../../tools/kpmock/server.ts";
import { createCorsFetch } from "./cors-fetch.ts";

const ORIGIN = "https://example.github.io";

describe("createCorsFetch against kpmock", () => {
  let mock: MockServer;

  before(async () => {
    mock = await startMock({ port: 0 });
  });
  after(async () => {
    await mock.close();
  });
  beforeEach(() => {
    mock.reset();
  });

  it("lets a simple GET through with Origin and hides non-safelisted response headers", async () => {
    const lines: string[] = [];
    const f = createCorsFetch({ origin: ORIGIN, log: (l) => lines.push(l) });
    const r = await f(`${mock.url}/v1/types`, { mode: "cors", credentials: "omit" });
    assert.equal(r.status, 401);
    assert.equal(r.type, "cors");
    assert.deepEqual(await r.json(), { status: 401, error: "unauthorized" });
    assert.match(r.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(r.headers.get("access-control-allow-origin"), null);
    assert.equal(r.headers.get("www-authenticate"), null);
    assert.equal(r.headers.get("server"), null);
    assert.equal(f.preflights, 0);
    const calls = mock.calls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].origin, ORIGIN);
    assert.ok(lines.length > 0);
  });

  it("sends a POST with a URLSearchParams body without a preflight", async () => {
    const f = createCorsFetch({ origin: ORIGIN });
    const r = await f(`${mock.url}/v1/nothing`, { method: "POST", body: new URLSearchParams({ a: "1" }) });
    assert.equal(r.status, 404);
    assert.equal(f.preflights, 0);
    assert.deepEqual(mock.calls().map((c) => c.method), ["POST"]);
  });

  it("preflights a request with Authorization; mock answers 405 → TypeError, the request itself is not sent", async () => {
    const f = createCorsFetch({ origin: ORIGIN });
    await assert.rejects(f(`${mock.url}/v1/types`, { headers: { Authorization: "Bearer t" } }), (e: unknown) => {
      assert.ok(e instanceof TypeError);
      assert.equal(e.message, "Failed to fetch");
      return true;
    });
    assert.equal(f.preflights, 1);
    const calls = mock.calls();
    assert.deepEqual(calls.map((c) => c.method), ["OPTIONS"]);
    assert.equal(calls[0].hasAuthHeader, false, "a preflight never carries the header itself");
  });

  it("preflights a POST with a JSON Content-Type", async () => {
    const f = createCorsFetch({ origin: ORIGIN });
    await assert.rejects(
      f(`${mock.url}/v1/device/notify`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }),
      TypeError,
    );
    assert.equal(f.preflights, 1);
  });

  it("rejects a response without Access-Control-Allow-Origin (corsOff) after the server got the request", async () => {
    mock.setScenario({ corsOff: true });
    const f = createCorsFetch({ origin: ORIGIN });
    await assert.rejects(f(`${mock.url}/v1/types`, {}), TypeError);
    assert.equal(f.preflights, 0);
    assert.deepEqual(mock.calls().map((c) => `${c.method} ${c.path} ${c.status}`), ["GET /v1/types 401"]);
  });

  it("turns 429 without CORS headers (noCorsErrors) into TypeError", async () => {
    mock.setScenario({ noCorsErrors: true, rules: [{ path: "^/v1/types$", status: 429 }] });
    const f = createCorsFetch({ origin: ORIGIN });
    await assert.rejects(f(`${mock.url}/v1/types`, {}), TypeError);
  });

  it("no-cors gives an opaque response even without CORS headers", async () => {
    mock.setScenario({ corsOff: true });
    const f = createCorsFetch({ origin: ORIGIN });
    const r = await f(`${mock.url}/v1/types?access_token=x`, { mode: "no-cors", credentials: "omit" });
    assert.equal(r.type, "opaque");
    assert.equal(r.status, 0);
    assert.equal(r.ok, false);
    assert.equal(await r.text(), "");
    assert.equal(f.preflights, 0);
    assert.deepEqual(mock.calls().map((c) => `${c.method} ${c.path}?${c.query}`), ["GET /v1/types?access_token=x"]);
  });

  it("a dropped connection is TypeError in both modes", async () => {
    mock.setScenario({ rules: [{ path: ".*", drop: true }] });
    const f = createCorsFetch({ origin: ORIGIN });
    await assert.rejects(f(`${mock.url}/v1/types`, {}), TypeError);
    await assert.rejects(f(`${mock.url}/v1/types`, { mode: "no-cors" }), TypeError);
  });

  it("no-cors refuses a non-simple method or header like a browser", async () => {
    const f = createCorsFetch({ origin: ORIGIN });
    await assert.rejects(f(`${mock.url}/v1/types`, { mode: "no-cors", method: "PUT" }), TypeError);
    await assert.rejects(f(`${mock.url}/v1/types`, { mode: "no-cors", headers: { "X-Kp": "1" } }), TypeError);
    assert.equal(mock.calls().length, 0);
  });

  it("an abort stays an AbortError, not a TypeError", async () => {
    mock.setScenario({ delayMs: 300 });
    const f = createCorsFetch({ origin: ORIGIN });
    const ac = new AbortController();
    const p = f(`${mock.url}/v1/types`, { signal: ac.signal });
    ac.abort();
    await assert.rejects(p, (e: unknown) => (e as { name?: string }).name === "AbortError");
  });
});

describe("createCorsFetch against a server that accepts preflights like production", () => {
  let server: Server;
  let url = "";
  const seen: string[] = [];

  before(async () => {
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.headers["access-control-request-headers"] ?? ""}`);
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "*",
      };
      if (req.method === "OPTIONS") {
        res.writeHead(200, cors);
        res.end();
        return;
      }
      res.writeHead(200, { ...cors, "content-type": "application/json", "x-hidden": "1" });
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it("Allow-Headers: * covers a custom header", async () => {
    const f = createCorsFetch({ origin: ORIGIN });
    const r = await f(`${url}/v1/types`, { headers: { "X-Kp": "1" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-hidden"), null);
    assert.equal(f.preflights, 1);
  });

  it("Allow-Headers: * does not cover Authorization (spec §5.2)", async () => {
    seen.length = 0;
    const f = createCorsFetch({ origin: ORIGIN });
    await assert.rejects(f(`${url}/v1/types`, { headers: { Authorization: "Bearer t" } }), TypeError);
    assert.deepEqual(seen, ["OPTIONS authorization"]);
  });

  it("credentials: include with ACAO * fails the CORS check", async () => {
    const f = createCorsFetch({ origin: ORIGIN });
    await assert.rejects(f(`${url}/v1/types`, { credentials: "include" }), TypeError);
  });
});
