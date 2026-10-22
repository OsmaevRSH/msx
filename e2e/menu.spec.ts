import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { chain } from "../src/msx/actions.ts";
import { encodeListKey, ids } from "../src/router/ids.ts";
import { FIX } from "../tools/kpmock/fixtures.ts";
import {
  MOCK_URL, content, exec, expectContent, kp, login, menuItem, mock, msxMenuDialog, newMsxPage, noNotification, openMsx, press, stats,
} from "./fixtures.ts";
import {
  answer, answered, attachDiagnostics, closePlayer, evs, installTimeline, isPf, kpWith, mark, open, panel, red, selected, until, videoTime,
} from "./flows-kit.ts";

// Меню v1.11 (спец. §11 S3, S12, S15, S16): «Я смотрю» и «Спорт» пультом из меню, подборки, «Пункты меню» — скрытый
// пункт исчезает из меню MSX сразу, под открытой панелью (`[replace:menu|reload:panel]`). v1.13 (§11.1): обе настройки
// порядка — первыми строками настроек, «Секции главной» меняют главную. v1.16 (E-25): в конце меню один пункт «Настройки»,
// системные настройки MSX — строкой их группы «Для разработчика». Одна сессия web MSX на файл.

test.describe.configure({ mode: "serial" });

let page: Page;
const menuSelected = (p: Page) => p.locator("#appMainMenuItems .app-main-menu-item.selected");
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

