import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { chain } from "../src/msx/actions.ts";
import { encodeListKey, ids } from "../src/router/ids.ts";
import { FIX } from "../tools/kpmock/fixtures.ts";
import {
  content, exec, expectContent, kp, login, menuItem, mock, msxMenuDialog, newMsxPage, noNotification, openMsx, press, stats,
} from "./fixtures.ts";
import {
  answer, answered, attachDiagnostics, closePlayer, evs, installTimeline, isPf, mark, open, panel, selected, until, videoTime,
} from "./flows-kit.ts";

// Меню v1.11 (спец. §11 S3, S12, S15, S16): «Я смотрю» и «Спорт» пультом из меню, подборки, «Пункты меню» — скрытый
// пункт исчезает из меню MSX сразу, под открытой панелью (`[replace:menu|reload:panel]`). Одна сессия web MSX на файл.

test.describe.configure({ mode: "serial" });

let page: Page;
const menuSelected = (p: Page) => p.locator("#appMainMenuItems .app-main-menu-item.selected");
/** Красная кнопка ТВ: в web MSX у неё нет клавиши клавиатуры, поэтому — код пульта Samsung (`ColorF0Red`, 403). */
async function red(p: Page): Promise<void> {
  const cdp = await p.context().newCDPSession(p);
  const key = { windowsVirtualKeyCode: 403, nativeVirtualKeyCode: 403, key: "ColorF0Red", code: "ColorF0Red" };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  await cdp.detach();
}

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

test("E-17: «Я смотрю» вторым пунктом меню — сериал с «+2» первым, фильм с остатком; плитка → карточка → «Назад» на ту же плитку", async () => {
  await noNotification(page);
  await expect(menuSelected(page)).toHaveText("Главная");
  const m0 = await mark(page);
  await page.keyboard.press("ArrowDown");
  await expect(menuSelected(page)).toHaveText("Я смотрю");
  await answered(page, ids.watching(), m0);
  await expectContent(page, "2 сериала · 1 фильм");
  const w = await answer(page, ids.watching());
  expect(w.items.map((i: { id: string }) => i.id)).toEqual([`i${FIX.SERIAL_BIG}`, `i${FIX.SERIAL_SMALL}`, `i${FIX.MOVIE_SIMPLE}`]);
  await expect(content(page).getByText("+2", { exact: true }), "бейдж новых серий на постере").toBeVisible();
  await expectContent(page, "1 ч 10 м");

  const m1 = await mark(page);
  await page.keyboard.press("ArrowRight");
  await until(page, (x) => x.some(isPf), 3000, "pf первой плитки", m1);
  await expect(selected(page), "фокус на сериале с новыми сериями").toContainText("Большой");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(selected(page)).toContainText("Простой");
  const m2 = await mark(page);
  await page.keyboard.press("Enter");
  await answered(page, ids.item(FIX.MOVIE_SIMPLE), m2);
  await expectContent(page, "Тестовый фильм «Простой»");
  // «вверх» на первом ряду — страж края: фокус остаётся на плитке, а не уходит по кругу.
  await page.keyboard.press("Backspace");
  await expect(selected(page), "после «Назад» фокус на той же плитке").toContainText("Простой");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(500);
  await expect(selected(page), "без перехода по кругу").toContainText("Простой");
  await page.keyboard.press("Backspace");
  await expect(menuSelected(page)).toHaveText("Я смотрю");
});

test("E-18: «Спорт» из меню — каналы эфира; канал играет прямой эфир без resolve и без marktime", async () => {
  for (let n = 0; n < 30 && (await menuSelected(page).innerText()) !== "Спорт"; n++) await page.keyboard.press("ArrowDown");
  await expect(menuSelected(page)).toHaveText("Спорт");
  await expectContent(page, "Эфир · 6 каналов");
  await expectContent(page, "Тестовый спорт 1");
  await page.keyboard.press("ArrowRight");
  await expect(selected(page)).toContainText("Тестовый спорт 1");
  const calls = (await mock.calls()).length;
  const m = await mark(page);
  await page.keyboard.press("Enter");
  await until(page, (x) => evs(x, "handleEvent:video:load").length > 0, 15_000, "video:load эфира", m);
  await expect.poll(() => videoTime(page), { message: "эфир играет (WebM mock)", timeout: 15_000, intervals: [200] }).toBeGreaterThan(0.5);
  expect(await kp(page, (k) => k.ctx.tracker.session() === undefined), "эфир — не просмотр: сессии нет").toBe(true);
  await closePlayer(page);
  const after = (await mock.calls()).slice(calls);
  expect(after.filter((c) => c.path.startsWith("/v1/watching") || c.path === "/v1/items/media-links"), "без marktime и resolve").toEqual([]);
});

