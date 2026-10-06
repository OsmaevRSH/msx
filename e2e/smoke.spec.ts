import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { contentAction, panelAction } from "../src/msx/actions.ts";
import { encodeListKey, ids } from "../src/router/ids.ts";
import { FIX } from "../tools/kpmock/fixtures.ts";
import { P, consoleTail, content, diag, exec, expectContent, kp, login, menuItem, mock, newMsxPage, openMsx, press, stats, waitFor } from "./fixtures.ts";
import type { MockCall } from "./fixtures.ts";

// Smoke Phase 0 в настоящей web-версии MSX (этап 27, решение Р-27): одна сессия MSX на весь файл, как у пользователя —
// меню без входа, вход по коду, главная и список, карточка, видео, «Диагностика» и «Для разработчика»; в конце — тот же iframe (CE-05).

test.describe.configure({ mode: "serial" });

let page: Page;
let bootId = "";

const movies = encodeListKey({ src: "catalog", type: "movie", sort: "-updated" });
const called = (calls: MockCall[], method: string, path: string): MockCall[] => calls.filter((c) => c.method === method && c.path === path);

/** События плеера, которые получил трекер плагина: `video:*` из handleEvent и решения трекера. */
async function playerEvents(): Promise<string[]> {
  return kp(page, (k) => k.events as string[]);
}

test.beforeAll(async ({ browser }) => {
  await mock.reset();
  page = await newMsxPage(browser);
});

test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus) return;
  await info.attach("msx.png", { body: await page.screenshot(), contentType: "image/png" });
  await info.attach("console.txt", { body: consoleTail(page, 80), contentType: "text/plain" });
});

test.afterAll(async () => {
  await page?.close();
});

test("CE-01: web MSX грузит start.json и плагин с localhost, меню без входа", async () => {
  const { start } = await openMsx(page);
  expect(start.parameter, "start.json ведёт на плагин dev-сервера").toBe(`menu:request:interaction:init@${P}`);
  await expect(menuItem(page, "Вход")).toBeVisible();
  await expect(menuItem(page, "Диагностика")).toBeVisible();
  await expect(menuItem(page, "Главная")).toHaveCount(0);

  const s = await waitFor(page, (x) => x.initAnsweredAt !== undefined && x.readyAt !== undefined, 5000, "ответ на init после ready");
  expect(s.initAnsweredAt! - s.readyAt!, "меню за ≤ 100 мс после ready (CNFR-03)").toBeLessThanOrEqual(100);
  expect(s.readyCount).toBe(1);
  expect(s.requests[0]).toBe("init");
  expect(diag(page).probeRequests, "probe.js не грузится без «Диагностики»").toEqual([]);
  bootId = s.bootId;
  // Трекер плагина → `__kp.events`: так тест видит, что события плеера дошли до плагина.
  await kp(page, (k) => {
    k.events = [];
    k.ctx.tracker.addListener((e: any) => k.events.push(e.kind === "raw" ? e.name : e.kind));
  });
});

test("E-02: вход по коду против mock без нажатий, меню со «Главная»", async () => {
  const code = await login(page);
  const calls = await mock.calls();
  const oauth = called(calls, "POST", "/oauth2/device");
  expect(oauth.map((c) => c.status), "код, один pending, подтверждение (pendingPolls: 1)").toEqual([200, 400, 200]);
  expect(called(calls, "POST", "/v1/device/notify")).toHaveLength(1);
  expect(calls.filter((c) => c.method === "OPTIONS"), "ни одного preflight (CNFR-19)").toEqual([]);
  expect(calls.every((c) => c.origin === undefined || c.origin === "http://127.0.0.1:8080"), "запросы идут из iframe плагина").toBe(true);
  await expect(content(page)).not.toContainText(code);
  const s = await stats(page);
  expect(s.requests.filter((r) => r === "init").length, "меню перезапрошено после входа").toBeGreaterThanOrEqual(2);
});

test("главная и список: полки и плитки из mock", async () => {
  await exec(page, contentAction(P, ids.home()));
  await expectContent(page, "Продолжить просмотр");
  await expectContent(page, "Новые фильмы");
  await expectContent(page, "Тестовый фильм «Простой»", { ignoreCase: true });

  await exec(page, contentAction(P, ids.list(movies)));
  await waitFor(page, (s) => s.requests.at(-1) === ids.list(movies), 10_000, "запрос списка «Фильмы»");
  await expect.poll(async () => called(await mock.calls(), "GET", "/v1/items").length, { message: "список загружен из mock" })
    .toBeGreaterThanOrEqual(1);
  await expect(content(page)).not.toContainText("Продолжить просмотр");
  await expectContent(page, /Тестовый фильм \d+/i);
});

