import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Текстовые проверки .github/workflows/ci.yml (спец. §15.5, CM-03; финал — этап 35): YAML-парсера среди зависимостей нет.

const YML = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
const PKG = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  devDependencies: Record<string, string>;
  allowScripts?: Record<string, boolean>;
};

/** Блок верхнего уровня (`on:`, `jobs:`) или задачи (`  test:`) — до следующей строки с тем же или меньшим отступом. */
function block(text: string, header: string, indent: number): string {
  const lines = text.split("\n");
  const pad = " ".repeat(indent);
  const start = lines.findIndex((l) => l === `${pad}${header}:`);
  assert.notEqual(start, -1, `no "${pad}${header}:" in ci.yml`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.trim() !== "" && !l.startsWith(`${pad} `));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

const jobs = block(YML, "jobs", 0);
const job = (name: string): string => block(jobs, name, 2);
const runs = (text: string): string[] => [...text.matchAll(/^\s*- run: (.+)$/gm)].map((m) => m[1]?.trim() ?? "");

describe("ci.yml: triggers and permissions", () => {
  it("runs on push to main, pull requests and by hand with an optional `sha` input", () => {
    const on = block(YML, "on", 0);
    assert.match(on, /^ {2}push:\n {4}branches: \[main\]$/m);
    assert.match(on, /^ {2}pull_request:$/m);
    assert.match(on, /^ {2}workflow_dispatch:$/m);
    assert.match(on, /^ {6}sha:\n(?: {8}.+\n)*? {8}required: false$/m);
  });

  it("the manual run has boolean inputs `deploy` (on by default) and `e2e` (off by default)", () => {
    const inputs = block(block(YML, "on", 0), "inputs", 4);
    assert.deepEqual([...inputs.matchAll(/^ {6}(\w+):$/gm)].map((m) => m[1]), ["sha", "deploy", "e2e"]);
    for (const [name, value] of [["deploy", "true"], ["e2e", "false"]] as const) {
      const input = block(inputs, name, 6);
      assert.match(input, /^ {8}type: boolean$/m, name);
      assert.match(input, new RegExp(`^ {8}default: ${value}$`, "m"), name);
    }
  });

  it("the workflow token can only read contents by default", () => {
    assert.match(block(YML, "permissions", 0), /^permissions:\n {2}contents: read$/);
  });

  it("uses no secrets, tabs or unpinned actions", () => {
    assert.doesNotMatch(YML, /secrets\./);
    assert.doesNotMatch(YML, /\t/);
    for (const m of YML.matchAll(/uses: (\S+)/g)) assert.match(m[1] ?? "", /^actions\/[a-z-]+@v\d+$/);
  });
});

describe("ci.yml: job `test`", () => {
  const t = job("test");

  it("installs, then typecheck → test → crawl → privacy → build → size", () => {
    assert.deepEqual(runs(t), ["npm ci", "npm run typecheck", "npm test", "npm run crawl", "npm run privacy", "npm run build", "npm run size"]);
  });

  it("runs on every push and pull request: no condition", () => {
    assert.doesNotMatch(t, /^ {4}if:/m);
  });

  it("checks out the `sha` input or the triggering commit, on Node 26", () => {
    assert.match(t, /ref: \$\{\{ inputs\.sha \|\| github\.sha \}\}/);
    assert.match(t, /node-version: "26"/);
  });
});

describe("ci.yml: job `deploy` (CM-03)", () => {
  const d = job("deploy");

  it("waits for `test` and deploys only from main: on push, or by hand with `deploy` on; never from a pull request", () => {
    assert.match(d, /^ {4}needs: test$/m);
    const cond = d.match(/^ {4}if: (.+)$/m)?.[1] ?? "";
    assert.equal(
      cond,
      "github.ref == 'refs/heads/main' && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.deploy))",
    );
  });

  it("has exactly the Pages permissions: contents read, pages write, OIDC id-token", () => {
    const perms = block(d, "permissions", 4);
    assert.deepEqual(perms.split("\n").slice(1).map((l) => l.trim()), ["contents: read", "pages: write", "id-token: write"]);
  });

  it("deploys to the github-pages environment one run at a time", () => {
    assert.match(d, /environment:\n {6}name: github-pages\n {6}url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/);
    assert.match(d, /concurrency:\n {6}group: pages\n {6}cancel-in-progress: false/);
  });

  it("builds the `sha` input on Node 26 with the Pages origin and base path, checks size, uploads dist", () => {
    assert.match(d, /ref: \$\{\{ inputs\.sha \|\| github\.sha \}\}/);
    assert.match(d, /node-version: "26"/);
    assert.deepEqual(runs(d), ["npm ci", "npm run build", "npm run size"]);
    assert.match(d, /id: pages\n {8}uses: actions\/configure-pages@v5/);
    assert.match(d, /SITE_ORIGIN: \$\{\{ steps\.pages\.outputs\.origin \}\}/);
    assert.match(d, /BASE_PATH: \$\{\{ steps\.pages\.outputs\.base_path \}\}/);
    assert.match(d, /uses: actions\/upload-pages-artifact@v4\n {8}with:\n {10}path: dist$/m);
    assert.match(d, /id: deployment\n {8}uses: actions\/deploy-pages@v4/);
  });

  it("the steps go configure → build → size → upload → deploy", () => {
    const order = ["configure-pages", "npm run build", "npm run size", "upload-pages-artifact", "deploy-pages"].map((s) => d.indexOf(s));
    assert.ok(order.every((i) => i > 0), String(order));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });
});

describe("ci.yml: job `e2e` (spec §15.5: by hand)", () => {
  const e = job("e2e");

  it("runs only by hand with the `e2e` input on, independently of `test` and `deploy`", () => {
    assert.equal(e.match(/^ {4}if: (.+)$/m)?.[1], "github.event_name == 'workflow_dispatch' && inputs.e2e");
    assert.doesNotMatch(e, /^ {4}needs:/m);
    assert.doesNotMatch(e, /^ {4}permissions:/m, "the read-only token of the workflow is enough");
    assert.match(e, /^ {4}timeout-minutes: \d+$/m);
  });

  it("checks out the `sha` input on Node 26, installs Chromium with its system deps, runs npm run e2e", () => {
    assert.match(e, /ref: \$\{\{ inputs\.sha \|\| github\.sha \}\}/);
    assert.match(e, /node-version: "26"/);
    assert.deepEqual(runs(e), ["npm ci", "npx playwright install --with-deps chromium", "npm run e2e"]);
  });

  it("keeps the Playwright traces of a failed run as an artifact", () => {
    assert.match(e, /- if: failure\(\)\n {8}uses: actions\/upload-artifact@v4\n {8}with:\n(?: {10}.+\n)*? {10}path: test-results$/m);
  });
});

describe("ci.yml: npm cache", () => {
  it("every job sets up Node 26 with the npm cache", () => {
    for (const name of ["test", "deploy", "e2e"]) assert.match(job(name), /uses: actions\/setup-node@v5\n {8}with:\n {10}node-version: "26"\n {10}cache: npm$/m, name);
  });
});

describe("CI install", () => {
  it("package.json approves the esbuild install script at the pinned version (npm allowScripts)", () => {
    const version = PKG.devDependencies.esbuild;
    assert.ok(version);
    assert.deepEqual(PKG.allowScripts, { [`esbuild@${version}`]: true });
  });
});
