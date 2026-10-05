import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanFiles, scanText, type AllowEntry } from "../../tools/privacy.mjs";

// Этот файл тоже проходит `npm run privacy`, поэтому образцы нарушений склеиваются во время выполнения.
const s = (...parts: string[]): string => parts.join("");
const TOKEN = s("access_token=", "abcdefghijklmnopqrstu");
const REFRESH_JSON = s('{"refresh_token": "', "abcdefghijklmnopqrstuvwxyz", '"}');
const PRIVATE_IP = s("10.0.", "0.5");
const HOME_MAC = s("/Us", "ers/someone/x");
const HOME_LINUX = s("/ho", "me/someone/.config");

const rules = (path: string, text: string, allow?: AllowEntry[]): string[] => scanText(path, text, allow).map((v) => v.rule);

describe("scanText: token", () => {
  it("catches a 20+ character access_token in a query", () => {
    const v = scanText("docs/a.md", `GET /v1/types?${TOKEN}&x=1`);
    assert.deepEqual(v, [{ path: "docs/a.md", line: 1, rule: "token", match: TOKEN }]);
  });

  it("catches a 20+ character refresh_token in JSON", () => {
    assert.deepEqual(rules("a.json", REFRESH_JSON), ["token"]);
  });

  it("ignores short and synthetic mock tokens", () => {
    assert.deepEqual(rules("a.ts", "access_token=x"), []);
    assert.deepEqual(rules("a.ts", "?access_token=mock-at-12&refresh_token=mock-rt-12"), []);
  });
});

describe("scanText: ipv4", () => {
  it("catches a private IPv4", () => {
    assert.deepEqual(scanText("a.md", `host ${PRIVATE_IP}:80`), [{ path: "a.md", line: 1, rule: "ipv4", match: PRIVATE_IP }]);
  });

  it("allows loopback, 0.0.0.0 and documentation ranges", () => {
    for (const ip of ["127.0.0.1", "0.0.0.0", "192.0.2.15", "198.51.100.7", "203.0.113.10"]) {
      assert.deepEqual(rules("a.md", `addr ${ip}.`), [], ip);
    }
  });

  it("ignores three-part versions and numbers that are not addresses", () => {
    assert.deepEqual(rules("a.md", "MSX 0.1.165+, Node 26.5.0, Chrome/120.0.6099.109, 999.1.1.1, 1.2.3.4.5"), []);
  });

  it("ignores 0.0.0.0/8, which also covers four-part versions like v0.0.79.1", () => {
    assert.deepEqual(rules("vendor/SOURCE.md", "types v0.0.79.1, 0.1.2.3"), []);
  });
});

describe("scanText: home-path", () => {
  it("catches macOS and Linux home directories", () => {
    assert.deepEqual(scanText("a.md", `see ${HOME_MAC}`), [{ path: "a.md", line: 1, rule: "home-path", match: s("/Us", "ers/someone/") }]);
    assert.deepEqual(rules("a.sh", `cd ${HOME_LINUX}`), ["home-path"]);
  });

  it("ignores placeholders and URL paths", () => {
    assert.deepEqual(rules("a.md", "/Users/<имя>/ and https://example.com/home/page/"), []);
  });
});

describe("scanText: storage-clear", () => {
  it("catches .clear( in src/", () => {
    assert.deepEqual(rules("src/x.ts", "localStorage.clear();"), ["storage-clear"]);
    assert.deepEqual(rules("src/a/b.ts", "cache.clear ()"), ["storage-clear"]);
  });

  it("ignores .clear( outside src/", () => {
    assert.deepEqual(rules("vendor/x.js", "localStorage.clear();"), []);
    assert.deepEqual(rules("test/src/x.ts", "map.clear();"), []);
  });
});

describe("scanText: reports", () => {
  it("catches any file under reports/", () => {
    assert.deepEqual(scanText("reports/a.txt", "hello"), [{ path: "reports/a.txt", line: 0, rule: "reports", match: "reports/a.txt" }]);
    assert.deepEqual(rules("e2e/reports/run.json", "{}"), ["reports"]);
  });

  it("ignores mentions of reports/ in text and similarly named files", () => {
    assert.deepEqual(rules(".gitignore", "reports/\n*.log\n"), []);
    assert.deepEqual(rules("docs/reports.md", "x"), []);
  });
});

describe("scanText: allowlist and line numbers", () => {
  it("reports 1-based line numbers", () => {
    const v = scanText("a.md", `one\ntwo\nip ${PRIVATE_IP}\n`);
    assert.equal(v[0]?.line, 3);
  });

  it("an allowlist entry for the same file and match suppresses the violation", () => {
    const allow: AllowEntry[] = [{ file: "docs/a.md", match: PRIVATE_IP, reason: "test" }];
    assert.deepEqual(rules("docs/a.md", `ip ${PRIVATE_IP}`, allow), []);
    assert.deepEqual(rules("docs/b.md", `ip ${PRIVATE_IP}`, allow), ["ipv4"]);
  });
});

describe("scanFiles", () => {
  const root = mkdtempSync(join(tmpdir(), "kp-privacy-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name: string, body: string | Buffer): void => {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), body);
  };

  it("scans text files, skips binary and > 2 MB files, still flags reports/ paths", () => {
    put("docs/a.md", `ok\n${TOKEN}\n`);
    put("media/clip.webm", Buffer.concat([Buffer.from([0x1a, 0x45, 0x00]), Buffer.from(PRIVATE_IP)]));
    put("big.txt", `${PRIVATE_IP}\n${"x".repeat(2 * 1024 * 1024)}`);
    put("reports/run.bin", Buffer.from([0x00, 0x01]));
    const v = scanFiles(root, ["docs/a.md", "media/clip.webm", "big.txt", "reports/run.bin", "deleted.txt"]);
    assert.deepEqual(
      v.map((x) => [x.path, x.line, x.rule]),
      [
        ["docs/a.md", 2, "token"],
        ["reports/run.bin", 0, "reports"],
      ],
    );
  });

  it("applies the allowlist", () => {
    put("docs/ip.md", `x ${PRIVATE_IP}\n`);
    assert.deepEqual(scanFiles(root, ["docs/ip.md"], [{ file: "docs/ip.md", match: PRIVATE_IP, reason: "test" }]), []);
  });
});
