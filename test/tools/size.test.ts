import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS, checkSizes } from "../../tools/size.mjs";

const dirs: string[] = [];
function site(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), "kp-size-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, ".."), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

// Детерминированные «несжимаемые» байты: gzip почти не уменьшает их размер.
function noise(n: number): Buffer {
  const buf = Buffer.alloc(n);
  let x = 0x9e3779b9;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    buf[i] = x & 0xff;
  }
  return buf;
}

const HTML_OK = "<!DOCTYPE html><html></html>";
const PROBE_OK = "globalThis.kpProbe={}";

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("checkSizes", () => {
  it("small files pass and every checked file has a row", () => {
    const res = checkSizes(site({ "app/app.js": "console.log(1)", "app/index.html": HTML_OK, "app/probe.js": PROBE_OK }));
    assert.equal(res.ok, true);
    const js = res.rows.find((r) => r.file === "app/app.js");
    const html = res.rows.find((r) => r.file === "app/index.html");
    assert.equal(js?.bytes, 14);
    assert.ok((js?.gzip ?? 0) > 0);
    assert.deepEqual(js?.limit, { bytes: 256_000, gzip: 81_920 });
    assert.equal(html?.bytes, HTML_OK.length);
    assert.deepEqual(html?.limit, { bytes: 1023 });
  });

  it("app.js of 300 000 bytes fails", () => {
    const res = checkSizes(site({ "app/app.js": "a".repeat(300_000), "app/index.html": HTML_OK, "app/probe.js": PROBE_OK }));
    assert.equal(res.ok, false);
    const js = res.rows.find((r) => r.file === "app/app.js");
    assert.equal(js?.bytes, 300_000);
    assert.equal(js?.ok, false);
  });

  it("app.js within the byte limit but over the gzip limit fails", () => {
    const res = checkSizes(site({ "app/app.js": noise(200_000), "app/index.html": HTML_OK, "app/probe.js": PROBE_OK }));
    const js = res.rows.find((r) => r.file === "app/app.js");
    assert.ok((js?.gzip ?? 0) > 81_920, `gzip ${js?.gzip}`);
    assert.equal(res.ok, false);
  });

  it("app.js exactly at the limits passes", () => {
    const res = checkSizes(site({ "app/app.js": "a".repeat(256_000), "app/index.html": HTML_OK, "app/probe.js": PROBE_OK }));
    assert.equal(res.ok, true);
  });

  it("index.html must be smaller than 1024 bytes", () => {
    assert.equal(checkSizes(site({ "app/app.js": "x", "app/index.html": "a".repeat(1023), "app/probe.js": PROBE_OK })).ok, true);
    assert.equal(checkSizes(site({ "app/app.js": "x", "app/index.html": "a".repeat(1024), "app/probe.js": PROBE_OK })).ok, false);
  });

  it("a missing file fails", () => {
    const res = checkSizes(site({ "app/index.html": HTML_OK, "app/probe.js": PROBE_OK }));
    assert.equal(res.ok, false);
    assert.equal(res.rows.find((r) => r.file === "app/app.js")?.missing, true);
  });

  it("probe.js has its own budget (stage 23b): over it fails, a missing probe.js fails", () => {
    const limit = LIMITS["app/probe.js"];
    assert.ok(limit !== undefined && limit.gzip !== undefined);
    const ok = checkSizes(site({ "app/app.js": "x", "app/index.html": HTML_OK, "app/probe.js": "a".repeat(limit.bytes) }));
    assert.equal(ok.ok, true);
    const over = checkSizes(site({ "app/app.js": "x", "app/index.html": HTML_OK, "app/probe.js": "a".repeat(limit.bytes + 1) }));
    assert.equal(over.ok, false);
    assert.equal(over.rows.find((r) => r.file === "app/probe.js")?.ok, false);
    const zipped = checkSizes(site({ "app/app.js": "x", "app/index.html": HTML_OK, "app/probe.js": noise(limit.gzip + 1024) }));
    assert.equal(zipped.ok, false);
    const missing = checkSizes(site({ "app/app.js": "x", "app/index.html": HTML_OK }));
    assert.equal(missing.rows.find((r) => r.file === "app/probe.js")?.missing, true);
  });

  it("app.js keeps the CNFR-15 budget", () => {
    assert.deepEqual(LIMITS["app/app.js"], { bytes: 256_000, gzip: 81_920 });
  });
});
