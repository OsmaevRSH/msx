// Dev-сервер (этап 27, решение Р-31): mock API :8787, сборка с отладочными хуками `__kp`, статика плагина :8080,
// без `--no-watch` — пересборка по изменениям src/ и public/. `--e2e` — режим Playwright: WebM вместо плейлистов
// (Р-9), один опрос входа до подтверждения кода, heartbeat через 10 тиков (Р-26).
import { watch } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "./build.mjs";
import { startMock } from "./kpmock/server.ts";
import { serveStatic } from "./static-server.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HOST = "127.0.0.1";
const PLUGIN_PORT = 8080;
const MOCK_PORT = 8787;
const SITE_ORIGIN = `http://${HOST}:${PLUGIN_PORT}`;
const MOCK_URL = `http://${HOST}:${MOCK_PORT}`;
/**
 * Не `dist/`: `npm run build` пишет туда боевую сборку (API KinoPub, без хуков), и одновременный запуск подменил бы
 * плагин dev-сервера; dev-сборка в свою очередь не должна попасть в `dist/app`, который меряет `npm run size`.
 */
const OUT_DIR = join(ROOT, "dist", "dev");
const WATCH_DIRS = ["src", "public"];
const DEBOUNCE_MS = 200;
/** Сценарий mock для e2e: код входа подтверждается на втором опросе (≈ 10 с), а не на третьем. */
export const E2E_SCENARIO = Object.freeze({ pendingPolls: 1 });

/** Параметры `build()` dev-сборки. */
export function devBuildOptions(e2e) {
  return {
    SITE_ORIGIN,
    BASE_PATH: "/",
    API_BASE: MOCK_URL,
    DEBUG_HOOKS: "1",
    HEARTBEAT_TICKS: e2e ? "10" : "60",
    OUT_DIR,
  };
}

/** Адрес web-версии MSX с плагином из start parameter (спец. §4, msx-platform §7). */
export function webMsxUrl(pluginUrl) {
  return `http://msx.benzac.de/?start=menu:request:interaction:init@${pluginUrl}`;
}

export function banner(pluginUrl) {
  return [
    `Плагин:   ${pluginUrl}`,
    `Mock API: ${MOCK_URL}`,
    `Web MSX:  ${webMsxUrl(pluginUrl)}`,
    "Chrome:   запустить с флагом --disable-features=LocalNetworkAccessChecks",
    "          (или chrome://flags/#local-network-access-check → Disabled)",
  ].join("\n");
}

const ts = () => new Date().toTimeString().slice(0, 8);

/** Сборка с выводом ошибки вместо падения: при наблюдении сервер продолжает отдавать прошлую удачную сборку. */
async function rebuild(e2e) {
  const t0 = performance.now();
  try {
    const res = await build(devBuildOptions(e2e));
    console.log(`[${ts()}] build ${res.hash} (probe ${res.probeHash}) за ${Math.round(performance.now() - t0)} мс`);
    return res;
  } catch (e) {
    console.error(`[${ts()}] сборка не удалась: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

/** Пересборка не чаще раза в DEBOUNCE_MS; изменения во время сборки дают ещё одну сборку после неё. */
function watchSources(e2e) {
  let timer;
  let running = false;
  let again = false;
  const run = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    do {
      again = false;
      await rebuild(e2e);
    } while (again);
    running = false;
  };
  const watchers = WATCH_DIRS.map((dir) =>
    watch(join(ROOT, dir), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(run, DEBOUNCE_MS);
    }),
  );
  return () => {
    clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}

function portHint(e, port, what) {
  if (e && typeof e === "object" && "code" in e && e.code === "EADDRINUSE") {
    return `порт ${port} занят (${what}): остановите другой npm run dev / npm run mock / e2e`;
  }
  return `${what}: ${e instanceof Error ? e.message : String(e)}`;
}

async function main() {
  const { values } = parseArgs({ options: { "no-watch": { type: "boolean", default: false }, e2e: { type: "boolean", default: false } } });
  const e2e = values.e2e;

  let mock;
  try {
    mock = await startMock({ port: MOCK_PORT, host: HOST, media: e2e ? "webm" : "playlist" });
  } catch (e) {
    throw new Error(portHint(e, MOCK_PORT, "mock API"));
  }
  if (e2e) mock.setScenario(E2E_SCENARIO);

  // Статика стартует после первой сборки: готовность для Playwright — ответ start.json свежей сборки.
  const first = await rebuild(e2e);
  if (first === undefined) {
    await mock.close();
    process.exit(1);
  }
  let site;
  try {
    site = await serveStatic({ dir: OUT_DIR, port: PLUGIN_PORT, host: HOST });
  } catch (e) {
    await mock.close();
    throw new Error(portHint(e, PLUGIN_PORT, "статика плагина"));
  }
  const unwatch = values["no-watch"] ? () => {} : watchSources(e2e);

  console.log(banner(first.pluginUrl));
  console.log(e2e ? "Режим e2e: media webm, вход со второго опроса, heartbeat 10 тиков" : "Mock: media playlist");
  if (!values["no-watch"]) console.log(`Наблюдение: ${WATCH_DIRS.join(", ")} → пересборка`);

  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    unwatch();
    Promise.all([site.close(), mock.close()]).then(() => process.exit(0), () => process.exit(1));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