test("карточка фильма", async () => {
  await exec(page, contentAction(P, ids.item(FIX.MOVIE_SIMPLE)));
  await expectContent(page, "Тестовый фильм «Простой»");
  await expectContent(page, "С начала");
  expect((await stats(page)).requests.at(-1)).toBe(ids.item(FIX.MOVIE_SIMPLE));
});

test("видео sample.webm играет, события плеера доходят до плагина", async () => {
  await press(page, "b_second", "С начала");
  await waitFor(page, (s) => s.requests.includes(ids.playStart(FIX.MOVIE_SIMPLE)), 10_000, "resolve play:start");
  // MSX шлёт video:load в handleEvent, а старт трекер видит по снимку позиции из триггера (handleData).
  await expect.poll(playerEvents, { message: "video:load и старт воспроизведения в трекере", timeout: 20_000, intervals: [200] })
    .toEqual(expect.arrayContaining(["video:load", "load", "started"]));

  const video = page.locator("video");
  await expect(video).toHaveAttribute("src", /\/cdn\/media\/sample\.webm/);
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { message: "WebM воспроизводится", timeout: 15_000 })
    .toBeGreaterThan(1);

  await page.keyboard.press("Escape");
  await expect.poll(playerEvents, { message: "video:stop в трекере", timeout: 15_000, intervals: [200] })
    .toEqual(expect.arrayContaining(["video:stop", "stop"]));
  const media = called(await mock.calls(), "GET", "/cdn/media/sample.webm");
  expect(media.length, "MSX брал видео у CDN mock").toBeGreaterThanOrEqual(1);
});

test("«Диагностика» лениво грузит probe.js, проверки API CDG-01 и CDG-02 — ✓", async () => {
  expect(diag(page).probeRequests, "до «Диагностики» probe.js не загружен").toEqual([]);
  await exec(page, contentAction(P, ids.probe()));
  await expectContent(page, "Запустить проверки API");
  expect(diag(page).probeRequests).toHaveLength(1);
  expect(diag(page).probeRequests[0]).toMatch(/\/app\/probe\.js\?v=[0-9a-f]{10}$/);

  await press(page, "b_runApi", "Запустить проверки API");
  await expect
    .poll(() => kp(page, (k) => k.ctx.probe.results().filter((r: any) => r.id === "CDG-01" || r.id === "CDG-02").map((r: any) => `${r.id}:${r.ok}`).sort()),
      { message: "CDG-01 и CDG-02 пройдены", timeout: 20_000, intervals: [200] })
    .toEqual(["CDG-01:true", "CDG-02:true"]);
  for (const id of ["CDG-01", "CDG-02"]) {
    const row = content(page).locator(".app-main-content-item", { hasText: id });
    await expect(row, `${id} перерисована как пройденная`).not.toContainText("не запускалась");
    // «✓» плагин пишет как {ico:msx-green:check}: MSX рисует его иконкой.
    await expect(row.locator("i.tvx-icon-check"), `${id} с галочкой`).toHaveCount(1);
    await expect(row.locator("i.tvx-icon-close"), `${id} без крестика`).toHaveCount(0);
  }
  expect(diag(page).probeRequests, "probe.js загружен один раз").toHaveLength(1);
});

test("«Для разработчика» и панель переключателя: MSX рисует items корня (у корня есть template)", async () => {
  await exec(page, contentAction(P, ids.dev()));
  await expectContent(page, "Режим потока");
  await exec(page, panelAction(P, ids.probe("flag:streamMode")));
  const panel = page.locator("#appPanelContent");
  await expect(panel).toContainText("hls2");
  await expect(panel).not.toContainText(/Content Not Available|Содержимое недоступно/i);
  await exec(page, "back");
  await expect(panel).toBeHidden();
});

test("CE-05: за всю сессию iframe плагина не перезагружался", async () => {
  const s = await stats(page);
  expect(s.bootId).toBe(bootId);
  expect(s.readyCount).toBe(1);
  expect(page.frames().filter((f) => f.url() === P)).toHaveLength(1);
});
