import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { chain, commitMsg, contentAction, panelAction, replaceContent, resolveAction } from "../src/msx/actions.ts";
import { encodeListKey, ids, listFlag, msgs } from "../src/router/ids.ts";
import { FIX, findItem } from "../tools/kpmock/fixtures.ts";
import { P, content, exec, expectContent, kp, login, mock, newMsxPage, noNotification, openMsx, press, stats } from "./fixtures.ts";
import {
  ITEM_PATH, acts, answer, answered, attachDiagnostics, callCount, callsSince, closePlayer, evs, installTimeline, isPf, kpWith, mark, open,
  otherTvMarktime, panel, playing, refreshes, resAfter, seek, selected, sleep, switchAudio, timeline, until, watchCalls,
} from "./flows-kit.ts";
import type { Tl } from "./flows-kit.ts";

// Пользовательские сценарии Plan B §12.6 E-03…E-14 на клиентской схеме (этап 34, спец. §14.4): одна сессия web MSX на
// файл, навигация пультом, `exec` — короткий путь к экрану. E-01 нет (сопряжения нет), E-02 — в smoke, E-04 — это CE-02.
// Порядок: навигация и главная до просмотров (E-03, E-13), списки и поиск (E-12, E-05, E-06, E-07), карточки (E-14),
// плеер (E-08, E-10, E-09, E-15), ошибки последними (E-11: лимитер после 429 ещё 30 с держит параллельность 1).

test.describe.configure({ mode: "serial" });

let page: Page;

const movies = encodeListKey({ src: "catalog", type: "movie", sort: "-updated" });
const serials = encodeListKey({ src: "catalog", type: "serial", sort: "-updated" });
const concerts = encodeListKey({ src: "catalog", type: "concert", sort: "-updated" });
const PORTION = 48;
/** Серии SERIAL_SMALL по 60 с — как WebM mock; S1E3 → S2E1 — автопереход через границу сезона. */
const SMALL = FIX.SERIAL_SMALL;
const [s1, s2] = findItem(SMALL)!.seasons!.map((s) => s.episodes.map((e) => e.id));
const [S1E1, S1E2, S1E3, S2E1, S2E2] = [s1[0], s1[1], s1[2], s2[0], s2[1]];
/** CNFR-14: «просмотрено» — с 90 % длительности, у WebM mock это 54 с из 60. */
const WATCHED_AT = 54;
const restartOf = (mid: number, s: number, e: number): RegExp => new RegExp(`^play:${SMALL}:${mid}:${s}:${e}:at(\\d+)$`);

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

test("E-03: главная → карточка → «Назад» — фокус возвращается на ту же плитку", async () => {
  await noNotification(page);
  await expectContent(page, "Продолжить просмотр");
  await expectContent(page, "Новые фильмы");
  // Из меню в контент, на полку ниже и на плитку правее: каждое движение фокуса — `pf:<id>` из `selection.action`.
  let pf: Tl | undefined;
  for (const key of ["ArrowRight", "ArrowDown", "ArrowRight"]) {
    const m = await mark(page);
    await page.keyboard.press(key);
    pf = (await until(page, (x) => x.some(isPf), 3000, `pf после ${key}`, m)).filter(isPf).at(-1);
  }
  const id = Number(pf!.v.slice("pf:".length));
  await expect(selected(page), "фокус на плитке «Новые фильмы»").toContainText(`фильм ${id}`);
  await page.keyboard.press("Enter");
  await answered(page, ids.item(id), 0);
  await expectContent(page, `Тестовый фильм ${id}`);

  const m = await mark(page);
  await page.keyboard.press("Backspace");
  const tl = await until(page, (x) => {
    const r = x.findIndex((e) => e.k === "res" && e.v === ids.home());
    return r >= 0 && x.slice(r).some(isPf);
  }, 10_000, "Back: главная и pf восстановленного фокуса", m);
  const after = tl.slice(tl.findIndex((e) => e.k === "res" && e.v === ids.home())).filter(isPf).map((e) => e.v);
  expect(after, "после возврата фокус — на той же плитке (MSX держит его по id)").toEqual(after.map(() => msgs.pf(id)));
  await expect(selected(page)).toContainText(`фильм ${id}`);
});

