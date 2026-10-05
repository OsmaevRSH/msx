import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { build } from "../tools/build.mjs";

// Smoke настоящего бандла: app.js (src/main.ts + библиотека TVX) в песочнице с поддельным окном и родителем MSX.
// Протокол TVX — сообщения postMessage типа "interactionPlugin" (init: 1 → ready, {requestId, dataId} → response:<id>).
// probe.js (этап 23b) песочница грузит как браузер: `<script src>` относительно адреса плагина, затем onload/onerror.

const ORIGIN = "https://u.github.io";
const PATH = "/msx/app/index.html";
const P = ORIGIN + PATH;
const MSX = "http://msx.benzac.de";

let dir = "";
let js = "";
let probeJs = "";
let probeHash = "";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "kp-bundle-"));
  probeHash = (await build({ env: {}, OUT_DIR: dir })).probeHash;
  js = readFileSync(join(dir, "app/app.js"), "utf8");
  probeJs = readFileSync(join(dir, "app/probe.js"), "utf8");
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Posted { action: string; data: any }

interface Sandbox {
  posted: Posted[]; replaced: string[]; storage: Map<string, string>;
  /** Полные адреса `<script src>`, вставленных бандлом. */
  scripts: string[];
  send(data: unknown): void;
}

interface ScriptEl { src: string; onload: ((e: unknown) => void) | null; onerror: ((e: unknown) => void) | null; remove(): void }