test("E-19: «Подборки» — плитки подборок, подборка открывается своим списком с названием", async () => {
  const key = encodeListKey({ src: "collections" });
  await open(page, ids.list(key));
  await expectContent(page, "Новые · 60 подборок");
  const first = (await answer(page, ids.list(key))).items[0];
  // Название плитки — в две строки: «Тестовая» и «подборка «…» N».
  await press(page, first.id, "Тестовая");
  const id = Number(String(first.id).slice(1));
  const coll = ids.list(encodeListKey({ src: "collection", id }));
  await answered(page, coll, 0);
  const list = await answer(page, coll);
  expect(list.headline, "заголовок списка — название подборки из collections/view").toBe(first.kt);
  expect(list.items.length).toBeGreaterThan(0);
  await expect(selected(page), "фокус на первом тайтле подборки").toContainText("Тестов");
  expect((await stats(page)).requests.at(-1)).toBe(coll);
});

test("E-20: «Пункты меню» — скрыть «Я смотрю» и поднять «Поиск» пультом: меню меняется сразу, «Сбросить» возвращает", async () => {
  // Настройки — корневой экран пункта меню: только там MSX выполняет `replace:menu`. `home` закрывает вложенные экраны
  // (подборку и «Подборки»), `cleanup` — системное «Меню» MSX; «Назад» с корня «Спорта» — в меню.
  await exec(page, chain(["home", "cleanup"]));
  await expect(msxMenuDialog(page)).toBeHidden();
  await expectContent(page, "Эфир · 6 каналов");
  await page.keyboard.press("Backspace");
  await expect(menuSelected(page)).toHaveText("Спорт");
  await page.keyboard.press("ArrowDown");
  await expect(menuSelected(page), "разделитель пропускается").toHaveText("Просмотр и аккаунт");
  await expectContent(page, "Воспроизведение");
  // Из меню в контент: `focus:` MSX выполняет только в нём.
  await page.keyboard.press("ArrowRight");
  await expect(selected(page)).toContainText("Максимальное качество");
  await press(page, "s_menu", "Пункты меню");
  await expect(panel(page)).toContainText("Пункты меню");
  const sel = panel(page).locator(".selected");
  await expect(sel, "фокус на первом пункте").toContainText("Главная");
  await page.keyboard.press("ArrowDown");
  await expect(sel).toContainText("Я смотрю");
  await page.keyboard.press("Enter");
  await expect(menuItem(page, "Я смотрю"), "скрытый пункт исчез из меню MSX").toHaveCount(0);
  await expect(sel, "фокус остался на той же строке").toContainText("Я смотрю");
  expect(await kp(page, (k) => k.ctx.store.get("cfg", "menu"))).toEqual({ hidden: ["watching"] });

  // «Поиск» — строкой ниже: «▲» дважды поднимает его в начало.
  await page.keyboard.press("ArrowDown");
  await expect(sel).toContainText("Поиск");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.locator("#appMainMenuItems .app-main-menu-item").first()).toHaveText("Главная");
  await expect.poll(() => kp(page, (k) => (k.ctx.store.get("cfg", "menu")?.order ?? []).slice(0, 2)), { timeout: 5000 }).toEqual(["home", "search"]);
  await page.keyboard.press("Enter");
  await expect(page.locator("#appMainMenuItems .app-main-menu-item").first(), "«Поиск» первым пунктом меню").toHaveText("Поиск");
  await expect(content(page), "экран настроек остался под панелью").toContainText("Пункты меню");

  await kp(page, (k) => k.ctx.host.executeAction("focus:m_reset"));
  await expect(sel).toContainText("Сбросить по умолчанию");
  await page.keyboard.press("Enter");
  await expect(menuItem(page, "Я смотрю"), "после сброса пункт вернулся").toHaveCount(1);
  await expect(page.locator("#appMainMenuItems .app-main-menu-item").first()).toHaveText("Главная");
  expect(await kp(page, (k) => k.ctx.store.get("cfg", "menu") ?? null)).toBeNull();
  await page.keyboard.press("Backspace");
  await expect(panel(page)).toBeHidden();
});

