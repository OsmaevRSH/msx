import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { formatTvAddress, tvAddress } from "../../tools/tv-address.mjs";

const CLI = fileURLToPath(new URL("../../tools/tv-address.mjs", import.meta.url));

describe("tvAddress: variant A (repo «msx», spec §15.2)", () => {
  it("a login without a hyphen is typed as <login>.github.io in lower case, no warnings", () => {
    assert.deepEqual(tvAddress("Alice"), {
      variant: "A",
      input: "alice.github.io",
      startJsonUrl: "https://alice.github.io/msx/start.json",
      aliasTarget: "https://alice.github.io/msx/start.json",
      warnings: [],
    });
  });

  it("repo defaults to «msx»", () => {
    assert.deepEqual(tvAddress("alice", "msx"), tvAddress("alice"));
  });

  it("a hyphen in the login warns about TV input and names the is.gd fallback (CM-04)", () => {
    const r = tvAddress("my-login");
    assert.equal(r.variant, "A");
    assert.equal(r.input, "my-login.github.io");
    assert.equal(r.aliasTarget, "https://my-login.github.io/msx/start.json");
    assert.equal(r.warnings.length, 1);
    const w = r.warnings[0] ?? "";
    assert.match(w, /дефис/);
    assert.match(w, /заглавн/);
    assert.ok(w.includes("https://is.gd"));
    assert.ok(w.includes("id:igd:"));
    assert.ok(w.includes("[0-9a-z]"));
    assert.ok(w.includes("https://my-login.github.io/msx/start.json"));
    assert.ok(w.includes("podkop"));
  });

  it("a user-site repo <login>.github.io serves /msx/start.json at the root: same input as A", () => {
    const r = tvAddress("Alice", "alice.github.io");
    assert.equal(r.variant, "A");
    assert.equal(r.input, "alice.github.io");
    assert.equal(r.startJsonUrl, "https://alice.github.io/msx/start.json");
  });
});

describe("tvAddress: variant B (another repo name)", () => {
  it("always goes through an is.gd alias to /<repo>/msx/start.json", () => {
    const r = tvAddress("bob", "kp");
    assert.equal(r.variant, "B");
    assert.equal(r.input, "id:igd:<alias>");
    assert.equal(r.aliasTarget, "https://bob.github.io/kp/msx/start.json");
    assert.equal(r.startJsonUrl, r.aliasTarget);
    assert.deepEqual(r.warnings, []);
  });

  it("the repo name keeps its case, the host is lower case", () => {
    assert.equal(tvAddress("Bob", "KinoPub").aliasTarget, "https://bob.github.io/KinoPub/msx/start.json");
  });

  it("«MSX» is variant B: MSX looks up the lower-case /msx/start.json, the alias does not depend on case", () => {
    assert.equal(tvAddress("bob", "MSX").variant, "B");
  });
});

describe("tvAddress: input validation", () => {
  for (const login of ["", "-bob", "bob-", "bo--b", "bo_b", "bob.x", "a".repeat(40), "bob/kp"]) {
    it(`rejects login ${JSON.stringify(login)}`, () => {
      assert.throws(() => tvAddress(login), /login/);
    });
  }
  for (const repo of ["", ".", "..", "a/b", "a b", "kp?x"]) {
    it(`rejects repo ${JSON.stringify(repo)}`, () => {
      assert.throws(() => tvAddress("bob", repo), /repo/);
    });
  }
  it("accepts the longest login (39 characters)", () => {
    assert.equal(tvAddress("a".repeat(39)).input, `${"a".repeat(39)}.github.io`);
  });
});

describe("formatTvAddress", () => {
  it("variant A: what to type with the lock, the check URL and the is.gd fallback", () => {
    const text = formatTvAddress(tvAddress("alice"));
    assert.ok(text.includes("Start Parameter"));
    assert.ok(text.includes("alice.github.io"));
    assert.match(text, /замок/);
    assert.ok(text.includes("https://alice.github.io/msx/start.json"));
    assert.ok(text.includes("id:igd:"));
    assert.doesNotMatch(text, /Внимание/);
  });

  it("variant A with a hyphen prints the warning", () => {
    const text = formatTvAddress(tvAddress("my-login"));
    assert.match(text, /Внимание/);
    assert.match(text, /дефис/);
  });

  it("variant B: the alias is the only way, no lock", () => {
    const text = formatTvAddress(tvAddress("bob", "kp"));
    assert.ok(text.includes("id:igd:<alias>"));
    assert.ok(text.includes("https://bob.github.io/kp/msx/start.json"));
    assert.ok(text.includes("https://is.gd"));
    assert.doesNotMatch(text, /замок/);
  });
});

describe("CLI", () => {
  it("prints the instruction for <login> [repo]", () => {
    const out = execFileSync(process.execPath, [CLI, "my-login"], { encoding: "utf8" });
    assert.ok(out.includes("my-login.github.io"));
    assert.ok(out.includes("https://my-login.github.io/msx/start.json"));
    assert.match(out, /дефис/);
    const outB = execFileSync(process.execPath, [CLI, "bob", "kp"], { encoding: "utf8" });
    assert.ok(outB.includes("https://bob.github.io/kp/msx/start.json"));
  });

  it("without a login prints usage and exits with 2", () => {
    const r = spawnSync(process.execPath, [CLI], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /npm run tv-address -- <login> \[repo\]/);
  });

  it("a bad login exits with 2 and says why", () => {
    const r = spawnSync(process.execPath, [CLI, "-bad"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /login/);
  });
});