test("E-13: главная → «Продолжить» → просмотр → «Назад» — replace:content:home; открытую поверх карточку не заменяет", async () => {
  // (а) Плитка «Продолжить» SERIAL_SMALL — третья на полке: после просмотра история KinoPub ставит её первой.
  let m = await mark(page);
  await press(page, `c${SMALL}`, "Короткий");
  await answered(page, ids.item(SMALL), m);
  await expect(selected(page), "фокус на «▶»").toContainText("▶ Смотреть: 1 сезон, 2 серия");
  const from = await mark(page);
  await page.keyboard.press("Enter");
  await playing(page, S1E2, from);
  await seek(page, 35);
  await exec(page, "player:pause");
  const pause = evs(await until(page, (x) => evs(x, "pause").some((e) => (e.pos ?? 0) >= 30), 5000, "pause ≥ 30 с", from), "pause").at(-1)!;
  await expect.poll(async () => (await watchCalls("marktime", SMALL)).map((c) => c.q.get("time")), { message: "marktime паузы", timeout: 5000 })
    .toContain(String(Math.floor(pause.pos!)));
  await closePlayer(page);
  // Plan B §9.2: через 2 с после stop фокус на «▶» и сверка карточки. Её подпись не меняется: у серии 60 с любая
  // позиция ближе минуты к концу, «Продолжить» с неё не предлагается (Plan B §9.7).
  await until(page, (x) => acts(x, "focus:b_main").length > 0, 10_000, "карточка под плеером сверяется", from);

  m = await mark(page);
  await page.keyboard.press("Backspace");
  await answered(page, ids.home(), m);
  const home = replaceContent("home", P, ids.home());
  await until(page, (x) => {
    const r = x.findIndex((e) => e.k === "act" && e.v === home);
    return r >= 0 && resAfter(x.slice(r), ids.home()) !== undefined;
  }, 15_000, "replace:content:home после сверки и новый ответ главной", m);
  const shelf = (await answer(page, ids.home())).pages[0].items.filter((it: any) => it.action !== undefined).map((it: any) => it.id);
  expect(shelf[0], "после замены SERIAL_SMALL — первым в «Продолжить»").toBe(`c${SMALL}`);

  // (б) Другой ТВ досмотрел часть MOVIE_AUDIO12, а у этого ТВ персональный кэш устарел (как после своего просмотра):
  // главная после «Назад» отдаётся из кэша и сверяется 3 с — за это время пользователь уже открыл карточку.
  await press(page, `c${SMALL}`, "Короткий");
  await answered(page, ids.item(SMALL), m);
  await otherTvMarktime(FIX.MOVIE_AUDIO12, 1, 600);
  await kpWith(page, (k, id) => k.ctx.repo.invalidateAfterProgress(id), FIX.MOVIE_AUDIO12);
  const skipped = await refreshes(page, "not_current home");
  m = await mark(page);
  await page.keyboard.press("Backspace");
  await answered(page, ids.home(), m);
  await expect(selected(page)).toContainText("Короткий");
  await page.keyboard.press("Enter");
  await answered(page, ids.item(SMALL), m);
  await expect.poll(() => refreshes(page, "not_current home"), { message: "сверка главной нашла изменения, но экран уже не текущий", timeout: 15_000 })
    .toBe(skipped + 1);
  expect(acts(await timeline(page, m), "replace:content:"), "ни главную, ни карточку никто не заменил").toEqual([]);
  expect((await stats(page)).requests.at(-1)).toBe(ids.item(SMALL));
  await expectContent(page, "Тестовый сериал «Короткий»");
});