test("E-17: «Я смотрю» вторым пунктом меню — сериал с меньшим остатком серий («+5») первым, фильм с остатком; плитка → карточка → «Назад» на ту же плитку", async () => {
  await noNotification(page);
  await expect(menuSelected(page)).toHaveText("Главная");
  const m0 = await mark(page);
  await page.keyboard.press("ArrowDown");
  await expect(menuSelected(page)).toHaveText("Я смотрю");
  await answered(page, ids.watching(), m0);
  await expectContent(page, "2 сериала · 1 фильм");
  const w = await answer(page, ids.watching());
  // QA-API-2: «Короткий» — 5 серий из 6 впереди, «Большой» — 197 из 200: первым — меньший остаток; «+N» — только при 1–5.
  expect(w.items.map((i: { id: string }) => i.id)).toEqual([`i${FIX.SERIAL_SMALL}`, `i${FIX.SERIAL_BIG}`, `i${FIX.MOVIE_SIMPLE}`]);
  await expect(content(page).getByText("+5", { exact: true }), "бейдж остатка серий на постере").toBeVisible();
  await expect(content(page).getByText("+197", { exact: true }), "у начатого длинного сериала бейджа нет").toHaveCount(0);
  await expectContent(page, "1 ч 10 м");

  const m1 = await mark(page);
  await page.keyboard.press("ArrowRight");
  await until(page, (x) => x.some(isPf), 3000, "pf первой плитки", m1);
  await expect(selected(page), "фокус на сериале с меньшим остатком").toContainText("Короткий");
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

test("E-20: «Пункты меню» с первой строки настроек — скрыть «Я смотрю» и поднять «Поиск» пультом: меню меняется сразу, «Сбросить» возвращает", async () => {
  // Настройки — корневой экран пункта меню: только там MSX выполняет `replace:menu`. `home` закрывает вложенные экраны
  // (подборку и «Подборки»), `cleanup` — системное «Меню» MSX; «Назад» с корня «Спорта» — в меню.
  await exec(page, chain(["home", "cleanup"]));
  await expect(msxMenuDialog(page)).toBeHidden();
  await expectContent(page, "Эфир · 6 каналов");
  await page.keyboard.press("Backspace");
  await expect(menuSelected(page)).toHaveText("Спорт");
  await page.keyboard.press("ArrowDown");
  await expect(menuSelected(page), "разделитель пропускается").toHaveText("Настройки");
  await expectContent(page, "Воспроизведение");
  // Из меню в контент: фокус на первой строке настроек — порядке пунктов меню (v1.13), OK открывает панель.
  await page.keyboard.press("ArrowRight");
  await expect(selected(page)).toContainText("Порядок и видимость пунктов меню");
  await page.keyboard.press("Enter");
  await expect(panel(page)).toContainText("Пункты меню");
  const sel = panel(page).locator(".selected");
  // Фикс 2026-10-22: фокус при открытии — на «▲» первой строки (OK там ничего не меняет), название — левее.
  await page.keyboard.press("ArrowLeft");
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
  await expect(content(page), "экран настроек остался под панелью").toContainText("Порядок и видимость пунктов меню");

  await kp(page, (k) => k.ctx.host.executeAction("focus:m_reset"));
  await expect(sel).toContainText("Сбросить по умолчанию");
  await page.keyboard.press("Enter");
  await expect(menuItem(page, "Я смотрю"), "после сброса пункт вернулся").toHaveCount(1);
  await expect(page.locator("#appMainMenuItems .app-main-menu-item").first()).toHaveText("Главная");
  expect(await kp(page, (k) => k.ctx.store.get("cfg", "menu") ?? null)).toBeNull();
  await page.keyboard.press("Backspace");
  await expect(panel(page)).toBeHidden();
});

test("E-21: «Секции главной» — скрыть «Новые фильмы» и поднять «Закладки» пультом: главная при показе такая же и без запроса скрытой полки; красная кнопка главной — «Сбросить» сразу", async () => {
  // После E-20 открыты настройки, фокус — на первой строке; вторая — «Секции главной».
  await expect(selected(page)).toContainText("Порядок и видимость пунктов меню");
  await page.keyboard.press("ArrowDown");
  await expect(selected(page)).toContainText("Порядок и видимость секций главной");
  await page.keyboard.press("Enter");
  await expect(panel(page)).toContainText("Секции главной");
  const sel = panel(page).locator(".selected");
  await page.keyboard.press("ArrowLeft");
  await expect(sel, "фокус на первой полке").toContainText("Продолжить просмотр");
  await page.keyboard.press("ArrowDown");
  await expect(sel).toContainText("Новые фильмы");
  await page.keyboard.press("Enter");
  await expect.poll(() => kp(page, (k) => k.ctx.store.get("cfg", "home") ?? null), { timeout: 5000 }).toEqual({ hidden: ["fm"], v: 2 });
  await expect(sel, "фокус остался на той же строке").toContainText("Новые фильмы");
  await expect(content(page), "сводка строки под панелью обновилась").toContainText("7 из 8");
  // «Закладки» — двумя строками ниже: →, →, → (⤒) и OK — в начало.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(sel).toContainText("Закладки");
  for (let n = 0; n < 3; n++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect.poll(() => kp(page, (k) => k.ctx.store.get("cfg", "home")?.order?.[0] ?? null), { timeout: 5000 }).toBe("b");
  await page.keyboard.press("Backspace");
  await expect(panel(page)).toBeHidden();

  // Главная из меню: MSX запрашивает её заново (`cache: false`) — «Закладки» первыми, «Новых фильмов» нет и у KinoPub.
  await page.keyboard.press("Backspace");
  await expect(menuSelected(page)).toHaveText("Настройки");
  const calls = (await mock.calls()).length;
  const m0 = await mark(page);
  for (let n = 0; n < 30 && (await menuSelected(page).innerText()) !== "Главная"; n++) await page.keyboard.press("ArrowDown");
  await answered(page, ids.home(), m0);
  const shelves = async (): Promise<string[]> =>
    ((await answer(page, ids.home())).pages ?? []).map((p: { items: { type?: string; headline?: string }[] }) => p.items.find((i) => i.type === "space")?.headline ?? "");
  expect(await shelves()).toEqual(["Закладки", "Продолжить просмотр", "Новые сериалы", "Популярные фильмы", "Популярные сериалы", "Горячее: фильмы", "Горячее: сериалы"]);
  await expectContent(page, "Закладки");
  const fresh = (await mock.calls()).slice(calls).filter((c) => c.path === "/v1/items/fresh");
  expect(fresh.filter((c) => /(^|&)type=movie(&|$)/.test(c.query)), "скрытая полка не запрашивается").toEqual([]);

  // Красная кнопка (в web MSX — F1) на главной → «Секции главной» → «Сбросить по умолчанию»: главная текущая —
  // заменяется сразу, под панелью (`[replace:content:home|reload:panel]`).
  await page.keyboard.press("ArrowRight");
  await expect(selected(page), "фокус на полке «Закладки»").toContainText("Избранное");
  await page.keyboard.press("F1");
  await expect(panel(page).locator(".selected"), "опции главной").toContainText("Секции главной");
  const m1 = await mark(page);
  await page.keyboard.press("Enter");
  await answered(page, ids.panel("home"), m1);
  await page.keyboard.press("ArrowLeft");
  await expect(sel).toContainText("Закладки");
  await kp(page, (k) => k.ctx.host.executeAction("focus:m_reset"));
  await expect(sel).toContainText("Сбросить по умолчанию");
  const m2 = await mark(page);
  await page.keyboard.press("Enter");
  await answered(page, ids.home(), m2);
  expect(await kp(page, (k) => k.ctx.store.get("cfg", "home") ?? null)).toBeNull();
  expect(await shelves(), "умолчание — сразу, панель ещё открыта").toEqual([
    "Продолжить просмотр", "Новые фильмы", "Новые сериалы", "Закладки", "Популярные фильмы", "Популярные сериалы", "Горячее: фильмы", "Горячее: сериалы",
  ]);
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press("Backspace");
  await expect(panel(page)).toBeHidden();
  await expectContent(page, "Новые фильмы");
});

test("E-36 (фикс 2026-10-22): красная кнопка главной, OK, OK — «Продолжить просмотр» не скрывается; kp.cfg.home старой версии со скрытой «Продолжить» её возвращает", async () => {
  const shelves = async (): Promise<string[]> =>
    ((await answer(page, ids.home())).pages ?? []).map((p: { items: { type?: string; headline?: string }[] }) => p.items.find((i) => i.type === "space")?.headline ?? "");
  // После E-21 открыта главная по умолчанию, фокус — в контенте. Отзыв с ТВ: «пропала карусель „Продолжить просмотр“».
  await page.keyboard.press("F1");
  await expect(panel(page).locator(".selected"), "опции главной").toContainText("Секции главной");
  const m0 = await mark(page);
  await page.keyboard.press("Enter");
  await answered(page, ids.panel("home"), m0);
  // Второе OK — на «▲» первой строки (`act:home:up:c`): настройка не меняется, панель перерисована, «Продолжить» на месте.
  const ma = await mark(page);
  await page.keyboard.press("Enter");
  await answered(page, ids.panel("home"), ma);
  expect(await kp(page, (k) => k.ctx.store.get("cfg", "home") ?? null)).toBeNull();
  await page.keyboard.press("ArrowLeft");
  await expect(panel(page).locator(".selected")).toContainText("Продолжить просмотр");
  await page.keyboard.press("Backspace");
  await expect(panel(page)).toBeHidden();
  const m1 = await mark(page);
  await kp(page, (k) => k.ctx.host.executeAction("reload:content"));
  await answered(page, ids.home(), m1);
  expect((await shelves())[0]).toBe("Продолжить просмотр");
  expect(await kp(page, (k) => k.ctx.store.get("cfg", "home") ?? null)).toBeNull();

  // kp.cfg.home v1.13–v1.20 (без `v`) со скрытой «Продолжить» и «Горячее: сериалы»: «Продолжить» возвращается первой,
  // остальной выбор остаётся, настройка перезаписана с `v: 2`.
  await kp(page, (k) => k.ctx.store.set("cfg", "home", { hidden: ["c", "hs"] }));
  const m2 = await mark(page);
  await kp(page, (k) => k.ctx.host.executeAction("reload:content"));
  await answered(page, ids.home(), m2);
  expect(await shelves()).toEqual(["Продолжить просмотр", "Новые фильмы", "Новые сериалы", "Закладки", "Популярные фильмы", "Популярные сериалы", "Горячее: фильмы"]);
  await expectContent(page, "Продолжить просмотр");
  expect(await kp(page, (k) => k.ctx.store.get("cfg", "home") ?? null)).toEqual({ hidden: ["hs"], v: 2 });
  await kp(page, (k) => k.ctx.store.remove("cfg", "home"));
  const m3 = await mark(page);
  await kp(page, (k) => k.ctx.host.executeAction("reload:content"));
  await answered(page, ids.home(), m3);
  await expect(selected(page), "фокус в контенте главной").toBeVisible();
});

test("E-22: «Новинки» из меню — вкладка «Фильмы» с `type`; красная кнопка → «Тип» → «Сериалы» заменяет список и запоминается; «Подборки» без «0 шт.»", async () => {
  const alias = encodeListKey({ src: "fresh" });
  const serials = encodeListKey({ src: "fresh", type: "serial" });
  const typeOf = (c: { query: string }): string | null => new URLSearchParams(c.query).get("type");
  // После E-21 открыта главная, фокус — в контенте: в меню и вниз до «Новинок».
  await page.keyboard.press("Backspace");
  await expect(menuSelected(page)).toHaveText("Главная");
  const c0 = (await mock.calls()).length;
  const m0 = await mark(page);
  for (let n = 0; n < 30 && (await menuSelected(page).innerText()) !== "Новинки"; n++) await page.keyboard.press("ArrowDown");
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

test("E-25: в конце меню один пункт «Настройки» (v1.16); «Для разработчика» — последней группой, «Системные настройки MSX» открывают настройки MSX, «Назад» — к «Настройкам»", async () => {
  // После E-22 фокус в меню на «Подборках»: вниз до «Настроек».
  const items = page.locator("#appMainMenuItems .app-main-menu-item");
  await expect(items.last()).toHaveText("Настройки");
  await expect(items.filter({ hasText: /^Настройки$/ })).toHaveCount(1);
  await expect(menuItem(page, "Диагностика")).toHaveCount(0);
  const m0 = await mark(page);
  for (let n = 0; n < 30 && (await menuSelected(page).innerText()) !== "Настройки"; n++) await page.keyboard.press("ArrowDown");
  await expect(menuSelected(page)).toHaveText("Настройки");
  await answered(page, ids.settings(), m0);
  await expectContent(page, "Порядок и видимость пунктов меню");
  const s = await answer(page, ids.settings());
  expect(s.items.filter((i: { headline?: string }) => i.headline !== undefined).at(-1).headline).toBe("Для разработчика");

  await page.keyboard.press("ArrowRight");
  await expect(selected(page)).toContainText("Порядок и видимость пунктов меню");
  await exec(page, "focus:s_probe");
  await expect(selected(page)).toContainText("Диагностика");
  await page.keyboard.press("ArrowDown");
  await expect(selected(page)).toContainText("Системные настройки MSX");
  await page.keyboard.press("ArrowDown");
  await expect(selected(page), "вниз с последней строки — на месте").toContainText("Системные настройки MSX");
  await page.keyboard.press("Enter");
  await expectContent(page, "Стартовый параметр");
  await page.keyboard.press("Backspace");
  await expectContent(page, "Системные настройки MSX");
  await expect(selected(page)).toContainText("Системные настройки MSX");

  // В меню: после «Настроек» пунктов нет — MSX листает меню по кругу на «Главную».
  await page.keyboard.press("Backspace");
  await expect(menuSelected(page)).toHaveText("Настройки");
  await page.keyboard.press("ArrowDown");
  await expect(menuSelected(page)).toHaveText("Главная");
});

test("E-42 (QA-API-7, M-2): серия нового сериала начата и не досмотрена — он первым в «Продолжить» с тегом «1×1»", async () => {
  // Другой ТВ начал первую серию «Длинного» (5 мин): досмотренных серий нет, а KinoPub отдаёт его в `watching/serials`
  // как недосмотренный (`subscribed=0`). Кэш главной у этого ТВ устарел, как после своего просмотра.
  const { access } = (await (await fetch(`${MOCK_URL}/__mock/token`, { method: "POST" })).json()) as { access: string };
  const q = new URLSearchParams({ id: String(FIX.SERIAL_LONG), season: "1", video: "1", time: "300", access_token: access });
  expect((await fetch(`${MOCK_URL}/v1/watching/marktime?${q}`)).status, "marktime другого ТВ").toBe(200);
  await kpWith(page, (k, id) => k.ctx.repo.invalidateAfterProgress(id), FIX.SERIAL_LONG);
  const c0 = (await mock.calls()).length;
  await open(page, ids.home());
  const first = async (): Promise<unknown[]> => {
    const tile = (await answer(page, ids.home()))?.pages?.[0]?.items?.find((i: { action?: string }) => i.action !== undefined);
    return [tile?.id, tile?.tag];
  };
  await expect.poll(first, { message: "после сверки главной «Длинный» — первым в «Продолжить»", timeout: 15_000 })
    .toEqual([`c${FIX.SERIAL_LONG}`, "1×1"]);
  await expectContent(page, "сериал «Длинный»");
  const unfinished = (await mock.calls()).slice(c0)
    .filter((c) => c.path === "/v1/watching/serials" && new URLSearchParams(c.query).get("subscribed") === "0");
  expect(unfinished.some((c) => c.status === 200), "сериал пришёл из списка недосмотренных").toBe(true);
});