test("E-21: «Новинки» из меню — вкладка «Фильмы» с `type`; красная кнопка → «Тип» → «Сериалы» заменяет список и запоминается; «Подборки» без «0 шт.»", async () => {
  const alias = encodeListKey({ src: "fresh" });
  const serials = encodeListKey({ src: "fresh", type: "serial" });
  const typeOf = (c: { query: string }): string | null => new URLSearchParams(c.query).get("type");
  // После E-20 открыт экран «Просмотр и аккаунт»: в меню и вверх до «Новинок».
  await page.keyboard.press("Backspace");
  await expect(menuSelected(page)).toHaveText("Просмотр и аккаунт");
  const c0 = (await mock.calls()).length;
  const m0 = await mark(page);
  for (let n = 0; n < 30 && (await menuSelected(page).innerText()) !== "Новинки"; n++) await page.keyboard.press("ArrowUp");
  await expect(menuSelected(page)).toHaveText("Новинки");
  await answered(page, ids.list(alias), m0);
  await expectContent(page, /Фильмы · \d+ фильм/);
  const fresh = (await mock.calls()).slice(c0).filter((c) => c.path === "/v1/items/fresh");
  expect(fresh.map((c) => [typeOf(c), c.status]), "полка — всегда с типом, без 400").toContainEqual(["movie", 200]);
  expect(fresh.filter((c) => c.status !== 200 || typeOf(c) !== "movie")).toEqual([]);

  // Красная кнопка пульта Samsung (keyCode 403) — Option Shortcut: сразу панель вкладок, фокус на текущей.
  await page.keyboard.press("ArrowRight");
  await expect(selected(page)).toContainText(/Тестовый\s*фильм/);
  const m1 = await mark(page);
  await red(page);
  await expect(panel(page)).toContainText("Док. сериалы");
  const sel = panel(page).locator(".selected");
  await expect(sel).toContainText("Фильмы");
  await page.keyboard.press("ArrowRight");
  await expect(sel).toContainText("Сериалы");
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeHidden();
  await answered(page, ids.list(serials), m1);
  await expectContent(page, /Сериалы · \d+ сериал/);
  expect((await stats(page)).requests.at(-1)).toBe(ids.list(serials));
  expect(await kp(page, (k) => k.ctx.store.get("cfg", "shelf"))).toEqual({ fresh: "serial" });

  // «Поиск» и обратно — «Новинки» сериалами. После `replace:content` MSX до перезапуска запрашивает у пункта меню новый
  // ключ (с типом); после перезапуска — ключ меню, и тип даёт `kp.cfg.shelf` (unit-тест «type panel»).
  await page.keyboard.press("Backspace");
  await expect(menuSelected(page)).toHaveText("Новинки");
  const mSearch = await mark(page);
  await page.keyboard.press("ArrowUp");
  await expect(menuSelected(page)).toHaveText("Поиск");
  await answered(page, ids.search(), mSearch);
  const m2 = await mark(page);
  await page.keyboard.press("ArrowDown");
  await expect(menuSelected(page)).toHaveText("Новинки");
  const shelf = [ids.list(alias), ids.list(serials)];
  await until(page, (tl) => tl.some((e) => e.k === "res" && shelf.includes(e.v)), 10_000, "ответ «Новинок»", m2);
  await expectContent(page, /Сериалы · \d+ сериал/);

  // Тот же пункт через кнопку опций (F12 web MSX): опции закрываются (`cleanup`), над списком — только панель вкладок.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("F12");
  await expect(panel(page)).toContainText("Тип: Сериалы");
  await page.keyboard.press("Enter");
  await expect(panel(page)).toContainText("Док. сериалы");
  await expect(sel).toContainText("Сериалы");
  const m3 = await mark(page);
  await page.keyboard.press("ArrowLeft");
  await expect(sel).toContainText("Фильмы");
  await page.keyboard.press("Enter");
  await expect(panel(page), "после выбора панелей нет — и опций тоже").toBeHidden();
  await answered(page, ids.list(encodeListKey({ src: "fresh", type: "movie" })), m3);
  await expectContent(page, /Фильмы · \d+ фильм/);
  expect(await kp(page, (k) => k.ctx.store.get("cfg", "shelf") ?? null), "«Фильмы» — умолчание, не хранится").toBeNull();
  await page.keyboard.press("Backspace");
  await expect(menuSelected(page)).toHaveText("Новинки");

  // «Подборки»: числа тайтлов API не отдаёт — у плиток нет подписи «N шт.», и «0 шт.» тоже нет.
  for (let n = 0; n < 30 && (await menuSelected(page).innerText()) !== "Подборки"; n++) await page.keyboard.press("ArrowDown");
  await expect(menuSelected(page)).toHaveText("Подборки");
  await expectContent(page, "Новые · 60 подборок");
  await expectContent(page, "Тестовая");
  await expect(content(page), "подпись количества у подборок").not.toContainText("шт.");
  expect((await answer(page, ids.list(encodeListKey({ src: "collections" })))).items.every((i: { titleFooter?: string }) => i.titleFooter === undefined)).toBe(true);
});
