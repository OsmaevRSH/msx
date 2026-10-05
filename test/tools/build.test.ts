import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { build, type BuildOptions, type BuildResult } from "../../tools/build.mjs";

const VERSION = (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;

const tmpDirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `kp-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

// env: {} — сборка не должна зависеть от переменных окружения того, кто запускает тесты.
async function buildTo(opts: BuildOptions = {}): Promise<BuildResult> {
  return build({ env: {}, OUT_DIR: await tmp("build"), ...opts });
}

const read = (dir: string, file: string): string => readFileSync(join(dir, file), "utf8");
const sha10 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex").slice(0, 10);
const cspOf = (html: string): string => html.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1] ?? "";

after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("build: artefact layout", () => {
  let res: BuildResult;
  before(async () => {
    res = await buildTo({ SITE_ORIGIN: "https://Example.github.io", BASE_PATH: "/msx", SOURCE_URL: "https://github.com/u/msx" });
  });

  it("start.json points MSX at the absolute plugin URL with a lower-case host", () => {
    const start = JSON.parse(read(res.outDir, "start.json")) as Record<string, string>;
    assert.equal(start.parameter, "menu:request:interaction:init@https://example.github.io/msx/app/index.html");
    assert.deepEqual(start, { name: "KinoPub MSX", version: VERSION, parameter: start.parameter, welcome: "none" });
  });

  it("msx/start.json is identical to start.json", () => {
    assert.equal(read(res.outDir, "msx/start.json"), read(res.outDir, "start.json"));
  });

  it("index.html has exactly one external script app.js?v=<hash>, no inline scripts, < 1 KB", () => {
    const html = read(res.outDir, "app/index.html");
    const hash = sha10(readFileSync(join(res.outDir, "app/app.js")));
    assert.equal(res.hash, hash);
    assert.match(hash, /^[0-9a-f]{10}$/);
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? [];
    assert.deepEqual(scripts, [`<script src="app.js?v=${hash}"></script>`]);
    assert.equal((html.match(/<script/g) ?? []).length, 1);
    assert.ok(Buffer.byteLength(html) < 1024, `index.html is ${Buffer.byteLength(html)} bytes`);
  });

  it("app.js starts with the licence banner", () => {
    const js = read(res.outDir, "app/app.js");
    const banner =
      `/*! KinoPub MSX v${VERSION} | GPL-3.0-or-later | https://github.com/u/msx | ` +
      "includes TVX Plugin v0.0.79 (c) Benjamin Zachey, GPL-3.0-or-later */";
    assert.ok(js.startsWith(banner), js.slice(0, 200));
  });

  it("debug hooks are compiled out of a production build (no __kp global, no recording proxy)", async () => {
    assert.ok(!read(res.outDir, "app/app.js").includes("__kp"));
    const dev = await buildTo({ DEBUG_HOOKS: "1" });
    assert.ok(read(dev.outDir, "app/app.js").includes("__kp"));
  });

  it("writes .nojekyll and build-info.json, returns the file list", () => {
    assert.ok(existsSync(join(res.outDir, ".nojekyll")));
    assert.deepEqual(JSON.parse(read(res.outDir, "build-info.json")), { version: VERSION, hash: res.hash });
    assert.deepEqual(
      [...res.files].sort(),
      [".nojekyll", "app/app.js", "app/index.html", "build-info.json", "msx/start.json", "start.json"],
    );
  });
});

describe("build: CSP", () => {
  it("defaults: connect-src lists both production API origins, script-src 'self'", async () => {
    const res = await buildTo();
    assert.equal(
      cspOf(read(res.outDir, "app/index.html")),
      "default-src 'none'; script-src 'self'; connect-src https://api.service-kp.com https://api.srvkp.com; " +
        "img-src data:; style-src 'unsafe-inline'",
    );
  });

  it("API_BASE overrides the first connect-src origin", async () => {
    const res = await buildTo({ API_BASE: "http://127.0.0.1:8787" });
    assert.match(cspOf(read(res.outDir, "app/index.html")), /connect-src http:\/\/127\.0\.0\.1:8787 https:\/\/api\.srvkp\.com;/);
  });

  it("identical API origins are listed once", async () => {
    const res = await buildTo({ API_BASE: "http://127.0.0.1:8787", API_FALLBACK_BASE: "http://127.0.0.1:8787/" });
    assert.match(cspOf(read(res.outDir, "app/index.html")), /connect-src http:\/\/127\.0\.0\.1:8787;/);
  });
});

