// Сборка плагина в статику для GitHub Pages: app/app.js (IIFE с библиотекой TVX), app/index.html, start.json (спец. §15.2–§15.4).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild, formatMessages } from "esbuild";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const TVX_VERSION = "0.0.79";

const DEFAULTS = {
  SITE_ORIGIN: "http://127.0.0.1:8080",
  BASE_PATH: "/",
  API_BASE: "https://api.service-kp.com",
  API_FALLBACK_BASE: "https://api.srvkp.com",
  DEBUG_HOOKS: "0",
  HEARTBEAT_TICKS: "60",
  OUT_DIR: "dist",
  SOURCE_URL: "",
};

function param(opts, env, key) {
  const v = opts[key] ?? env[key];
  return v === undefined ? DEFAULTS[key] : String(v);
}

function parseUrl(name, value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name}: not a URL: ${JSON.stringify(value)}`);
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash) {
    throw new Error(`${name}: expected http(s) URL without credentials, query or hash: ${JSON.stringify(value)}`);
  }
  return u;
}

export function siteOrigin(value) {
  const u = parseUrl("SITE_ORIGIN", value);
  if (u.pathname !== "/") throw new Error(`SITE_ORIGIN must be an origin without a path (use BASE_PATH): ${value}`);
  return u.origin; // URL приводит схему и хост к нижнему регистру (CM-04, CD-16)
}

export function apiBase(name, value) {
  const u = parseUrl(name, value);
  return u.origin + u.pathname.replace(/\/+$/, "");
}

export function basePath(value) {
  const parts = value.split("/").filter(Boolean);
  for (const p of parts) {
    if (!/^[A-Za-z0-9._~-]+$/.test(p) || p === "." || p === "..") throw new Error(`BASE_PATH: bad segment ${JSON.stringify(p)}`);
  }
  return parts.length ? `/${parts.join("/")}/` : "/";
}

function flag(name, value) {
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off|)$/i.test(value)) return false;
  throw new Error(`${name}: expected 0 or 1, got ${JSON.stringify(value)}`);
}

function positiveInt(name, value) {
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name}: expected a positive integer, got ${JSON.stringify(value)}`);
  return n;
}

export function csp(apiBases) {
  const connect = [...new Set(apiBases.map((u) => new URL(u).origin))].join(" ");
  return `default-src 'none'; script-src 'self'; connect-src ${connect}; img-src data:; style-src 'unsafe-inline'`;
}

const escapeAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const jsonInner = (s) => JSON.stringify(s).slice(1, -1);

async function fill(templatePath, vars) {
  const text = await readFile(join(ROOT, templatePath), "utf8");
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in vars)) throw new Error(`${templatePath}: unknown placeholder {{${key}}}`);
    return vars[key];
  });
}

/**
 * Собирает плагин в OUT_DIR. Параметры берутся из opts, затем из env (по умолчанию process.env), затем DEFAULTS.
 * @param {import("./build.d.mts").BuildOptions} [opts]
 * @returns {Promise<import("./build.d.mts").BuildResult>}
 */
export async function build(opts = {}) {
  const env = opts.env ?? process.env;
  const get = (key) => param(opts, env, key);

  const origin = siteOrigin(get("SITE_ORIGIN"));
  const base = basePath(get("BASE_PATH"));
  const api = apiBase("API_BASE", get("API_BASE"));
  const apiFallback = apiBase("API_FALLBACK_BASE", get("API_FALLBACK_BASE"));
  const debugHooks = flag("DEBUG_HOOKS", get("DEBUG_HOOKS"));
  const heartbeatTicks = positiveInt("HEARTBEAT_TICKS", get("HEARTBEAT_TICKS"));
  const sourceUrl = get("SOURCE_URL").trim();
  if (/\*\/|[\r\n]/.test(sourceUrl)) throw new Error(`SOURCE_URL must not contain "*/" or line breaks`);
  const outDir = resolve(get("OUT_DIR"));
  const entry = resolve(ROOT, opts.ENTRY ?? "src/main.ts");

  const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  const version = String(pkg.version);
  const pluginUrl = `${origin}${base}app/index.html`;
  const info = { version, apiBase: api, apiFallbackBase: apiFallback, debugHooks, heartbeatTicks };
  const banner = [`KinoPub MSX v${version}`, "GPL-3.0-or-later", sourceUrl, `includes TVX Plugin v${TVX_VERSION} (c) Benjamin Zachey, GPL-3.0-or-later`]
    .filter(Boolean)
    .join(" | ");

  const result = await esbuild({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    outfile: join(outDir, "app/app.js"),
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: true,
    charset: "utf8", // кириллица UI байтами UTF-8, а не \uXXXX: меньше бандл (CNFR-15); index.html объявляет UTF-8
    legalComments: "none",
    banner: { js: `/*! ${banner} */` },
    define: { __KP_BUILD__: JSON.stringify(info) },
    write: false,
    logLevel: "silent",
  });
  // Предупреждение esbuild — почти всегда поломка бандла: например, UMD-библиотека TVX, прочитанная как ES-модуль,
  // даёт import-is-undefined и tvx.PluginTools === undefined (см. vendor/SOURCE.md).
  if (result.warnings.length > 0) {
    const text = await formatMessages(result.warnings, { kind: "warning", color: false });
    throw new Error(`esbuild warnings are treated as errors:\n${text.join("")}`);
  }

  const js = Buffer.from(result.outputFiles[0].contents);
  const hash = createHash("sha256").update(js).digest("hex").slice(0, 10);
  const html = await fill("public/app/index.html.tmpl", {
    CSP: escapeAttr(csp([api, apiFallback])),
    APP_SRC: escapeAttr(`app.js?v=${hash}`),
  });
  const start = await fill("public/start.json.tmpl", {
    VERSION: jsonInner(version),
    PARAMETER: jsonInner(`menu:request:interaction:init@${pluginUrl}`),
  });
  JSON.parse(start);

  const files = {
    "app/app.js": js,
    "app/index.html": html,
    "start.json": start,
    "msx/start.json": start,
    ".nojekyll": "",
    "build-info.json": JSON.stringify({ version, hash }) + "\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    const path = join(outDir, rel);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }
  return { hash, outDir, files: Object.keys(files), pluginUrl };
}

if (import.meta.main) {
  try {
    const res = await build();
    console.log(`build ${res.hash} → ${relative(process.cwd(), res.outDir) || "."}/`);
    for (const f of res.files) console.log(`  ${f}`);
    console.log(`plugin: ${res.pluginUrl}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}
