import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { contentAction } from "../src/msx/actions.ts";
import { encodeListKey, ids } from "../src/router/ids.ts";
import type { ListKey } from "../src/router/ids.ts";
import { P, content, exec, expectContent, login, newMsxPage, noNotification, openMsx, mock } from "./fixtures.ts";
import { answered, attachDiagnostics, callCount, callsSince, installTimeline, mark, panel, red, selected, until } from "./flows-kit.ts";

// Фильтры каталога (спец. §11.5, v1.18) в web MSX пультом: красная кнопка списка сразу открывает панель «Сортировка и
// фильтры» (Option Shortcut), строка значения — свою панель, выбор заменяет список по флагу; фильтры уходят в `/v1/items`
// и видны в шапке списка; раздел помнит их, пока плагин не перезапущен; «Сбросить фильтры». Одна сессия web MSX на файл.

test.describe.configure({ mode: "serial" });

let page: Page;
const menuSelected = (p: Page) => p.locator("#appMainMenuItems .app-main-menu-item.selected");
/** Ключ пункта меню «Фильмы» (`screens/menu.ts`) и он же с фильтрами. */
const movies = (f: Partial<ListKey> = {}): string => encodeListKey({ src: "catalog", type: "movie", sort: "-updated", ...f });

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

/** Пункт меню по подписи — стрелками от выбранного: вниз до конца меню, затем вверх (порядок пунктов настраивается). */
async function toMenu(p: Page, label: string): Promise<void> {
  for (const key of ["ArrowDown", "ArrowUp"]) {
    for (let n = 0; n < 30 && (await menuSelected(p).innerText()) !== label; n++) {
      const before = await menuSelected(p).innerText();
      await p.keyboard.press(key);
      const moved = await expect(menuSelected(p)).not.toHaveText(before, { timeout: 1500 }).then(() => true, () => false);
      if (!moved) break;
    }
  }
  await expect(menuSelected(p)).toHaveText(label);
}

/** Фокус на плитках списка: после замены экрана и закрытия панели MSX мог оставить его в меню. */
async function intoGrid(p: Page): Promise<void> {
  if ((await selected(p).count()) === 0) await p.keyboard.press("ArrowRight");
  await expect(selected(p)).toContainText(/Тестовый\s*фильм/);
}

/** Строка панели — стрелками вниз от текущей, затем OK. */
async function pick(p: Page, row: string): Promise<void> {
  const sel = panel(p).locator(".selected");
  for (let n = 0; n < 12 && !(await sel.innerText()).includes(row); n++) await p.keyboard.press("ArrowDown");
  await expect(sel).toContainText(row);
  await p.keyboard.press("Enter");
}

/** Красная кнопка → «Сортировка и фильтры» → строка `row`; фокус панели — на первой строке. */
async function filtersRow(p: Page, row: string): Promise<void> {
  await intoGrid(p);
  await red(p);
  await expect(panel(p)).toContainText("Сортировка и фильтры");
  await expect(panel(p).locator(".selected")).toContainText("Сортировка: Обновлённые");
  await pick(p, row);
}

/** Панель значений `title` открыта с фокусом на текущем `now`; выбор `value` закрывает её и меняет список. */
async function choose(p: Page, title: string, now: string, value: string): Promise<void> {
  await expect(panel(p)).toContainText(title);
  await expect(panel(p).locator(".selected"), "фокус на текущем значении").toContainText(now);
  await pick(p, value);
  await expect(panel(p), "после выбора панелей нет").toBeHidden();
}