test("E-12: префетч по фокусу — ArrowRight ×3, через 350 мс одна карточка последнего фокуса, открытие без запроса", async () => {
  await open(page, ids.list(serials));
  await expect(selected(page), "фокус на первой плитке").toContainText(/сериал \d+/);
  const tiles = await kpWith(page, (k, key) => k.ctx.state.lists.get(key).items.map((it: any) => it.id) as number[], serials);
  // Префетч первой плитки (фокус при открытии) успевает уйти: дальше считаются только запросы после стрелок.
  await expect.poll(async () => (await callsSince(0, ITEM_PATH)).some((c) => c.path === `/v1/items/${tiles[0]}`),
    { message: "префетч первой плитки", timeout: 5000 }).toBe(true);
  await sleep(300);
  const c0 = await callCount();
  const m = await mark(page);
  for (let n = 0; n < 3; n++) await page.keyboard.press("ArrowRight");
  const target = tiles[3];
  const tl = await until(page, (x) => x.filter(isPf).at(-1)?.v === msgs.pf(target), 3000, "pf четвёртой плитки", m);
  expect(tl.filter(isPf).map((e) => e.v), "pf на каждое движение фокуса").toEqual(tiles.slice(1, 4).map((id) => msgs.pf(id)));
  const loaded = async (): Promise<string[]> => (await callsSince(c0, ITEM_PATH)).map((c) => c.path);
  await expect.poll(loaded, { message: "карточка последнего фокуса", timeout: 5000 }).toEqual([`/v1/items/${target}`]);
  // Время `pf` в плагине — по часам страницы (`timeOrigin`), запрос — по часам mock: та же машина, допуск на округление.
  const pfAt = (await kp(page, () => performance.timeOrigin)) + tl.filter(isPf).at(-1)!.t;
  expect((await callsSince(c0, ITEM_PATH))[0].t - pfAt, "запрос не раньше 350 мс после последнего pf").toBeGreaterThanOrEqual(345);
  await sleep(500);
  expect(await loaded(), "промежуточные плитки не грузились").toEqual([`/v1/items/${target}`]);

  const c1 = await callCount();
  await page.keyboard.press("Enter");
  await answered(page, ids.item(target), m);
  await expectContent(page, `Тестовый сериал ${target}`);
  await sleep(1000);
  expect(await callsSince(c1, ITEM_PATH), "карточка из кэша префетча — без запроса").toEqual([]);
});

test("E-05: сортировка и жанр — выбор в панели, replace:content по флагу списка, sort и genre в запросе", async () => {
  await open(page, ids.list(movies));
  await expectContent(page, /фильм \d+/i);
  const choose = async (key: string, type: "sort" | "genre", now: string, keys: string[], to: string, next: string): Promise<void> => {
    const c0 = await callCount();
    const m = await mark(page);
    await exec(page, panelAction(P, ids.panel(type, key)));
    const sel = panel(page).locator(".selected");
    await expect(sel, "фокус на текущем значении").toContainText(now);
    for (const k of keys) await page.keyboard.press(k);
    await expect(sel).toContainText(to);
    // Действие строки выполняет MSX, а не плагин: в нём замена по флагу текущего списка на новый ключ (спец. §11 S6).
    const row = (await answer(page, ids.panel(type, key))).items.find((it: any) => it.label === to);
    expect(row?.action, `строка «${to}»`).toBe(chain(["back", replaceContent(listFlag(key), P, ids.list(next))]));
    await page.keyboard.press("Enter");
    await expect(panel(page)).toBeHidden();
    await answered(page, ids.list(next), m);
    const want = new URLSearchParams({ type: "movie", sort: "-kinopoisk_rating", page: "1", ...(type === "genre" ? { genre: "25" } : {}) });
    await expect.poll(async () => (await callsSince(c0, /^\/v1\/items$/)).some((c) => [...want].every(([n, v]) => c.q.get(n) === v)),
      { message: `запрос списка с ${want}`, timeout: 5000 }).toBe(true);
    expect((await stats(page)).requests.at(-1)).toBe(ids.list(next));
  };
  const byRating = encodeListKey({ src: "catalog", type: "movie", sort: "-kinopoisk_rating" });
  await choose(movies, "sort", "Обновлённые", ["ArrowDown", "ArrowDown"], "Рейтинг КП", byRating);
  await expect(page.getByText(/Рейтинг КП · \d+ фильм/), "сортировка — в extension списка").toBeVisible();
  // Жанры — в две колонки (V-13): справа от «Все жанры» — первый жанр справочника, «Аниме».
  const anime = encodeListKey({ src: "catalog", type: "movie", sort: "-kinopoisk_rating", genre: "25" });
  await choose(byRating, "genre", "Все жанры", ["ArrowRight"], "Аниме", anime);
  await expect(page.getByText(/Рейтинг КП · Аниме · \d+ фильм/)).toBeVisible();
});

