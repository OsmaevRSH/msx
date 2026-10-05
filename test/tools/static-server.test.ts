import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveStatic, type StaticServer } from "../../tools/static-server.mjs";

describe("serveStatic", () => {
  const parent = mkdtempSync(join(tmpdir(), "kp-static-"));
  const dir = join(parent, "site");
  let srv: StaticServer;

  before(async () => {
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "app/index.html"), "<!DOCTYPE html>");
    writeFileSync(join(dir, "app/app.js"), "void 0;");
    writeFileSync(join(dir, "start.json"), "{}");
    writeFileSync(join(dir, "poster.svg"), "<svg/>");
    writeFileSync(join(dir, "clip.webm"), Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    writeFileSync(join(parent, "secret.txt"), "outside");
    srv = await serveStatic({ dir, port: 0 });
  });

  after(async () => {
    await srv.close();
    rmSync(parent, { recursive: true, force: true });
  });

  it("listens on a random port at 127.0.0.1 by default", () => {
    assert.match(srv.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(srv.url, "http://127.0.0.1:0");
  });

  for (const [path, type] of [
    ["/app/index.html", "text/html; charset=utf-8"],
    ["/app/app.js?v=0123456789", "text/javascript; charset=utf-8"],
    ["/start.json?v=1&t=2", "application/json; charset=utf-8"],
    ["/poster.svg", "image/svg+xml"],
    ["/clip.webm", "video/webm"],
  ] as const) {
    it(`GET ${path} → 200 ${type}, CORS *, no-cache`, async () => {
      const res = await fetch(srv.url + path);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), type);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      assert.equal(res.headers.get("cache-control"), "no-cache");
      await res.arrayBuffer();
    });
  }

  it("serves index.html for a directory path", async () => {
    const res = await fetch(`${srv.url}/app/`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "<!DOCTYPE html>");
  });

  it("redirects a directory path without a trailing slash", async () => {
    const res = await fetch(`${srv.url}/app`, { redirect: "manual" });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), "/app/");
    await res.arrayBuffer();
  });

  it("HEAD returns headers without a body", async () => {
    const res = await fetch(`${srv.url}/app/app.js`, { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-length"), "7");
    assert.equal(await res.text(), "");
  });

  it("missing files → 404 with CORS", async () => {
    const res = await fetch(`${srv.url}/nope.json`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    await res.arrayBuffer();
  });

  it("does not serve files outside dir", async () => {
    for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/app/..%2f..%2fsecret.txt"]) {
      const res = await fetch(srv.url + path);
      assert.notEqual(res.status, 200, path);
      assert.notEqual(await res.text(), "outside", path);
    }
  });

  it("rejects methods other than GET and HEAD", async () => {
    const res = await fetch(`${srv.url}/start.json`, { method: "POST", body: "x" });
    assert.equal(res.status, 405);
    await res.arrayBuffer();
  });
});
