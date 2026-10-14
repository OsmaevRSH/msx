import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ids } from "../src/router/ids.ts";
import { content, diag, expectContent, mock, newMsxPage, noNotification, openMsx } from "./fixtures.ts";
import { answer, answered, attachDiagnostics, installTimeline, mark, selected } from "./flows-kit.ts";

// «Настройки» без входа (v1.16, спец. §11 S3, S12, S13): меню — «Вход» и «Настройки»; в «Настройках» без входа — только
// «Для разработчика»: «Диагностика» и «Системные настройки MSX», без запросов к API KinoPub (проблемы со входом разбирают
// здесь). Пультом, как на ТВ: системные настройки MSX — действие MSX `settings`, «Назад» возвращает к «Настройкам».
// Код входа mock не подтверждает: вся сессия — без входа.

test.describe.configure({ mode: "serial" });

let page: Page;
const menuSelected = (p: Page) => p.locator("#appMainMenuItems .app-main-menu-item.selected");

test.beforeAll(async ({ browser }) => {
  await mock.reset();
  await mock.scenario({ pendingPolls: 1_000_000 });
  page = await newMsxPage(browser);
  await openMsx(page);
  await installTimeline(page);
});

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) await attachDiagnostics(page, info);
});

test.afterAll(async () => {
  await page?.close();
});

test("E-24: без входа «Настройки» пультом из меню — только «Для разработчика», без API; «Системные настройки MSX» и «Назад»; «Диагностика»", async () => {
  await expect(page.locator("#appMainMenuItems .app-main-menu-item")).toHaveText(["Вход", "Настройки"]);
  await expectContent(page, "Введите код", { timeout: 15_000 });
  await noNotification(page);
  await expect(menuSelected(page)).toHaveText("Вход");
  const c0 = (await mock.calls()).length;
  const m0 = await mark(page);
  await page.keyboard.press("ArrowDown");
  await expect(menuSelected(page)).toHaveText("Настройки");
  await answered(page, ids.settings(), m0);
  const s = await answer(page, ids.settings());
  expect(s.headline).toBe("Настройки");
  expect(s.items.filter((i: { headline?: string }) => i.headline !== undefined).map((i: { headline: string }) => i.headline)).toEqual(["Для разработчика"]);
  await expectContent(page, "Системные настройки MSX");
  await expect(content(page), "без входа — без настроек аккаунта и устройства").not.toContainText("Воспроизведение");
  expect((await mock.calls()).slice(c0).filter((c) => c.path.startsWith("/v1/")), "«Настройки» без входа не ходят в API").toEqual([]);
  expect(diag(page).probeRequests, "«Настройки» probe.js не грузят").toEqual([]);

  // Из меню в контент — на «Диагностику»; вниз — «Системные настройки MSX»; дальше вниз и вверх края не переносят фокус.
  await page.keyboard.press("ArrowRight");
  await expect(selected(page)).toContainText("Диагностика");
  await page.keyboard.press("ArrowUp");
  await expect(selected(page), "вверх с первой строки — на месте").toContainText("Диагностика");
  await page.keyboard.press("ArrowDown");
  await expect(selected(page)).toContainText("Системные настройки MSX");
  await page.keyboard.press("ArrowDown");
  await expect(selected(page), "вниз с последней строки — на месте").toContainText("Системные настройки MSX");

  // Действие `settings` открывает системные настройки MSX поверх «Настроек»; «Назад» — обратно, фокус на той же строке.
  await page.keyboard.press("Enter");
  await expectContent(page, "Стартовый параметр");
  await expectContent(page, "О программе");
  await page.keyboard.press("Backspace");
  await expectContent(page, "Системные настройки MSX");
  await expect(selected(page)).toContainText("Системные настройки MSX");

  // «Диагностика» без входа: probe.js грузится сейчас, один раз; на экране — «Вход» вместо «Выйти из KinoPub».
  const m1 = await mark(page);
  await page.keyboard.press("ArrowUp");
  await expect(selected(page)).toContainText("Диагностика");
  await page.keyboard.press("Enter");
  await answered(page, ids.probe(), m1);
  await expectContent(page, "Запустить проверки API");
  await expectContent(page, "Вход");
  expect(diag(page).probeRequests).toHaveLength(1);
  await page.keyboard.press("Backspace");
  await expectContent(page, "Системные настройки MSX");
  await expect(menuSelected(page)).toHaveText("Настройки");
});