test("E-06: поиск «фил» — один запрос после паузы, результаты, догрузка extend:search → page=2", async () => {
  // В синтетическом каталоге mock нет «мат» (Plan B E-06): «фил» находит фильмы — больше одной порции.
  await open(page, ids.search());
  await expectContent(page, "Наберите название");
  const c0 = await callCount();
  const queries = async (): Promise<string[]> => (await callsSince(c0, /^\/v1\/items\/search$/)).map((c) => `${c.q.get("q")}:${c.q.get("page")}`);
  for (const ch of "фил") await exec(page, commitMsg(msgs.searchInput(ch)));
  await expectContent(page, "фил_");
  await expect.poll(queries, { message: "один запрос на итоговую строку", timeout: 5000 }).toEqual(["фил:1"]);
  await expectContent(page, /фильм \d+/i);
  const found = await kp(page, (k) => k.ctx.state.search.items.map((it: any) => it.id) as number[]);
  expect(found).toHaveLength(PORTION);

  const m = await mark(page);
  await exec(page, `focus:i${found[PORTION - 1]}`);
  const tl = await until(page, (x) => {
    const e = x.findIndex((v) => v.k === "msg" && v.v === msgs.extend("search"));
    return e >= 0 && x.slice(e).some((v) => v.k === "res" && v.v === ids.search() && (v.n ?? 0) > PORTION);
  }, 10_000, "live setup последней плитки → extend:search → перерисовка с результатами второй порции", m);
  // 96 найденных в памяти; в ответе — сколько входит в 32 КБ целыми страницами (CNFR-16), с подсказкой «показано N».
  expect(await kp(page, (k) => k.ctx.state.search.items.length as number)).toBe(2 * PORTION);
  expect(acts(tl, "reload:content"), "одна перерисовка").toHaveLength(1);
  expect(await queries()).toEqual(["фил:1", "фил:2"]);
  await expect(selected(page), "фокус остался на плитке").toContainText(`фильм ${found[PORTION - 1]}`);
});

test("E-07: поиск → «Назад» в расширенный список — догрузка продолжается (page=3)", async () => {
  const listed = (): Promise<{ ids: number[]; from: number; to: number }> => kpWith(page, (k, key) => {
    const l = k.ctx.state.lists.get(key);
    return { ids: l.items.map((it: any) => it.id), from: l.from, to: l.to };
  }, serials);
  const extendTo = async (at: number): Promise<void> => {
    const { ids: all } = await listed();
    const m = await mark(page);
    await exec(page, `focus:i${all[at - 1]}`);
    await until(page, (x) => {
      const e = x.findIndex((v) => v.k === "msg" && v.v === msgs.extend(`${serials}:down:${at}`));
      return e >= 0 && x.slice(e).some((v) => v.k === "res" && v.v === ids.list(serials) && v.n === 2 * PORTION);
    }, 10_000, `extend «Сериалов» от ${at} и перерисовка окна`, m);
  };
  await open(page, ids.list(serials));
  await extendTo(PORTION);
  expect(await listed()).toMatchObject({ from: 0, to: 2 * PORTION });

  await open(page, ids.search());
  await expectContent(page, "«фил»");
  const m = await mark(page);
  await page.keyboard.press("Backspace");
  const back = await answered(page, ids.list(serials), m);
  expect(resAfter(back, ids.list(serials))?.n, "список вернулся расширенным, из памяти").toBe(2 * PORTION);

  const c0 = await callCount();
  await extendTo(2 * PORTION);
  const st = await listed();
  expect({ n: st.ids.length, from: st.from, to: st.to }, "третья порция дописана, окно сдвинуто на 48").toEqual({ n: 3 * PORTION, from: PORTION, to: 3 * PORTION });
  const pages = async (from: number): Promise<(string | null)[]> =>
    (await callsSince(from, /^\/v1\/items$/)).filter((c) => c.q.get("type") === "serial" && c.q.get("sort") === "-updated").map((c) => c.q.get("page"));
  expect(await pages(0), "порция 3 из mock").toContain("3");
  await expect.poll(() => pages(c0), { message: "после догрузки — фоном следующая порция", timeout: 5000 }).toContain("4");
});