test("E-29: «Фильмы» из меню → красная → «Год: 2010-е» и «Рейтинг: КП ≥ 7» — year и conditions[] в mock, фильтры в шапке; раздел их помнит; «Сбросить фильтры»", async () => {
  await noNotification(page);
  const m0 = await mark(page);
  await toMenu(page, "Фильмы");
  await answered(page, ids.list(movies()), m0);
  await expectContent(page, "Обновлённые · 203 фильма");

  const c0 = await callCount();
  const m1 = await mark(page);
  await filtersRow(page, "Год: любой");
  await choose(page, "Год", "Любой", "2010-е");
  await answered(page, ids.list(movies({ year: "2010-2019" })), m1);
  await expectContent(page, /2010-е · \d+ фильм/);

  const m2 = await mark(page);
  await filtersRow(page, "Рейтинг: любой");
  await choose(page, "Рейтинг КП", "Любой", "КП ≥ 7");
  const filtered = movies({ year: "2010-2019", kp: "7" });
  await answered(page, ids.list(filtered), m2);
  const sent = (c: { q: URLSearchParams }): boolean => c.q.get("type") === "movie" && c.q.get("sort") === "-updated" &&
    c.q.get("year") === "2010-2019" && c.q.get("conditions[]") === "kinopoisk_rating>=7" && c.q.get("page") === "1";
  await expect.poll(async () => (await callsSince(c0, /^\/v1\/items$/)).some(sent), { message: "запрос с year и conditions[]", timeout: 5000 }).toBe(true);
  await expect(page.getByText(/2010-е · КП ≥ 7 · \d+ фильм/), "фильтры — в шапке списка").toBeVisible();
  await expectContent(page, /Тестовый\s*фильм/);

  // Панель показывает выбранное; «Сериалы» — свой раздел; обратно в «Фильмы» — фильтры на месте.
  await intoGrid(page);
  await red(page);
  await expect(panel(page)).toContainText("Год: 2010-е");
  await expect(panel(page)).toContainText("Рейтинг: КП ≥ 7");
  await expect(panel(page)).toContainText("Сбросить фильтры");
  await page.keyboard.press("Backspace");
  await expect(panel(page)).toBeHidden();
  await page.keyboard.press("Backspace");
  await expect(menuSelected(page)).toHaveText("Фильмы");
  const m3 = await mark(page);
  await toMenu(page, "Сериалы");
  await answered(page, ids.list(encodeListKey({ src: "catalog", type: "serial", sort: "-updated" })), m3);
  await expectContent(page, /Обновлённые · \d+ сериал/);
  await expect(content(page)).not.toContainText("2010-е");
  const m4 = await mark(page);
  await toMenu(page, "Фильмы");
  // До перезапуска MSX просит у пункта меню последний ключ после `replace:content` (E-22), иначе — ключ меню, и фильтры
  // раздела подставляет плагин: в обоих случаях — те же фильтры.
  const back = [ids.list(movies()), ids.list(filtered)];
  await until(page, (tl) => tl.some((e) => e.k === "res" && back.includes(e.v)), 10_000, "ответ «Фильмов»", m4);
  await expectContent(page, /2010-е · КП ≥ 7 · \d+ фильм/);

  const m5 = await mark(page);
  await filtersRow(page, "Сбросить фильтры");
  await expect(panel(page)).toBeHidden();
  await answered(page, ids.list(movies()), m5);
  await expectContent(page, "Обновлённые · 203 фильма");
  await expect(content(page)).not.toContainText("2010-е");
});

test("E-41: фильтры без результата — «Ничего не найдено с этими фильтрами» и «Сбросить фильтры» в фокусе; OK — полный список раздела, раздел без фильтров", async () => {
  await noNotification(page);
  const none = movies({ country: "50", kp: "8" });
  const m0 = await mark(page);
  await exec(page, contentAction(P, ids.list(none)));
  await answered(page, ids.list(none), m0);
  await expectContent(page, "Ничего не найдено с этими фильтрами");
  // MSX мог оставить фокус в меню: «вправо» — в контент, на элемент с `focus: true`.
  if ((await selected(page).count()) === 0) await page.keyboard.press("ArrowRight");
  await expect(selected(page), "фокус — на «Сбросить фильтры», а не на «Назад»").toContainText("Сбросить фильтры");
  const c0 = await callCount();
  const m1 = await mark(page);
  await page.keyboard.press("Enter");
  await answered(page, ids.list(movies()), m1);
  await expectContent(page, "Обновлённые · 203 фильма");
  await expect(content(page)).not.toContainText("Ничего не найдено");
  await expect(menuSelected(page), "«Сбросить» не уводит из раздела").toHaveText("Фильмы");
  expect((await callsSince(c0, /^\/v1\/items$/)).some((c) => c.q.get("country") !== null), "без страны").toBe(false);
});
