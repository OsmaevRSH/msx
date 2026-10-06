import { expect } from "@playwright/test";
import type { Browser, Frame, Locator, Page } from "@playwright/test";
import type { DebugStats } from "../src/app/debug.ts";

// Помощники e2e в web-версии MSX (этап 27): адреса dev-сервера (Р-31), запуск MSX со start parameter из нашего
// start.json, доступ к отладочным хукам `__kp` плагина (сборка с DEBUG_HOOKS=1), управление mock, вход по коду.

export const SITE = "http://127.0.0.1:8080";
export const MOCK_URL = "http://127.0.0.1:8787";
/** Адрес плагина — он же `@P` во всех действиях (спец. §6.2, CD-16). */
export const P = `${SITE}/app/index.html`;
export const MSX_ORIGIN = "http://msx.benzac.de";
/** `start` — значение `parameter` из start.json; `animate=0` и `layout=1080p` — стабильная раскладка без анимаций. */
export const msxUrl = (parameter: string): string => `${MSX_ORIGIN}/?start=${parameter}&animate=0&layout=1080p`;
export const MSX_URL = msxUrl(`menu:request:interaction:init@${P}`);
/** Сценарий mock для e2e, как у `tools/dev.mjs --e2e`: код подтверждается на втором опросе (≈ 10 с). */
export const E2E_SCENARIO = { pendingPolls: 1 };

const LNA_ERROR = "ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS";
const LNA_HINT =
  "Chrome Local Network Access заблокировал загрузку с 127.0.0.1 из публичной http-страницы MSX. " +
  "Запускайте Chromium с --disable-features=LocalNetworkAccessChecks (e2e/playwright.config.ts) " +
  "или chrome://flags/#local-network-access-check → Disabled; иначе — https://msx.benzac.de + dev-сервер по HTTPS (mkcert) " +
  "с разрешением «Local network», туннель или dev-деплой на Pages (msx-platform §7).";

export interface StartObject { name: string; version: string; parameter: string; welcome?: string }

/** Что видно со стороны браузера: консоль MSX, запросы probe.js, отказы LNA. */
interface Diag { console: string[]; probeRequests: string[]; lnaBlocked: string[] }
const diags = new WeakMap<Page, Diag>();

export function diag(page: Page): Diag {
  let d = diags.get(page);
  if (d === undefined) {
    const nd: Diag = { console: [], probeRequests: [], lnaBlocked: [] };
    page.on("console", (m) => {
      nd.console.push(`${m.type()}: ${m.text().slice(0, 300)}`);
      if (nd.console.length > 300) nd.console.shift();
    });
    page.on("request", (r) => {
      if (r.url().startsWith(`${SITE}/app/probe.js`)) nd.probeRequests.push(r.url());
    });
    page.on("requestfailed", (r) => {
      if ((r.failure()?.errorText ?? "").includes(LNA_ERROR)) nd.lnaBlocked.push(r.url());
    });
    diags.set(page, nd);
    d = nd;
  }
  return d;
}

/** Последние строки консоли MSX и плагина — для сообщений об ошибках. */
export function consoleTail(page: Page, n = 15): string {
  return diag(page).console.slice(-n).join("\n");
}

/** Новая вкладка 1280×720 (у страниц из `browser.newPage` нет `use.viewport` конфига). */
export async function newMsxPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  diag(page);
  return page;
}

