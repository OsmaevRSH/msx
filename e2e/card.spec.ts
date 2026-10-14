import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ids } from "../src/router/ids.ts";
import { FIX, castOf, findItem } from "../tools/kpmock/fixtures.ts";
import { content, exec, expectContent, kp, login, mock, newMsxPage, noNotification, openMsx, press } from "./fixtures.ts";
import {
  acts, answer, answered, attachDiagnostics, callCount, callsSince, closePlayer, evs, installTimeline, mark, open, panel, selected, until,
  videoTime,
} from "./flows-kit.ts";

// Пакет «Карточка» v1.16 (спец. §11 S8, S9) в web MSX: «Буду смотреть» переключается, сезон отмечается целиком, поиск
// по актёру открывает список его тайтлов, трейлер запускается без прогресса. Одна сессия web MSX на файл.

test.describe.configure({ mode: "serial" });

let page: Page;
const BIG = FIX.SERIAL_BIG;
const ACTOR = castOf(findItem(BIG)!)[0]!;
/** Сериал mock из одного сезона (у id, кратного 3, сезон один): красная кнопка открывает опции, а не «Сезоны…». */
const ONE = [...Array(500).keys()].map((i) => 1000 + i).find((id) => findItem(id)?.type === "serial" && id % 3 === 0)!;
const episodes = (s: { items?: { id?: string; badge?: string }[] }): { id?: string; badge?: string }[] =>
  (s.items ?? []).filter((i) => /^e\d+$/.test(i.id ?? ""));

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

/**
 * Фокус на элементе `id` (как с пульта), красная кнопка без ярлыка — его опции (в web MSX красная — F1, код пульта 403
 * выполняет только ярлыки `key: "red"`, как в menu.spec.ts); фокус — на пункте с подписью `label`.
 */
async function option(p: Page, id: string, label: string): Promise<void> {
  await noNotification(p);
  await exec(p, `focus:${id}`);
  await expect(selected(p)).toBeVisible();
  await p.keyboard.press("F1");
  const sel = panel(p).locator(".selected");
  await expect(panel(p)).toContainText(label);
  for (let n = 0; n < 12 && !(await sel.innerText()).includes(label); n++) await p.keyboard.press("ArrowDown");
  await expect(sel).toContainText(label);
}

test("E-24: «Буду смотреть» на карточке сериала — сверка, один togglewatchlist, подпись кнопки и «Я смотрю»", async () => {
  await open(page, ids.item(BIG));
  await expectContent(page, "✓ В списке");
  const c0 = await callCount();
  const m = await mark(page);
  await press(page, "b_wl", "В списке");
  await until(page, (x) => acts(x, "reload:content").length > 0, 10_000, "перерисовка карточки", m);
  await expectContent(page, "★ Буду смотреть");
  const toggles = await callsSince(c0, /^\/v1\/watching\/togglewatchlist$/);
  expect(toggles.map((c) => c.q.get("id")), "один переключатель, без повторов").toEqual([String(BIG)]);
  expect((await callsSince(c0, /^\/v1\/items\/\d+$/)).length, "свежая карточка до и после").toBeGreaterThanOrEqual(2);

  // «Я смотрю» устарел: экран отдаётся из кэша и заменяется сверкой — сериала в нём больше нет.
  await open(page, ids.watching());
  await expect(content(page)).not.toContainText("Большой", { timeout: 15_000 });

  await open(page, ids.item(BIG));
  await press(page, "b_wl", "Буду смотреть");
  await expectContent(page, "✓ В списке");
  expect((await callsSince(c0, /^\/v1\/watching\/togglewatchlist$/)).length).toBe(2);
});

test("E-25: сезон отмечается целиком — опции → «Отметить сезон» → toggle без video, ✓ на всех сериях", async () => {
  await open(page, ids.season(ONE, 1));
  await expectContent(page, "Серия 1");
  await option(page, `e${ONE * 1000 + 1}`, "Отметить сезон");
  const c0 = await callCount();
  const m = await mark(page);
  await page.keyboard.press("Enter");
  await until(page, (x) => acts(x, "[cleanup|reload:content]").length > 0, 10_000, "опции закрыты, сезон перерисован", m);
  await expect(panel(page)).toBeHidden();
  const toggles = await callsSince(c0, /^\/v1\/watching\/toggle$/);
  expect(toggles.map((c) => [c.q.get("season"), c.q.has("video")]), "сезон одним toggle без video").toEqual([["1", false]]);
  await expect.poll(async () => episodes(await answer(page, ids.season(ONE, 1))).every((e) => e.badge === "✓"),
    { message: "✓ на всех сериях сезона", timeout: 10_000 }).toBe(true);
  await expect(content(page).getByText("✓").first()).toBeVisible();
  // Обратно — «Снять отметки сезона»: сезон снова без отметок.
  await option(page, `e${ONE * 1000 + 1}`, "Снять отметки сезона");
  await page.keyboard.press("Enter");
  await expect.poll(async () => episodes(await answer(page, ids.season(ONE, 1))).every((e) => e.badge === undefined),
    { message: "отметки сняты", timeout: 10_000 }).toBe(true);
});

test("E-26: поиск по актёру — карточка → опции → «В ролях: …» → список его тайтлов (field=cast)", async () => {
  await open(page, ids.item(BIG));
  await option(page, "b_main", `В ролях: ${ACTOR}`);
  const c0 = await callCount();
  const m = await mark(page);
  await page.keyboard.press("Enter");
  await answered(page, ids.person("cast", ACTOR), m);
  await expect(panel(page), "опции закрыты").toBeHidden();
  await expect(page.getByText(`В ролях: ${ACTOR}`).first()).toBeVisible();
  await expectContent(page, /Тестов/);
  const q = (await callsSince(c0, /^\/v1\/items\/search$/)).map((c) => [c.q.get("q"), c.q.get("field"), c.q.get("page")]);
  expect(q[0]).toEqual([ACTOR, "cast", "1"]);
  const tiles = ((await answer(page, ids.person("cast", ACTOR))).items ?? []).filter((i: { id?: string }) => /^i\d+$/.test(i.id ?? ""));
  expect(tiles.length, "плитки тайтлов актёра").toBeGreaterThan(0);
});

test("E-27: трейлер — «Трейлер» → resolve play:<id>:trailer → видео играет, marktime нет", async () => {
  await open(page, ids.item(FIX.MOVIE_SIMPLE));
  const c0 = await callCount();
  const m = await mark(page);
  await press(page, "b_trailer", "Трейлер");
  await answered(page, ids.playTrailer(FIX.MOVIE_SIMPLE), m);
  const res = await answer(page, ids.playTrailer(FIX.MOVIE_SIMPLE));
  expect(res.url).toMatch(/\/cdn\/media\/sample\.webm\?trailer=\d+$/);
  await until(page, (x) => evs(x, "handleEvent:video:load").length > 0, 15_000, "video:load трейлера", m);
  await expect.poll(() => videoTime(page), { message: "трейлер играет", timeout: 15_000, intervals: [200] }).toBeGreaterThan(1);
  expect(await kp(page, (k) => k.ctx.tracker.session() === undefined), "трейлер — не просмотр: сессии нет").toBe(true);
  expect(await callsSince(c0, /^\/v1\/items\/trailer$/), "ссылка — из items/trailer").toHaveLength(1);
  await closePlayer(page);
  await expectContent(page, "Тестовый фильм «Простой»");
  expect(await callsSince(c0, /^\/v1\/watching\/(marktime|toggle)$/), "трейлер — не просмотр: ни marktime, ни toggle").toEqual([]);
});