test("E-14: устаревшая карточка A → сразу «Похожие» → B — A не подменяет B", async () => {
  const A = FIX.MOVIE_MULTI;
  await open(page, ids.item(A));
  await expectContent(page, "▶ Смотреть");
  // Другой ТВ начал A: у свежей A другая подпись «▶», то есть её сверка найдёт изменения. Ответ KinoPub на A идёт 2 с
  // (меньше 3 с, что сверка ждёт свежую карточку) — пользователь за это время уходит в «Похожие».
  await otherTvMarktime(A, 1, 300);
  await mock.scenario({ rules: [{ path: `^/v1/items/${A}$`, method: "GET", times: 1, delayMs: 2000 }] });
  await kp(page, (k) => k.ctx.cache.markStale("item:"));
  const skipped = await refreshes(page, `not_current item_${A}`);
  const m = await open(page, ids.item(A));
  await press(page, "b_similar", "Похожие");
  const similar = ids.list(encodeListKey({ src: "similar", id: A }));
  await answered(page, similar, m);
  const B = Number((await answer(page, similar)).items[0].kid);
  await expect(selected(page), "фокус на первой похожей").toContainText("фильм");
  await page.keyboard.press("Enter");
  await answered(page, ids.item(B), m);
  const openedAt = Date.now();
  await expect.poll(() => refreshes(page, `not_current item_${A}`), { message: "сверка A нашла изменения, но A уже не текущая", timeout: 10_000 })
    .toBe(skipped + 1);
  await sleep(Math.max(0, 3000 - (Date.now() - openedAt)));
  expect(acts(await timeline(page, m), "replace:content:"), "за 3 с — ни одной замены экрана").toEqual([]);
  expect((await stats(page)).requests.at(-1), "последний запрос — карточка B").toBe(ids.item(B));
  await expectContent(page, "Тестовый фильм");
  await expect(content(page)).not.toContainText("«Из частей»");
});

test("E-08: просмотр за 90 % — позиции pause и stop, toggle ровно один раз с 54 с из 60, карточка заменяется", async () => {
  const marks = async (): Promise<number[]> => (await watchCalls("marktime", SMALL)).filter((c) => c.q.get("video") === "2").map((c) => Number(c.q.get("time")));
  await open(page, ids.item(SMALL));
  await expect(selected(page)).toContainText("▶ Смотреть: 1 сезон, 2 серия");
  const from = await mark(page);
  await page.keyboard.press("Enter");
  await playing(page, S1E2, from);
  await seek(page, 33);
  await exec(page, "player:pause");
  let tl = await until(page, (x) => evs(x, "pause").some((e) => (e.pos ?? 0) >= 33), 5000, "pause с позицией", from);
  const pausePos = Math.floor(evs(tl, "pause").at(-1)!.pos!);
  await expect.poll(marks, { message: `marktime ${pausePos} паузы`, timeout: 5000 }).toContain(pausePos);
  expect(await watchCalls("toggle", SMALL), "до 90 % «просмотрено» не отправляется").toEqual([]);

  await exec(page, "player:play");
  await seek(page, 50);
  // `trigger:90%` (shot) и тики приносят снимки за 54 с: «просмотрено» — по первому из них, дальше не повторяется.
  tl = await until(page, (x) => evs(x, "watched").length > 0, 15_000, "отметка «просмотрено»", from);
  const shots = evs(tl, "snapshot").filter((e) => e.i < evs(tl, "watched")[0].i);
  expect(shots.at(-1)?.pos ?? 0, "отметка по снимку за 90 %").toBeGreaterThanOrEqual(WATCHED_AT);
  expect(shots.slice(0, -1).every((e) => (e.pos ?? 0) < WATCHED_AT), "раньше 90 % снимки отметку не дали").toBe(true);
  await exec(page, "player:pause");
  await until(page, (x) => evs(x, "pause").some((e) => (e.pos ?? 0) >= WATCHED_AT), 5000, "pause за 90 %", from);
  const stop = await closePlayer(page);
  expect(stop.pos ?? 0, "video:stop с позицией").toBeGreaterThanOrEqual(WATCHED_AT);
  const card = replaceContent(`item_${SMALL}`, P, ids.item(SMALL));
  await until(page, (x) => acts(x, card).length > 0, 10_000, "replace:content:item_2002 после stop", from);
  await expectContent(page, "▶ Смотреть: 1 сезон, 3 серия");
  expect((await watchCalls("toggle", SMALL)).map((c) => c.status), "toggle ровно один раз — снимки, пауза и stop после 90 % его не повторяют").toEqual([200]);
  expect((await marks()).filter((t) => t >= WATCHED_AT), "позиции паузы и stop за 90 % — в marktime").not.toEqual([]);
});

