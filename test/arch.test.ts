import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Архитектурные запреты для src/**/*.ts (план §0.2, этап 16; спец. §3.5, §5.2, CM-05).

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** Комментарии вырезаются (строки и шаблоны остаются): правила — про код, а не про его описание. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface ImportRef { spec: string; typeOnly: boolean }

function importsOf(code: string): ImportRef[] {
  const out: ImportRef[] = [];
  const stmt = /\b(import|export)\s+(type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?["']([^"']+)["']/g;
  for (const m of code.matchAll(stmt)) out.push({ spec: m[3] as string, typeOnly: m[2] !== undefined });
  for (const m of code.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) out.push({ spec: m[1] as string, typeOnly: false });
  return out;
}

const TIME_FILES = new Set(["src/core/clock.ts", "src/main.ts"]);
/**
 * Пробник в app.js (этап 23b): остальной src/probe/ попадает только в probe.js. Значением из src/probe/ app.js
 * импортирует только lazy.ts, а lazy.ts — только store.ts (замеры запуска); probe.js не берёт lazy.ts себе —
 * копия загрузчика в probe.js была бы со своим состоянием.
 */
const PROBE_LAZY = "src/probe/lazy.ts";
const PROBE_FROM_LAZY = new Set(["src/probe/store.ts"]);

function probeImportViolation(path: string, imp: ImportRef): string | undefined {
  if (imp.typeOnly || !imp.spec.startsWith(".")) return undefined;
  const target = posix.normalize(posix.join(posix.dirname(path), imp.spec));
  if (!target.startsWith("src/probe/") || target === path) return undefined;
  const inProbe = path.startsWith("src/probe/");
  if (!inProbe && target !== PROBE_LAZY) return `probe module in app.js ${imp.spec}`;
  if (path === PROBE_LAZY && !PROBE_FROM_LAZY.has(target)) return `probe module in app.js ${imp.spec}`;
  if (inProbe && path !== PROBE_LAZY && target === PROBE_LAZY) return `lazy.ts in probe.js ${imp.spec}`;
  return undefined;
}

/** Нарушения одного файла `src/…` (путь относительно корня, через `/`). */
function violations(path: string, text: string): string[] {
  const code = stripComments(text);
  const found: string[] = [];
  for (const imp of importsOf(code)) {
    if (imp.spec.startsWith("node:")) found.push(`node import ${imp.spec}`);
    if (/(^|\/)vendor\//.test(imp.spec)) {
      const ok = path === "src/main.ts" || (path === "src/bridge/tvx-handler.ts" && imp.typeOnly);
      if (!ok) found.push(`vendor import ${imp.spec}${imp.typeOnly ? " (type)" : ""}`);
    }
    const probe = probeImportViolation(path, imp);
    if (probe !== undefined) found.push(probe);
  }
  if (code.includes("Authorization")) found.push("Authorization");
  if (code.includes("TVXServices")) found.push("TVXServices");
  // `ctx.probe` ставит probe.js при загрузке (этап 23b): до неё в app.js его нет.
  if (!path.startsWith("src/probe/") && /\bctx\s*\.\s*probe\b/.test(code)) found.push("ctx.probe outside probe.js");
  if (code.includes("localStorage") && path !== "src/main.ts") found.push("localStorage");
  if (!TIME_FILES.has(path)) {
    if (/\bDate\s*\.\s*now\s*\(/.test(code)) found.push("Date.now(");
    if (/\bperformance\s*\.\s*now\s*\(/.test(code)) found.push("performance.now(");
    // clock.setTimeout( и this.clock.setTimeout( — через Clock, разрешено; голый и глобальный setTimeout( — нет.
    if (/(^|[^.\w$])setTimeout\s*\(|\b(?:window|globalThis|self)\s*\.\s*setTimeout\s*\(/.test(code)) found.push("setTimeout(");
  }
  return found;
}

function srcFiles(dir = join(ROOT, "src")): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(p));
    else if (e.name.endsWith(".ts")) out.push(relative(ROOT, p).split("\\").join("/"));
  }
  return out.sort();
}

describe("architecture rules: the checker itself", () => {
  const v = (path: string, text: string): string[] => violations(path, text);

  it("ignores comments but not strings", () => {
    assert.deepEqual(v("src/a.ts", "// localStorage Date.now()\n/* Authorization */ const x = 1;"), []);
    assert.deepEqual(v("src/a.ts", 'const h = "Authorization";'), ["Authorization"]);
    assert.deepEqual(v("src/a.ts", 'const u = "https://x/"; window.localStorage;'), ["localStorage"]);
  });

  it("node: imports in any form", () => {
    assert.deepEqual(v("src/a.ts", 'import { x } from "node:fs";'), ["node import node:fs"]);
    assert.deepEqual(v("src/a.ts", 'import type { X } from "node:http";'), ["node import node:http"]);
    assert.deepEqual(v("src/a.ts", 'const m = await import("node:fs");'), ["node import node:fs"]);
  });

  it("vendor: only main.ts, and tvx-handler.ts with import type", () => {
    const imp = 'import * as tvx from "../vendor/tvx-plugin-module.min.js";';
    const typeImp = 'import type { AnyObject } from "../../vendor/tvx-plugin-module.min.js";';
    const valueImp = 'import { InteractionPlugin } from "../../vendor/tvx-plugin-module.min.js";';
    assert.deepEqual(v("src/main.ts", imp), []);
    assert.deepEqual(v("src/bridge/tvx-handler.ts", typeImp), []);
    assert.equal(v("src/bridge/tvx-handler.ts", valueImp).length, 1);
    assert.equal(v("src/screens/menu.ts", typeImp).length, 1);
    assert.equal(v("src/app/x.ts", 'import {\n  a,\n  b,\n} from "../../vendor/tvx-plugin-module.min.js";').length, 1);
  });

  it("time and timers only through Clock", () => {
    assert.deepEqual(v("src/a.ts", "const t = Date.now();"), ["Date.now("]);
    assert.deepEqual(v("src/a.ts", "const t = performance.now();"), ["performance.now("]);
    assert.deepEqual(v("src/a.ts", "setTimeout(f, 1);"), ["setTimeout("]);
    assert.deepEqual(v("src/a.ts", "window.setTimeout(f, 1);"), ["setTimeout("]);
    assert.deepEqual(v("src/a.ts", "globalThis.setTimeout(f, 1);"), ["setTimeout("]);
    assert.deepEqual(v("src/a.ts", "this.clock.setTimeout(f, 1); ctx.clock.setTimeout(f, 2); this.d.clock.setTimeout(f, 3);"), []);
    assert.deepEqual(v("src/core/clock.ts", "setTimeout(f, 1); Date.now(); performance.now();"), []);
    assert.deepEqual(v("src/main.ts", "const t0 = performance.now();"), []);
  });

  it("TVXServices (CM-05)", () => {
    assert.deepEqual(v("src/a.ts", "TVXServices.storage.get('x');"), ["TVXServices"]);
  });

  it("probe modules stay in probe.js: app.js imports only probe/lazy.ts by value (stage 23b)", () => {
    assert.deepEqual(v("src/router/router.ts", 'import { withProbe } from "../probe/lazy.ts";'), []);
    assert.deepEqual(v("src/app/context.ts", 'import type { ProbeRunner } from "../probe/runner.ts";'), []);
    assert.deepEqual(v("src/router/router.ts", 'import { probeScreen } from "../probe/screens.ts";'), [
      "probe module in app.js ../probe/screens.ts",
    ]);
    assert.deepEqual(v("src/probe/lazy.ts", 'import { coldOnReady } from "./store.ts";\nimport type * as E from "./entry.ts";'), []);
    assert.deepEqual(v("src/probe/lazy.ts", 'import { install } from "./entry.ts";'), ["probe module in app.js ./entry.ts"]);
    assert.deepEqual(v("src/probe/screens.ts", 'import { gridBegin } from "./tv-checks.ts";'), []);
    assert.deepEqual(v("src/probe/screens.ts", 'import { probeModule } from "./lazy.ts";'), ["lazy.ts in probe.js ./lazy.ts"]);
    assert.deepEqual(v("src/router/router.ts", "ctx.probe.onReady();"), ["ctx.probe outside probe.js"]);
    assert.deepEqual(v("src/probe/screens.ts", "ctx.probe.results(); s.probe;"), []);
  });
});

describe("architecture rules: src/**/*.ts", () => {
  const files = srcFiles();

  it("finds the source tree", () => {
    assert.ok(files.includes("src/main.ts"));
    assert.ok(files.includes("src/bridge/tvx-handler.ts"));
  });

  for (const file of files) {
    it(file, () => {
      assert.deepEqual(violations(file, readFileSync(join(ROOT, file), "utf8")), []);
    });
  }

  it("the vendor library is imported by main.ts (runtime) and tvx-handler.ts (types)", () => {
    const vendorImports = (file: string): ImportRef[] =>
      importsOf(stripComments(readFileSync(join(ROOT, file), "utf8"))).filter((i) => i.spec.includes("vendor/"));
    assert.deepEqual(vendorImports("src/main.ts").map((i) => i.typeOnly), [false]);
    assert.deepEqual(vendorImports("src/bridge/tvx-handler.ts").map((i) => i.typeOnly), [true]);
  });
});