/** Start Object, который MSX на ТВ берёт по `http://{SERVER}/msx/start.json` (msx-platform §1.1). */
export async function startObject(page: Page): Promise<StartObject> {
  const res = await page.request.get(`${SITE}/msx/start.json`);
  expect(res.status(), "dev-сервер отдаёт /msx/start.json").toBe(200);
  expect(res.headers()["access-control-allow-origin"], "start.json с CORS (Setup Precondition MSX)").toBe("*");
  return (await res.json()) as StartObject;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Фрейм плагина; ждёт его появления и хуков `__kp`, иначе — ошибка с причиной (LNA, MSX, сборка без хуков). */
export async function pluginFrame(page: Page, timeoutMs = 20_000): Promise<Frame> {
  const d = diag(page);
  const until = Date.now() + timeoutMs;
  let frame: Frame | undefined;
  while (frame === undefined) {
    if (d.lnaBlocked.length > 0) throw new Error(`${LNA_HINT}\nЗаблокировано: ${d.lnaBlocked.join(", ")}`);
    frame = page.frames().find((f) => f.url() === P);
    if (frame !== undefined) break;
    if (Date.now() > until) {
      throw new Error(`MSX не загрузил плагин ${P} за ${timeoutMs} мс; фреймы: ${page.frames().map((f) => f.url()).join(", ")}\n${consoleTail(page)}`);
    }
    await sleep(100);
  }
  const hooks = await frame
    .waitForFunction(() => (globalThis as { __kp?: unknown }).__kp !== undefined, undefined, { timeout: Math.max(1000, until - Date.now()), polling: 100 })
    .then(() => true, () => false);
  if (!hooks) throw new Error("В плагине нет globalThis.__kp: нужна сборка с DEBUG_HOOKS=1 (её делает tools/dev.mjs --e2e)");
  return frame;
}

/**
 * Открыть web MSX со start parameter из нашего start.json и дождаться плагина. Недоступность msx.benzac.de и блокировка
 * LNA дают ошибку с причиной и обходом, а не таймаут теста.
 */
export async function openMsx(page: Page): Promise<{ frame: Frame; start: StartObject }> {
  const start = await startObject(page);
  try {
    await page.goto(msxUrl(start.parameter), { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (e) {
    throw new Error(
      `Web MSX ${MSX_ORIGIN} недоступен: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}. ` +
        "Smoke проверяет плагин только в настоящем MSX: нужен доступ к msx.benzac.de (при блокировке — VPN/podkop).",
    );
  }
  if (new URL(page.url()).protocol === "https:") {
    throw new Error(
      `Web MSX открылся по HTTPS (${page.url()}): в secure context MSX переписывает http:// плагина на https:// (msx-platform §1.4). ` +
        "Обход: dev-сервер по HTTPS (mkcert) или туннель с https-адресом плагина.",
    );
  }
  return { frame: await pluginFrame(page), start };
}

export async function stats(page: Page): Promise<DebugStats> {
  return (await pluginFrame(page)).evaluate(() => (globalThis as any).__kp.stats() as DebugStats);
}

/** Выполнить действие MSX из плагина — короткий путь навигации (открыть экран, панель, фокус). */
export async function exec(page: Page, action: string): Promise<void> {
  await (await pluginFrame(page)).evaluate((a) => (globalThis as any).__kp.ctx.host.executeAction(a), action);
}

/** Вычислить выражение над `__kp` в плагине. */
export async function kp<T>(page: Page, fn: (kp: any) => T): Promise<T> {
  const frame = await pluginFrame(page);
  return frame.evaluate(`(${fn.toString()})(globalThis.__kp)`) as Promise<T>;
}

/** Опрос `stats()` раз в 200 мс, пока `pred` не вернёт true. */
export async function waitFor(page: Page, pred: (s: DebugStats) => boolean, timeoutMs: number, what = "условие"): Promise<DebugStats> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const s = await stats(page);
    if (pred(s)) return s;
    if (Date.now() > until) throw new Error(`не дождались за ${timeoutMs} мс: ${what}\nstats: ${JSON.stringify(s)}\n${consoleTail(page)}`);
    await sleep(200);
  }
}

async function mockFetch(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${MOCK_URL}${path}`, init);
  if (!res.ok) throw new Error(`mock ${path}: HTTP ${res.status}`);
  return res.json();
}

export interface MockCall { t: number; method: string; path: string; query: string; status: number; origin?: string }

/** Управление kpmock (`/__mock/*`). `reset()` возвращает и сценарий e2e: сброс mock откатывает его к умолчанию. */
export const mock = {
  async reset(): Promise<void> {
    await mockFetch("/__mock/reset", { method: "POST" });
    await mockFetch("/__mock/scenario", { method: "POST", body: JSON.stringify(E2E_SCENARIO) });
  },
  async scenario(patch: Record<string, unknown>): Promise<unknown> {
    return mockFetch("/__mock/scenario", { method: "POST", body: JSON.stringify(patch) });
  },
  async calls(): Promise<MockCall[]> {
    return mockFetch("/__mock/calls");
  },
};

/** Пункт меню MSX по точной подписи. */
export const menuItem = (page: Page, label: string): Locator => page.locator("#appMainMenuItems").getByText(label, { exact: true });
/** Область контента MSX. */
export const content = (page: Page): Locator => page.locator("#appMainContent");

/** Текст в контенте MSX; если MSX не отрисовал ответ плагина, ошибка говорит об этом, а не только о таймауте. */
export async function expectContent(page: Page, text: string | RegExp, opts: { ignoreCase?: boolean; timeout?: number } = {}): Promise<void> {
  try {
    await expect(content(page)).toContainText(text, opts);
  } catch (e) {
    const shown = (await content(page).innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    const hint = /Содержимое недоступно|Content Not Available/i.test(shown)
      ? " MSX показал «Содержимое недоступно»: ответ плагина не отрисован (например, items корня без template)."
      : "";
    throw new Error(`В контенте MSX нет ${String(text)}.${hint}\nНа экране: ${shown}\n${String(e)}`);
  }
}

/** Уведомление MSX (`info:…`) перехватывает следующую клавишу; ждём, пока оно скроется (≈ 8 с). */
export async function noNotification(page: Page): Promise<void> {
  await expect(page.locator("#appNotificationScene .app-notification-item")).toBeHidden({ timeout: 15_000 });
}

/** «Нажать» элемент контента: фокус по id (`focus:<id>`), проверка фокуса по подписи и Enter, как с пульта. */
export async function press(page: Page, id: string, label: string): Promise<void> {
  await noNotification(page);
  await exec(page, `focus:${id}`);
  await expect(content(page).locator(".app-main-content-item.selected")).toContainText(label);
  await page.keyboard.press("Enter");
}

/**
 * Вход по коду (Plan B E-02): MSX показывает экран входа без нажатий, код на экране — тот, что выдал mock; mock
 * подтверждает код на втором опросе; плагин сам перерисовывает меню — появляется «Главная». Возвращает код.
 */
export async function login(page: Page): Promise<string> {
  if (!page.url().startsWith(MSX_ORIGIN)) await openMsx(page);
  await expectContent(page, "Введите код", { timeout: 15_000 });
  const code = await kp(page, (k) => k.ctx.state.login?.state().userCode as string | undefined);
  expect(code, "плагин получил код входа от mock").toMatch(/^[A-Z]{6}$/);
  await expectContent(page, code as string);
  await expect
    .poll(() => kp(page, (k) => k.ctx.auth.isLoggedIn() as boolean), { message: "mock подтвердил код, плагин получил токены", timeout: 30_000, intervals: [200] })
    .toBe(true);
  try {
    await expect(menuItem(page, "Главная")).toBeVisible({ timeout: 15_000 });
  } catch (e) {
    const actions = (await stats(page)).actions.filter((a) => a.includes(":menu"));
    const hint = actions.some((a) => a.includes("reload:menu")) && !actions.some((a) => a.includes("replace:menu:"))
      ? " Плагин выполнил reload:menu, а MSX не перезагружает меню из start parameter (KB actions-reference: для него — replace:menu:<flag>:…)."
      : "";
    throw new Error(`После входа меню MSX не перерисовано: нет «Главная». Действия плагина с меню: ${JSON.stringify(actions)}.${hint}\n${String(e)}`);
  }
  return code as string;
}