/** Ответ resolve, с которым играет E-10 и который E-09 берёт для кнопок плеера. */
let s1e3Resolve: { properties: Record<string, string> } | undefined;

test("E-10: триггеры только из resolve — у элементов сезона нет properties, снимки позиции приходят", async () => {
  const season = ids.season(SMALL, 1);
  await open(page, season);
  const root = await answer(page, season);
  const props = (it: any): boolean => it !== null && typeof it === "object" && "properties" in it;
  expect([root.template, ...root.items, ...(root.header?.items ?? [])].filter(props), "playerPropsIn: resolve — свойств плеера в экране нет").toEqual([]);
  await expect(selected(page), "фокус на серии «Продолжить»").toContainText("Серия 3");
  const from = await mark(page);
  await page.keyboard.press("Enter");
  const play = ids.playEp(SMALL, S1E3, 1, 3);
  await answered(page, play, from);
  s1e3Resolve = await answer(page, play);
  expect(s1e3Resolve?.properties, "свойства плеера — из ответа resolve").toMatchObject({
    "kp:i": String(SMALL), "kp:m": String(S1E3), "kp:s": "1", "kp:e": "3", "trigger:10t": "[interaction:commit:video|player:ticking:restart]",
  });
  await playing(page, S1E3, from);
  const tl = await until(page, (x) => evs(x, "snapshot").some((e) => e.s?.mid === S1E3 && (e.pos ?? 0) > 0), 20_000, "снимок позиции из trigger:10t", from);
  expect(evs(tl, "handleData:video").length, "снимки пришли в handleData").toBeGreaterThanOrEqual(1);
});

test("E-09: панель озвучки поверх плеера → перезапуск с позиции; после конца S1E3 — S2E1 через границу сезона", async () => {
  expect(s1e3Resolve, "E-10 запустил S1E3").toBeDefined();
  // Кнопка плеера «озвучка» (`button:content`) — то же действие, что выполнил бы пульт на панели плеера.
  const restart = restartOf(S1E3, 1, 3);
  const again = await switchAudio(page, s1e3Resolve!.properties["button:content:action"], "Студия", ["ArrowDown"], "Оригинал", restart);
  expect(Number(restart.exec(again.v)![1]), "позиция перезапуска — где играл плеер").toBeGreaterThan(0);
  expect((await answer(page, again.v)).properties["label:extension"], "играет выбранная озвучка").toContain("Оригинал");
  await playing(page, S1E3, again.i);
  // До конца: «просмотрено» с 54 с, `trigger:complete` нажимает кнопку «следующая» — S2E1 (D-29). С 40 с: 90 % наступают
  // позже 10 с после перезапуска; перезапуск ближе к 90 % — тест «E-09b» ниже (фикс 34b).
  await seek(page, 40);
  const next = ids.playEp(SMALL, S2E1, 2, 1);
  const end = await until(page, (x) => resAfter(x, next) !== undefined && evs(x, "load").some((e) => e.s?.mid === S2E1), 25_000, "автопереход на S2E1", again.i);
  expect(evs(end, "load").at(-1)?.s, "сессия S2E1 из kp:s и kp:e").toEqual({ mid: S2E1, season: 2, video: 1 });
  expect(evs(end, "watched").filter((e) => e.s?.mid === S1E3), "S1E3 отмечена один раз").toHaveLength(1);
  await closePlayer(page);
  expect((await watchCalls("toggle", SMALL)).map((c) => `${c.q.get("season")}:${c.q.get("video")}`), "по одному toggle на досмотренную серию").toEqual(["1:2", "1:3"]);
});