describe("build: parameters", () => {
  it("two builds in a row produce the same hash", async () => {
    const a = await buildTo();
    const b = await buildTo();
    assert.equal(a.hash, b.hash);
  });

  for (const [input, expected] of [
    ["", "/"],
    ["/", "/"],
    ["msx", "/msx/"],
    ["/msx/", "/msx/"],
    ["//a//b", "/a/b/"],
  ] as const) {
    it(`BASE_PATH ${JSON.stringify(input)} → ${expected}`, async () => {
      const res = await buildTo({ BASE_PATH: input });
      const start = JSON.parse(read(res.outDir, "start.json")) as { parameter: string };
      assert.equal(start.parameter, `menu:request:interaction:init@http://127.0.0.1:8080${expected}app/index.html`);
    });
  }

  it("reads parameters from env when opts do not set them", async () => {
    const res = await build({ OUT_DIR: await tmp("env"), env: { SITE_ORIGIN: "https://u.github.io", BASE_PATH: "/msx/" } });
    const start = JSON.parse(read(res.outDir, "start.json")) as { parameter: string };
    assert.equal(start.parameter, "menu:request:interaction:init@https://u.github.io/msx/app/index.html");
  });

  it("injects __KP_BUILD__ with typed values", async () => {
    const dir = await tmp("define");
    const entry = join(dir, "entry.ts");
    await writeFile(entry, "declare const __KP_BUILD__: unknown;\n(globalThis as any).kpBuild = __KP_BUILD__;\n");
    const res = await buildTo({ ENTRY: entry, API_BASE: "http://127.0.0.1:8787/", DEBUG_HOOKS: "1", HEARTBEAT_TICKS: "10" });
    const sandbox: { kpBuild?: unknown } = {};
    runInNewContext(read(res.outDir, "app/app.js"), sandbox);
    // JSON-круг: объект создан в другом realm (vm), у него чужой Object.prototype.
    assert.deepEqual(JSON.parse(JSON.stringify(sandbox.kpBuild)), {
      version: VERSION,
      apiBase: "http://127.0.0.1:8787",
      apiFallbackBase: "https://api.srvkp.com",
      debugHooks: true,
      heartbeatTicks: 10,
    });
  });

  it("defaults for __KP_BUILD__: debug hooks off, 60 ticks", async () => {
    const dir = await tmp("define0");
    const entry = join(dir, "entry.ts");
    await writeFile(entry, "declare const __KP_BUILD__: unknown;\n(globalThis as any).kpBuild = __KP_BUILD__;\n");
    const res = await buildTo({ ENTRY: entry });
    const sandbox: { kpBuild?: { debugHooks: boolean; heartbeatTicks: number; apiBase: string } } = {};
    runInNewContext(read(res.outDir, "app/app.js"), sandbox);
    assert.equal(sandbox.kpBuild?.debugHooks, false);
    assert.equal(sandbox.kpBuild?.heartbeatTicks, 60);
    assert.equal(sandbox.kpBuild?.apiBase, "https://api.service-kp.com");
  });

  it("rejects a SITE_ORIGIN with a path", async () => {
    await assert.rejects(buildTo({ SITE_ORIGIN: "https://u.github.io/msx" }), /SITE_ORIGIN/);
  });

  it("rejects a non-positive HEARTBEAT_TICKS", async () => {
    await assert.rejects(buildTo({ HEARTBEAT_TICKS: "0" }), /HEARTBEAT_TICKS/);
  });

  it("fails on esbuild warnings (a UMD library read as an ES module has no exports)", async () => {
    const dir = await tmp("umd");
    await writeFile(join(dir, "package.json"), '{ "type": "module" }\n');
    await writeFile(
      join(dir, "umd.js"),
      '(function(a,b){if(typeof module=="object"&&module.exports){module.exports=b()}else{a.lib=b()}}(this,function(){return{x:1}}));\n',
    );
    await writeFile(join(dir, "entry.ts"), 'import * as lib from "./umd.js";\n(globalThis as any).x = lib.x;\n');
    const out = await tmp("umd-out");
    await assert.rejects(build({ env: {}, OUT_DIR: out, ENTRY: join(dir, "entry.ts") }), /will always be undefined/);
    assert.equal(existsSync(join(out, "app/index.html")), false);
  });
});
