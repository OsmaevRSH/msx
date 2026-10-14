import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { encodeListKey, ids } from "../src/router/ids.ts";
import { FIX } from "../tools/kpmock/fixtures.ts";
import { content, exec, expectContent, login, mock, msxMenuDialog, newMsxPage, noNotification, openMsx } from "./fixtures.ts";
import { answered, attachDiagnostics, callCount, callsSince, installTimeline, mark, open, panel, selected } from "./flows-kit.ts";

// Действия над плиткой (спец. §11.4) в web MSX: красная кнопка (в web MSX — F1) на плитке в фокусе открывает её опции —
// `template.options` с `{context:kid}`; выбор удаляет тайтл в KinoPub, плитка пропадает сразу, фокус — на соседней.
// Одна сессия web MSX на файл.

test.describe.configure({ mode: "serial" });

let page: Page;
const HISTORY = ids.list(encodeListKey({ src: "history" }));
const FOLDER = ids.list(encodeListKey({ src: "folder", folder: 1 }));
const notification = (p: Page) => p.locator("#appNotificationScene .app-notification-item");

test.beforeAll(async ({ browser }) => {
  await mock.reset();
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

/** Фокус на плитке тайтла и красная кнопка: опции с названием тайтла в заголовке. */
async function optionsOn(p: Page, id: number, name: string): Promise<void> {
  await noNotification(p);
  await exec(p, `focus:i${id}`);
  await expect(selected(p)).toContainText(name);
  await p.keyboard.press("F1");
  await expect(panel(p), "заголовок опций — тайтл в фокусе").toContainText(name);
}

/** Пункт опций по подписи: стрелками до него и OK. */
async function choose(p: Page, label: string): Promise<void> {
  const sel = panel(p).locator(".selected");
  for (let n = 0; n < 6 && !(await sel.innerText()).includes(label); n++) await p.keyboard.press("ArrowDown");
  await expect(sel).toContainText(label);
  await p.keyboard.press("Enter");
}

test("E-24: «История» — «Удалить из истории» убирает плитку сразу, фокус на соседней; «Очистить всю историю» — подтверждение с фокусом на «Отмена»", async () => {
  await open(page, HISTORY);
  await expectContent(page, "«Простой»");
  await optionsOn(page, FIX.MOVIE_SIMPLE, "«Простой»");
  await expect(panel(page)).toContainText("Тестовый фильм «Простой»");
  await expect(panel(page)).toContainText("Очистить всю историю");
  const c0 = await callCount();
  const m0 = await mark(page);
  await choose(page, "Удалить из истории");
  await answered(page, HISTORY, m0);
  await expect(panel(page)).toBeHidden();
  await expect(notification(page)).toContainText("Удалено из истории");
  await expect(content(page)).not.toContainText("«Простой»");
  await expect(selected(page), "фокус на соседней плитке").toContainText("«Короткий»");
  expect((await callsSince(c0, /^\/v1\/history\/clear-for-item$/)).map((c) => `${c.method} ${c.q.get("id")}`)).toEqual([`POST ${FIX.MOVIE_SIMPLE}`]);

  // «Очистить всю историю» → «Отмена» (фокус на ней): ничего не удалено.
  await optionsOn(page, FIX.SERIAL_SMALL, "«Короткий»");
  const m1 = await mark(page);
  await choose(page, "Очистить всю историю");
  await answered(page, ids.panel("tile", "clear"), m1);
  await expect(panel(page)).toContainText("Очистить всю историю?");
  await expect(panel(page).locator(".selected"), "фокус на «Отмена»").toContainText("Отмена");
  const c1 = await callCount();
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeHidden();
  await expectContent(page, "«Короткий»");
  expect(await callsSince(c1, /^\/v1\/history\/clear/)).toEqual([]);

  // Ещё раз — «Очистить»: история пуста, экран заменён пустым.
  await page.keyboard.press("F1");
  const m2 = await mark(page);
  await choose(page, "Очистить всю историю");
  await answered(page, ids.panel("tile", "clear"), m2);
  await page.keyboard.press("ArrowUp");
  await expect(panel(page).locator(".selected")).toContainText("Очистить");
  const m3 = await mark(page);
  await page.keyboard.press("Enter");
  await answered(page, HISTORY, m3, 20_000);
  await expectContent(page, "Здесь появятся фильмы и сериалы");
  await expect(notification(page)).toContainText("История очищена");
  expect((await callsSince(c1, /^\/v1\/history\/clear-for-item$/)).map((c) => c.q.get("id")).sort())
    .toEqual([String(FIX.SERIAL_BIG), String(FIX.SERIAL_SMALL)].sort());
  await noNotification(page);
});

test("E-25: «Я смотрю» — «Убрать из „Я смотрю“» на сериале: один togglewatchlist, плитка пропала; у фильма опций плитки нет", async () => {
  // Без mock.reset(): он отзывает токены плагина. История уже пуста (E-24), «Я смотрю» от неё не зависит.
  await open(page, ids.watching());
  await expectContent(page, "«Большой»");
  await optionsOn(page, FIX.SERIAL_BIG, "«Большой»");
  await expect(panel(page)).toContainText("Тестовый сериал «Большой»");
  const c0 = await callCount();
  const m0 = await mark(page);
  await choose(page, "Убрать из «Я смотрю»");
  await answered(page, ids.watching(), m0);
  await expect(notification(page)).toContainText("Убрано из «Я смотрю»");
  await expect(content(page)).not.toContainText("«Большой»");
  await expect(selected(page), "фокус на соседней плитке").toContainText("«Короткий»");
  await expectContent(page, "1 сериал · 1 фильм");
  expect((await callsSince(c0, /^\/v1\/watching\/togglewatchlist$/)).map((c) => c.q.get("id"))).toEqual([String(FIX.SERIAL_BIG)]);

  // Фильм: надёжного способа убрать начатый фильм у API нет — красная кнопка открывает системные опции MSX.
  await noNotification(page);
  await exec(page, `focus:i${FIX.MOVIE_SIMPLE}`);
  await expect(selected(page)).toContainText("«Простой»");
  await page.keyboard.press("F1");
  await expect(msxMenuDialog(page), "системные опции MSX").toBeVisible();
  await expect(panel(page)).not.toContainText("Убрать");
  await page.keyboard.press("Backspace");
  await expect(msxMenuDialog(page)).toBeHidden();
});

test("E-26: папка закладок — «Убрать из папки»: remove-item, плитка пропала, «1 шт.»", async () => {
  await open(page, ids.bookmarks());
  await open(page, FOLDER);
  await expectContent(page, "«Простой»");
  await expectContent(page, "2 шт.");
  await optionsOn(page, FIX.MOVIE_SIMPLE, "«Простой»");
  await expect(panel(page)).not.toContainText("Переместить", { timeout: 1000 });
  const c0 = await callCount();
  const m0 = await mark(page);
  await choose(page, "Убрать из папки");
  await answered(page, FOLDER, m0);
  await expect(notification(page)).toContainText("Убрано из папки");
  await expect(content(page)).not.toContainText("«Простой»");
  await expect(selected(page), "фокус на соседней плитке").toContainText("«Большой»");
  await expectContent(page, "1 шт.");
  const rm = await callsSince(c0, /^\/v1\/bookmarks\/remove-item$/);
  expect(rm.map((c) => c.method)).toEqual(["POST"]);
  await noNotification(page);
});