// Регресс фикса 34b: до него `isLate` (этап 33c) 10 с не слушал снимки видео закрытой сессии, даже когда та же серия
// уже снова открыта явным `video:load` — а так её перезапускает панель озвучки или качества в плеере (X-2). `trigger:90%`
// и снимок конца серии терялись, `stop` при автопереходе MSX не шлёт — серия оставалась «начатой». Теперь сессия — это
// запуск с nonce `kp:r` из resolve (спец. §10.2): снимки закрытого запуска отбрасываются по nonce, а не окном 10 с.
test("E-09b: перезапуск из панели за 10 с до 90 % — при автопереходе серия отмечается просмотренной", async () => {
  const season = ids.season(SMALL, 2);
  await open(page, season);
  await expect(selected(page), "фокус на серии «Продолжить»").toContainText("Серия 1");
  const from = await mark(page);
  await page.keyboard.press("Enter");
  const play = ids.playEp(SMALL, S2E1, 2, 1);
  await answered(page, play, from);
  await playing(page, S2E1, from);
  await seek(page, 20);
  // Озвучку тайтла E-09 уже сменил на «Оригинал»: здесь — обратно на студию, тоже перезапуск с позиции.
  const again = await switchAudio(page, (await answer(page, play)).properties["button:content:action"], "Оригинал", ["ArrowUp"], "Студия", restartOf(S2E1, 2, 1));
  await playing(page, S2E1, again.i);
  // 90 % (54 с) и конец серии — в первые 10 с после перезапуска; `stop` при автопереходе MSX не присылает.
  await seek(page, 52);
  const end = await until(page, (x) => evs(x, "load").some((e) => e.s?.mid === S2E2), 25_000, "автопереход на S2E2", again.i);
  expect(evs(end, "watched").filter((e) => e.s?.mid === S2E1), "досмотренная S2E1 отмечена «просмотрено»").toHaveLength(1);
  await closePlayer(page);
});

// Фикс 35a (полевой тест на ТВ): смена озвучки в плеере позже 8 с после старта показывала «Предыдущий запуск не удался»,
// вторая уводила на hls2 (озвучка потока по умолчанию), третья — в ошибку. Признака старта не было: автостарт не шлёт
// `video:play`, первый тик на ТВ — через 60 с. Теперь перезапуск из панели (`:at<сек>`) — не сбой, плеер не закрывается.
test("E-15: три смены озвучки подряд в плеере — без «Предыдущий запуск не удался», плеер не закрывается, позиция идёт вперёд", async () => {
  // Тики как на ТВ (60, Р-26): все смены — до первого снимка позиции.
  await kp(page, (k) => {
    k.ctx.build.heartbeatTicks = 60;
  });
  const c0 = await callCount();
  const play = ids.playEp(SMALL, S1E1, 1, 1, { start: true });
  const from = await mark(page);
  await exec(page, resolveAction(P, play));
  await answered(page, play, from);
  await playing(page, S1E1, from);
  let props = (await answer(page, play)).properties;
  let now = "Студия";
  let last = 0;
  const restart = restartOf(S1E1, 1, 1);
  for (const [i, [keys, next]] of ([[["ArrowDown"], "Оригинал"], [["ArrowUp"], "Студия"], [["ArrowDown"], "Оригинал"]] as const).entries()) {
    await sleep(9_000);
    const before = await mark(page);
    const again = await switchAudio(page, props["button:content:action"], now, [...keys], next, restart);
    const res = await answer(page, again.v);
    expect(res.properties["trigger:load"], `смена ${i + 1}: не «пробую другой способ»`).toBeUndefined();
    expect(res.properties["label:extension"], `смена ${i + 1}: играет выбранная озвучка`).toContain(next);
    expect(res.properties["tizen:stream:ADAPTIVE_INFO"], `смена ${i + 1}: не hls2`).toBeUndefined();
    const at = Number(restart.exec(again.v)![1]);
    expect(at, `смена ${i + 1}: позиция перезапуска идёт вперёд`).toBeGreaterThan(last);
    expect(res.properties["resume:position"]).toBe(String(at));
    await playing(page, S1E1, again.i);
    const tl = await timeline(page, before);
    expect(evs(tl, "handleEvent:video:stop"), `смена ${i + 1}: плеер не закрывался — без video:stop`).toEqual([]);
    await sleep(1000);
    await expect(page.locator("#appNotificationScene"), `смена ${i + 1}: нет сообщения о сбое`).not.toContainText("не удался");
    props = res.properties;
    now = next;
    last = at;
  }
  const steps = await kpWith(page, (k, m) => k.ctx.log.entries()
    .filter((e: any) => e.tag === "resolve" && e.msg === "resolved" && e.data?.mid === m).slice(-4)
    .map((e: any) => `${e.data.step} ${e.data.mode}`), S1E1);
  expect(steps, "цепочка fallback не сдвинулась: hls1, шаг 1").toEqual(["1 hls1", "1 hls1", "1 hls1", "1 hls1"]);
  const stop = await closePlayer(page);
  expect(stop.pos ?? 0, "выход — дальше последней смены").toBeGreaterThan(last);
  await expect.poll(async () => (await callsSince(c0, /^\/v1\/watching\/marktime$/)).filter((c) => c.q.get("video") === "1").map((c) => Number(c.q.get("time"))),
    { message: "marktime выхода", timeout: 5000 }).toContain(Math.floor(stop.pos!));
  const marks = (await callsSince(c0, /^\/v1\/watching\/marktime$/)).filter((c) => c.q.get("season") === "1" && c.q.get("video") === "1").map((c) => Number(c.q.get("time")));
  expect(marks, "marktime не откатывается").toEqual([...marks].sort((a, b) => a - b));
  await kp(page, (k) => {
    k.ctx.build.heartbeatTicks = 10;
  });
});

