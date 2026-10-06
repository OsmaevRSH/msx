import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(new URL(path, root))).digest("hex");

const VENDOR_FILES = ["tvx-plugin-module.min.js", "tvx-plugin-module.min.d.ts"];

const SCRIPTS: Record<string, string> = {
  test: 'node --test "test/**/*.test.ts"',
  typecheck: "tsc -p tsconfig.json",
  build: "node tools/build.mjs",
  size: "node tools/size.mjs",
  privacy: "node tools/privacy.mjs",
  mock: "node tools/kpmock/cli.ts --port 8787",
  "gen:media": "sh tools/gen-media.sh",
  dev: "node tools/dev.mjs",
  e2e: "playwright test -c e2e/playwright.config.ts",
  "tv-address": "node tools/tv-address.mjs",
  crawl: "node tools/crawl.ts",
};
const CHECK_PREFIX = "npm run typecheck && npm test && npm run privacy && npm run build && npm run size";

function sourceHash(sourceMd: string, file: string): string | undefined {
  const line = sourceMd.split("\n").find((l) => l.includes(`\`${file}\``) && /\b[0-9a-f]{64}\b/.test(l));
  return line?.match(/\b[0-9a-f]{64}\b/)?.[0];
}

describe("vendor TVX library", () => {
  it("first comment line names TVX Plugin v0.0.79", () => {
    const js = read("vendor/tvx-plugin-module.min.js");
    assert.ok(js.startsWith("/*"), "file must start with a block comment");
    const firstLine = js
      .slice(2, js.indexOf("*/"))
      .split("\n")
      .map((l) => l.replace(/^\s*\*?\s*/, "").trim())
      .find((l) => l.length > 0);
    assert.match(firstLine ?? "", /TVX Plugin v0\.0\.79\b/);
  });

  it("is bundled as CommonJS (UMD wrapper), not as an ES module", () => {
    const pkg = JSON.parse(read("vendor/package.json")) as { type?: string };
    assert.equal(pkg.type, "commonjs");
  });

  for (const file of VENDOR_FILES) {
    it(`SHA-256 of ${file} matches vendor/SOURCE.md`, () => {
      const expected = sourceHash(read("vendor/SOURCE.md"), file);
      assert.ok(expected, `vendor/SOURCE.md has no SHA-256 for ${file}`);
      assert.equal(sha256(`vendor/${file}`), expected);
    });
  }
});

describe("package.json", () => {
  const pkg = JSON.parse(read("package.json")) as { license?: string; scripts?: Record<string, string> };

  it("is licensed GPL-3.0-or-later", () => {
    assert.equal(pkg.license, "GPL-3.0-or-later");
  });

  it("declares every project script", () => {
    for (const [name, cmd] of Object.entries(SCRIPTS)) {
      assert.equal(pkg.scripts?.[name], cmd, `script "${name}"`);
    }
    // С этапа 32 `check` заканчивается краулером (план §0.4).
    assert.equal(pkg.scripts?.check, `${CHECK_PREFIX} && npm run crawl`);
  });
});