/** Окно плагина; `inFrame: false` — страница открыта напрямую (window.top === window). */
function run(inFrame: boolean): Sandbox {
  const posted: Posted[] = [];
  const replaced: string[] = [];
  const scripts: string[] = [];
  const storage = new Map<string, string>();
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  // Таймеры бандла (сброс журнала раз в 30 с) не должны держать процесс теста.
  const timer = (fn: () => void, ms: number): NodeJS.Timeout => setTimeout(fn, ms).unref();
  const parent = { postMessage: (m: Posted) => posted.push(JSON.parse(JSON.stringify(m)) as Posted) };
  const win: Record<string, unknown> = {
    addEventListener: (t: string, f: (e: unknown) => void) => (listeners[t] ??= []).push(f),
    removeEventListener: () => {},
    parent,
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, String(v)),
      removeItem: (k: string) => storage.delete(k),
      key: (i: number) => [...storage.keys()][i] ?? null,
      get length() {
        return storage.size;
      },
    },
    fetch: async () => {
      throw new TypeError("Failed to fetch");
    },
    location: { origin: ORIGIN, pathname: PATH, protocol: "https:", href: P, search: "", hash: "", replace: (u: string) => replaced.push(u) },
    navigator: { userAgent: "node" },
    document: {
      readyState: "complete", addEventListener: () => {}, removeEventListener: () => {},
      createElement: (): ScriptEl => ({ src: "", onload: null, onerror: null, remove: () => {} }),
      // Как браузер: адрес относительно страницы плагина, файл с сайта (query сайт не различает), затем onload/onerror.
      head: {
        appendChild: (el: ScriptEl) => {
          const url = new URL(el.src, P);
          scripts.push(url.href);
          timer(() => {
            let code: string;
            try {
              code = readFileSync(join(dir, url.pathname.slice(PATH.lastIndexOf("/app/") + 1)), "utf8");
            } catch {
              el.onerror?.({});
              return;
            }
            runInContext(code, win);
            el.onload?.({});
          }, 5);
        },
      },
    },
    console, setTimeout: timer, clearTimeout, setInterval: (fn: () => void, ms: number) => setInterval(fn, ms).unref(), clearInterval, performance,
  };
  win.window = win;
  win.self = win;
  win.top = inFrame ? parent : win;
  createContext(win);
  runInContext(js, win);
  for (const f of listeners.load ?? []) f({});
  return {
    posted, replaced, storage, scripts,
    send: (data) => {
      for (const f of listeners.message ?? []) f({ data, origin: MSX, source: parent });
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

async function request(s: Sandbox, requestId: string, dataId: string): Promise<any> {
  s.send({ type: "interactionPlugin", data: { requestId, dataId, data: {} } });
  for (let i = 0; i < 50; i++) {
    const r = s.posted.find((m) => m.action === `response:${requestId}`);
    if (r) return r.data;
    await tick();
  }
  throw new Error(`no response to ${dataId}`);
}

describe("bundle app.js in an MSX-like sandbox", () => {
  it("opened directly (not in an iframe) → redirects to web MSX with this plugin", () => {
    const s = run(false);
    assert.deepEqual(s.replaced, [`https://msx.benzac.de/?start=menu:request:interaction:init@${P}`]);
    assert.equal(s.posted.length, 0);
  });

  it("in an iframe: interaction:init → ready asks MSX info → init answers the menu with @P", async () => {
    const s = run(true);
    assert.equal(s.posted[0]?.action, "interaction:init");
    s.send({ type: "interactionPlugin", init: 1, data: { info: { platform: "tizen" } } });
    await tick();
    assert.ok(s.posted.some((m) => m.action === "interaction:commit:info"), "ready() requests MSX info in the background");
    const menu = await request(s, "r1", "init");
    assert.ok(Array.isArray(menu.menu) && menu.menu.length > 0);
    for (const item of menu.menu) if (typeof item.data === "string") assert.ok(item.data.endsWith(`@${P}`), item.data);
  });

  it("without login a content request gets a screen and resolve gets { error }", async () => {
    const s = run(true);
    s.send({ type: "interactionPlugin", init: 1, data: {} });
    await tick();
    const home = await request(s, "r2", "home");
    assert.equal(typeof home, "object");
    assert.equal(home.error, undefined);
    const play = await request(s, "r3", "play:1:continue");
    assert.equal(typeof play.error, "string");
  });
});

/** Строки, которые есть только в модулях пробника (src/probe/*, кроме замеров запуска в lazy.ts). */
const PROBE_MARKERS = ["Запустить проверки API", "KPREPORT", "Back-снимок", "Сбросить все", "toggle отвечает watched", "probeq."];

async function started(): Promise<Sandbox> {
  const s = run(true);
  s.send({ type: "interactionPlugin", init: 1, data: {} });
  await tick();
  return s;
}

function assertNetError(screen: any): void {
  const items = screen?.pages?.[0]?.items ?? [];
  assert.match(String(items[0]?.text), /KP-NET/);
  assert.equal(items[1]?.label, "Повторить");
}

describe("bundle probe.js: loaded on the first probe route (stage 23b)", () => {
  it("app.js has no probe code; probe.js has it and takes the shared modules from app.js", () => {
    for (const m of PROBE_MARKERS) {
      assert.ok(!js.includes(m), `app.js contains probe marker ${JSON.stringify(m)}`);
      assert.ok(probeJs.includes(m), `probe.js lacks ${JSON.stringify(m)}`);
    }
    // Классы и тексты app.js в probe.js не дублируются: KpError один на оба файла (toKpError узнаёт ошибки API).
    for (const m of ['name="KpError"', "Подписка KinoPub неактивна", "TVXStorageService"]) {
      assert.ok(js.includes(m), m);
      assert.ok(!probeJs.includes(m), `probe.js duplicates ${JSON.stringify(m)}`);
    }
  });

  it("init and home do not load probe.js; «Диагностика» loads probe.js?v=<hash> once and answers after it", async () => {
    const s = await started();
    await request(s, "i1", "init");
    await request(s, "h1", "home");
    assert.deepEqual(s.scripts, []);
    const screen = await request(s, "p1", "probe");
    assert.equal(screen.headline, "Диагностика");
    assert.deepEqual(s.scripts, [`${ORIGIN}/msx/app/probe.js?v=${probeHash}`]);
    const dev = await request(s, "d1", "dev");
    assert.equal(dev.headline, "Для разработчика");
    assert.equal(s.scripts.length, 1);
  });

  it("probe.js unavailable → S14 with KP-NET and «Повторить»; the retry loads it", async () => {
    const file = join(dir, "app/probe.js");
    const s = await started();
    await rename(file, `${file}.off`);
    try {
      assertNetError(await request(s, "p1", "probe"));
    } finally {
      await rename(`${file}.off`, file);
    }
    assert.equal((await request(s, "p2", "probe")).headline, "Диагностика");
    assert.equal(s.scripts.length, 2);
  });

  it("probe.js of another build (stale cache after a deploy) is refused with KP-NET", async () => {
    const file = join(dir, "app/probe.js");
    await writeFile(file, probeJs.replace(`"${probeHash}"`, '"0000000000"'));
    try {
      const s = await started();
      assertNetError(await request(s, "p1", "probe"));
    } finally {
      await writeFile(file, probeJs);
    }
  });
});
