import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ids } from "../src/router/ids.ts";
import { MOCK_URL, P, content, exec, expectContent, kp, login, mock, newMsxPage, noNotification, openMsx, press } from "./fixtures.ts";
import { answer, answered, attachDiagnostics, callsSince, installTimeline, mark } from "./flows-kit.ts";

// «Скорость серверов KinoPub» (v1.18, спец. §11 S12, §16.7) в web MSX: «Настройки» → строка теста → «Проверить» →
// таблица по локациям → «Выбрать самый быстрый» → `serverLocation` устройства в mock, со сверкой чтением. CDN mock — с
// CORS и тремя локациями разной скорости: Германия быстрее всех, текущий сервер устройства — Нидерланды. Скриншот
// экрана с результатами — `KP_CDN_SHOT=<путь> npm run e2e -- e2e/cdn.spec.ts`.

/** Локации CDN mock по `?loc=`: задержка до заголовков, скорость тела (кбит/с). */
const LOCS = { nl: { latencyMs: 60, kbps: 8_000 }, de: { latencyMs: 15, kbps: 40_000 }, ru: { latencyMs: 120, kbps: 3_000 } };

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  await mock.reset();
  await mock.scenario({ cdnCors: true, cdnLocs: LOCS });
  page = await newMsxPage(browser);
  await openMsx(page);
  await installTimeline(page);
  await login(page);
});

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) await attachDiagnostics(page, info);
});

test.afterAll(async () => {
  await page?.close();
});

/** Сервер устройства — прямо у mock, с токеном плагина: `serverLocation` с флагом `selected`. */
async function deviceLocation(): Promise<number | undefined> {
  const token = await kp(page, (k) => k.ctx.auth.access()?.token as string);
  const res = await fetch(`${MOCK_URL}/v1/device/info?access_token=${encodeURIComponent(token)}`);
  const body = (await res.json()) as { device: { settings: { serverLocation: { value: { id: number; selected: number }[] } } } };
  return body.device.settings.serverLocation.value.find((v) => v.selected === 1)?.id;
}

test("E-30: «Скорость серверов KinoPub» — «Проверить» даёт таблицу по локациям, «Выбрать самый быстрый» меняет сервер устройства в mock", async () => {
  expect(await deviceLocation(), "до теста — Нидерланды (id 1)").toBe(1);
  const m0 = await mark(page);
  await exec(page, `content:request:interaction:${ids.settings()}@${P}`);
  await answered(page, ids.settings(), m0);
  await press(page, "s_cdn", "Скорость серверов KinoPub");
  await answered(page, ids.probe("cdn"), m0, 15_000);
  await expectContent(page, "Проверить");
  for (const name of ["Нидерланды", "Германия", "Россия"]) await expectContent(page, name);
  const before = await answer(page, ids.probe("cdn"));
  expect(before.items.find((i: { id?: string }) => i.id === "cdn_best")?.enable, "до проверки выбирать нечего").toBe(false);

  const c0 = (await mock.calls()).length;
  await press(page, "cdn_run", "Проверить");
  const speeds = async (): Promise<number> =>
    ((await answer(page, ids.probe("cdn"))).items as { extensionLabel?: string }[]).filter((i) => /Мбит\/с/.test(i.extensionLabel ?? "")).length;
  await expect.poll(speeds, { message: "три строки со скоростью (ответ после проверки)", timeout: 45_000 }).toBe(3);
  await expectContent(page, "Германия · самый быстрый");
  await expect(content(page), "все три строки и действия — на одном экране").toContainText("Мбит/с");
  const cdn = await callsSince(c0, /^\/cdn\//);
  expect(cdn.map((c) => c.q.get("loc")), "локации по очереди, по одному файлу WebM на каждую").toEqual(["nl", "de", "ru"]);
  const shown = await answer(page, ids.probe("cdn"));
  const best = shown.items.find((i: { id?: string }) => i.id === "cdn_best");
  expect([best?.extensionLabel, best?.focus], "фокус — на выборе самого быстрого").toEqual(["Германия", true]);
  const de = shown.items.find((i: { id?: string }) => i.id === "cdn_de");
  expect(String(de?.extensionLabel)).toMatch(/^\d+ мс · \d+(,\d)? Мбит\/с · сегмент \d+,\d с$/);
  await noNotification(page);
  if (process.env.KP_CDN_SHOT) {
    // Как остальные превью: 1920×1080, затем обратно к размеру e2e.
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: process.env.KP_CDN_SHOT });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(1000);
  }

  const c1 = (await mock.calls()).length;
  await press(page, "cdn_best", "Выбрать самый быстрый");
  await expect.poll(deviceLocation, { message: "serverLocation устройства в mock — Германия (id 2)", timeout: 15_000 }).toBe(2);
  const after = (await callsSince(c1, /^\/v1\/device\//)).map((c) => `${c.method} ${c.path.replace(/\/\d+\//, "/N/")}`);
  expect(after.slice(0, 2), "POST, затем сверка чтением").toEqual(["POST /v1/device/N/settings", "GET /v1/device/info"]);
  await expectContent(page, "CDN-сервер: Германия");
  await expect.poll(async () => (await answer(page, ids.probe("cdn"))).items.find((i: { id?: string }) => i.id === "cdn_de")?.label, {
    message: "экран перерисован с новой отметкой", timeout: 10_000,
  }).toBe("{ico:check} Германия · самый быстрый");
});