test("E-11: 429 без CORS на список — через 6 с KP-NET с «Повторить», поздний 429 его не меняет; сбой снят — «Повторить» открывает список", async () => {
  // Как nginx без `always`: 429 без CORS-заголовков, браузер видит TypeError; проба `no-cors` доказывает, что сервер жив.
  await mock.scenario({ rules: [{ path: "^/v1/items$", method: "GET", status: 429, noCors: true }] });
  const c0 = await callCount();
  const m = await mark(page);
  await exec(page, contentAction(P, ids.list(concerts)));
  // Повторы §5.3 (3 с и 6 с) дольше срока экрана: через 6 с — «не отвечает» (V-40, спец. §12), а не KP-429.
  await expectContent(page, "KinoPub не отвечает. Проверьте VPN", { timeout: 15_000 });
  await expectContent(page, "Код: KP-NET");
  await expect(content(page), "не «нужен Plan B»: CORS у API есть").not.toContainText("KP-CORS");
  await expect(selected(page), "фокус на «Повторить»").toContainText("Повторить");
  // Запрос не отменяется: повторы доходят до пробы `no-cors`, её вердикт «ответ без CORS» — как 429.
  const probes = async (): Promise<string[]> => (await callsSince(c0, /^\/v1\/types$/)).map((c) => c.query);
  await expect.poll(probes, { message: "проба no-cors — фиксированный запрос (CM-01)", timeout: 20_000 }).toContain("access_token=x");
  const failed = (await callsSince(c0, /^\/v1\/items$/)).filter((c) => c.q.get("type") === "concert");
  expect(failed.length, "список пробовал загрузиться").toBeGreaterThanOrEqual(1);
  expect(failed.every((c) => c.status === 429)).toBe(true);
  // Поздняя ошибка ничего не меняет: экран тот же, KP-429 не появляется.
  await sleep(1000);
  await expectContent(page, "Код: KP-NET");
  await expect(content(page), "поздний 429 не заменяет экран срока").not.toContainText("KP-429");

  // `mock.reset()` из плана сбросил бы и токены этого входа: снимается только правило сбоя.
  await mock.scenario({ rules: [] });
  await page.keyboard.press("Enter");
  await until(page, (x) => x.some((e) => e.k === "res" && e.v === ids.list(concerts) && (e.n ?? 0) > 0), 20_000, "«Повторить» → список", m);
  await expectContent(page, /концерт \d+/i);
  expect((await stats(page)).requests.at(-1)).toBe(ids.list(concerts));
});
