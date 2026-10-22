import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { encodeListKey, ids, msgs } from "../src/router/ids.ts";
import { FIX } from "../tools/kpmock/fixtures.ts";
import { expectContent, login, mock, newMsxPage, noNotification, openMsx, press } from "./fixtures.ts";
import {
  answer, answered, attachDiagnostics, callCount, callsSince, installTimeline, kpWith, mark, open, panel, selected, sleep, timeline,
} from "./flows-kit.ts";

// Списки в памяти (QA 2026-10-22, пакет B) в web MSX: ☆ на карточке сразу видна в папке (QA-NAV-1), «Показать все»
// открывает общий с меню список с начала, а не с окна, до которого его пролистали (QA-NAV-3). Одна сессия web MSX на файл.

test.describe.configure({ mode: "serial" });

let page: Page;
const A12 = FIX.MOVIE_AUDIO12;
const FOLDER = ids.list(encodeListKey({ src: "folder", folder: 1 }));
/** «Новинки» из меню (вкладка из настроек) и «Показать все» полки «Новые фильмы»: в памяти — один список с ключом `fresh`. */
const FRESH_MENU = ids.list(encodeListKey({ src: "fresh" }));
const FRESH = encodeListKey({ src: "fresh", type: "movie" });

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

const tileIds = (s: { items?: { id?: string }[] } | undefined): string[] => (s?.items ?? []).map((i) => i.id ?? "").filter((id) => /^i\d+$/.test(id));

test("E-39: ☆ на карточке → «Избранное — добавить» — папка, уже открытая раньше, показывает новый тайтл и «3 шт.»", async () => {
  await noNotification(page);
  await open(page, ids.bookmarks());
  await expectContent(page, "2 шт.");
  await open(page, FOLDER);
  await expectContent(page, "«Простой»");
  expect(tileIds(await answer(page, FOLDER))).not.toContain(`i${A12}`);

  await open(page, ids.item(A12));
  await expectContent(page, "«12 озвучек»");
  const c0 = await callCount();
  await press(page, "b_bm", "☆ В закладки");
  await expect(panel(page)).toContainText("Избранное — добавить");
  await expect(panel(page).locator(".selected")).toContainText("Избранное — добавить");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await callsSince(c0, /^\/v1\/bookmarks\/add$/)).length, { message: "bookmarks/add в mock", timeout: 10_000 }).toBe(1);
  await expect(panel(page)).toContainText("Избранное — убрать");
  await page.keyboard.press("Backspace");
  await expect(panel(page)).toBeHidden();

  await open(page, ids.bookmarks());
  await expectContent(page, "3 шт.");
  const c1 = await callCount();
  await open(page, FOLDER);
  await expectContent(page, "«12 озвучек»");
  await expectContent(page, "3 шт.");
  expect(tileIds(await answer(page, FOLDER))).toContain(`i${A12}`);
  expect(await callsSince(c1, /^\/v1\/bookmarks\/1$/), "папка перечитана из KinoPub, а не из памяти").toHaveLength(1);
});

test("E-40: «Новинки» пролистаны до окна [48, 144) → главная → «Показать все» — первый тайтл в фокусе, без extend:up и второго запроса экрана", async () => {
  await noNotification(page);
  await open(page, FRESH_MENU);
  await expectContent(page, /Тестовый\s*фильм\s*1000/);
  // Две догрузки вниз — как live последней плитки окна: окно в памяти сдвигается на [48, 144).
  for (const to of [48, 96]) {
    const m = await mark(page);
    await kpWith(page, (k, message) => k.app.handleData({ message }), msgs.extend(`${FRESH}:down:${to}`));
    await answered(page, FRESH_MENU, m);
  }
  const win = (): Promise<number[]> => kpWith(page, (k, key) => [k.ctx.state.lists.get(key).from, k.ctx.state.lists.get(key).to], FRESH);
  expect(await win()).toEqual([48, 144]);

  await open(page, ids.home());
  await expectContent(page, "Новые фильмы");
  const m0 = await mark(page);
  await press(page, "fm_more", "Показать все");
  await answered(page, ids.list(FRESH), m0);
  await expectContent(page, /Тестовый\s*фильм\s*1000/);
  await expect(selected(page), "фокус на первом тайтле списка").toContainText(/фильм\s*1000/);
  expect((await win())[0], "окно с начала списка").toBe(0);
  const shown = await answer(page, ids.list(FRESH));
  expect(tileIds(shown)[0]).toBe("i1000");
  expect(shown.items[0].live, "у первой плитки нет extend:up").toBeUndefined();
  // live MSX пересчитывает раз в секунду: за 2,5 с ни сдвига окна вверх, ни перерисовки, ни второго запроса экрана.
  await sleep(2500);
  const tl = await timeline(page, m0);
  expect(tl.filter((e) => e.k === "msg" && e.v.startsWith("extend:") && e.v.includes(":up:")).map((e) => e.v)).toEqual([]);
  expect(tl.filter((e) => e.k === "act" && e.v === "reload:content")).toEqual([]);
  expect(tl.filter((e) => e.k === "req" && e.v === ids.list(FRESH))).toHaveLength(1);
  await expect(selected(page), "фокус остался на первом тайтле").toContainText(/фильм\s*1000/);
});
