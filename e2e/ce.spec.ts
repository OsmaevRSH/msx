import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { contentAction } from "../src/msx/actions.ts";
import { encodeListKey, ids, msgs } from "../src/router/ids.ts";
import { FIX, findItem } from "../tools/kpmock/fixtures.ts";
import { P, consoleTail, content, exec, expectContent, kp, login, mock, newMsxPage, noNotification, openMsx, pluginFrame, press, stats } from "./fixtures.ts";
import type { MockCall } from "./fixtures.ts";

// CE-02…CE-06 в настоящей web-версии MSX (этап 33, спец. §14.4): одна сессия MSX на весь файл, навигация клавишами
// пульта (ArrowUp/Down/Left/Right, Enter, Backspace), `exec` — только короткий путь к экрану. Порядок: списки
// (CE-02), поиск (CE-03), гонка догрузки с карточкой (CE-06), плеер (CE-04), панель и итог сессии (CE-05).

test.describe.configure({ mode: "serial" });

let page: Page;
let bootId = "";

const movies = encodeListKey({ src: "catalog", type: "movie", sort: "-updated" });
const serials = encodeListKey({ src: "catalog", type: "serial", sort: "-updated" });
/** Порция API и сетка списка S5: 48 плиток по 8 в ряд (src/screens/list.ts). */
const PORTION = 48;
const ROWS = PORTION / 8;
/**
 * Задержка mock для второй порции в CE-06. План называет 2 с, но отсчёт идёт не от extend, а от фонового запроса
 * порции 2 при открытии списка (спец. §8.3), и до extend проходит ещё до секунды цикла live; 3 с оставляют запас,
 * чтобы карточка открылась раньше, чем догрузка закончится.
 */
const SLOW_PAGE_MS = 3000;
/** Окно CE-06: столько после открытия карточки (и не меньше секунды после конца догрузки) нет перерисовки. */
const QUIET_MS = 3000;
/** Live-элементы MSX пересчитывает раз в секунду (msx-platform §6): столько ждём extend от показанной плитки. */
const LIVE_MS = 1500;
/** Позиция паузы в CE-04: `marktime` уходит только с 30 с (Plan B §9.3, src/progress/rules.ts). */
const PAUSE_AFTER_SEC = 31;

/**
 * Хронология плагина с метками `performance.now()`: запросы и ответы MSX (`n` — число `items` ответа), сообщения,
 * выполненные действия и события трекера. В отличие от колец `stats()` (200 записей, без времени) она не теряет
 * начало и даёт порядок «что после чего».
 */
interface Tl { i: number; t: number; k: "req" | "res" | "msg" | "act" | "ev"; v: string; n?: number; pos?: number; time?: number; ok?: boolean }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const selected = (p: Page) => content(p).locator(".app-main-content-item.selected");
const menuSelected = (p: Page) => p.locator("#appMainMenuItems .app-main-menu-item.selected");
const isPf = (e: Tl): boolean => e.k === "msg" && e.v.startsWith("pf:");

/** Как `kp` из фикстур, но с аргументом (функция исполняется в фрейме плагина и не видит замыканий теста). */
async function kpWith<A, T>(p: Page, fn: (k: any, a: A) => T, arg: A): Promise<T> {
  const frame = await pluginFrame(p);
  return frame.evaluate(`(${fn.toString()})(globalThis.__kp, ${JSON.stringify(arg)})`) as Promise<T>;
}

/** Обёртки над `__kp.app` и `ctx.host` пишут хронологию в `__kp.tl`; трекер — через свой `addListener`. */
async function installTimeline(p: Page): Promise<void> {
  await kp(p, (k) => {
    const tl: any[] = [];
    k.tl = tl;
    const now = (): number => Math.round(performance.now());
    const app = k.app;
    const handleRequest = app.handleRequest.bind(app);
    app.handleRequest = async (id: string, d: unknown) => {
      tl.push({ t: now(), k: "req", v: id });
      const r = await handleRequest(id, d);
      tl.push({ t: now(), k: "res", v: id, n: Array.isArray(r?.items) ? r.items.length : undefined });
      return r;
    };
    const handleData = app.handleData.bind(app);
    app.handleData = (d: any) => {
      if (typeof d?.message === "string") tl.push({ t: now(), k: "msg", v: d.message });
      handleData(d);
    };
    // Сервисы берут ctx.host при каждом вызове (src/app/debug.ts), поэтому подмена видна всем.
    const host = k.ctx.host;
    k.ctx.host = {
      executeAction: (a: string, x?: unknown) => {
        tl.push({ t: now(), k: "act", v: a });
        host.executeAction(a, x);
      },
      requestData: (id: string) => host.requestData(id),
    };
    k.ctx.tracker.addListener((e: any) => {
      const raw = e.kind === "raw";
      tl.push({ t: now(), k: "ev", v: raw ? `${e.source}:${e.name}` : e.kind, pos: raw ? e.position : e.pos, time: e.time, ok: e.ok });
    });
  });
}

async function timeline(p: Page, from = 0): Promise<Tl[]> {
  return kpWith(p, (k, f) => k.tl.slice(f).map((e: any, j: number) => ({ ...e, i: f + j })), from);
}

/** Индекс следующей записи хронологии — «отсюда» для `until`. */
async function mark(p: Page): Promise<number> {
  return kp(p, (k) => k.tl.length as number);
}

/** Время фрейма плагина — в той же шкале, что `t` хронологии. */
async function pluginNow(p: Page): Promise<number> {
  return kp(p, () => Math.round(performance.now()));
}

/** Опрос хронологии раз в 50 мс (у `waitFor` из фикстур — 200 мс, это много для окна дебаунса поиска). */
async function until(p: Page, pred: (tl: Tl[]) => boolean, timeoutMs: number, what: string, from = 0): Promise<Tl[]> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const tl = await timeline(p, from);
    if (pred(tl)) return tl;
    if (Date.now() > end) {
      throw new Error(`не дождались за ${timeoutMs} мс: ${what}\nхронология: ${JSON.stringify(tl.slice(-30))}\n${consoleTail(p)}`);
    }
    await sleep(50);
  }
}

const listCalls = (calls: MockCall[], type: string, pageNo: number): MockCall[] =>
  calls.filter((c) => {
    const q = new URLSearchParams(c.query);
    return c.method === "GET" && c.path === "/v1/items" && q.get("type") === type && q.get("page") === String(pageNo);
  });

/** Первый ответ плагина на `dataId` в срезе хронологии: MSX запросил экран, плагин ответил. */
const resAfter = (tl: Tl[], dataId: string): Tl | undefined => tl.find((e) => e.k === "res" && e.v === dataId);

async function videoTime(p: Page): Promise<number> {
  return p.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime);
}

test.beforeAll(async ({ browser }) => {
  await mock.reset();
  page = await newMsxPage(browser);
  await openMsx(page);
  bootId = (await stats(page)).bootId;
  await installTimeline(page);
  await login(page);
});

test.afterEach(async ({}, info) => {
  if (info.status === info.expectedStatus) return;
  await info.attach("msx.png", { body: await page.screenshot(), contentType: "image/png" });
  await info.attach("console.txt", { body: consoleTail(page, 80), contentType: "text/plain" });
  const tl = (await timeline(page).catch(() => [])).slice(-60).map((e) => `${e.t} ${e.k} ${e.v.slice(0, 90)}${e.n === undefined ? "" : ` n=${e.n}`}${e.pos === undefined ? "" : ` pos=${e.pos}`}`);
  await info.attach("timeline.txt", { body: tl.join("\n"), contentType: "text/plain" });
});

test.afterAll(async () => {
  await page?.close();
});

test("CE-02: «Фильмы» — догрузка через live setup и reload:content сохраняет фокус по id", async () => {
  // «Вход выполнен» (info:) перехватил бы первую клавишу.
  await noNotification(page);
  await expect(menuSelected(page)).toHaveText("Главная");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(menuSelected(page), "разделитель «Каталог» пропускается").toHaveText("Фильмы");
  await until(page, (tl) => resAfter(tl, ids.list(movies)) !== undefined, 10_000, "MSX загрузил «Фильмы» по выбору в меню");
  // V-10: название плитки в две строки — «Тестовый» и «фильм <id>» — разными элементами.
  await expectContent(page, /фильм \d+/i);
  const m0 = await mark(page);
  await page.keyboard.press("ArrowRight");
  await expect(selected(page), "фокус перешёл из меню на первую плитку").toContainText("Тестовый");
  await expect(selected(page)).toContainText(/фильм \d+/);
  await until(page, (x) => x.some(isPf), 3000, "pf первой плитки", m0);

  // Ряд за рядом к последнему ряду порции: его live `setup` шлёт extend. Live MSX пересчитывает раз в секунду
  // (msx-platform §6), поэтому после шага ждём extend и дальше вниз не идём — иначе фокус уйдёт с плитки.
  const ext = msgs.extend(`${movies}:down:${PORTION}`);
  const hasExt = (x: Tl[]): boolean => x.some((e) => e.k === "msg" && e.v === ext);
  const from = await mark(page);
  for (let r = 1; r < ROWS && !hasExt(await timeline(page, from)); r++) {
    const m = await mark(page);
    await page.keyboard.press("ArrowDown");
    await until(page, (x) => x.some(isPf), 3000, `pf после ArrowDown №${r}`, m);
    await until(page, hasExt, LIVE_MS, ext, from).catch(() => undefined);
  }
  let tl = await until(page, hasExt, LIVE_MS, `live setup последней плитки прислал ${ext}`, from);
  const iExt = tl.findIndex((e) => e.k === "msg" && e.v === ext);
  expect((await stats(page)).messages, "extend в stats().messages").toContain(ext);
  const pfBefore = tl.slice(0, iExt).filter(isPf).at(-1);
  expect(pfBefore, "до догрузки фокус стоял на плитке").toBeDefined();

  const extAt = tl[iExt].i;
  const reloadIn = (x: Tl[]): number => x.findIndex((e) => e.i > extAt && e.k === "act" && e.v === "reload:content");
  tl = await until(page, (x) => {
    const r = reloadIn(x);
    return r >= 0 && x.slice(r).some(isPf) && resAfter(x.slice(r), ids.list(movies)) !== undefined;
  }, 10_000, "reload:content после extend, новый ответ списка и pf восстановленного фокуса", from);
  const after = tl.slice(reloadIn(tl));
  expect(resAfter(after, ids.list(movies))?.n, "окно ответа выросло до 96 плиток (две порции)").toBe(2 * PORTION);
  expect(after.find(isPf)?.v, "после перерисовки фокус на той же плитке (MSX держит его по id)").toBe(pfBefore?.v);
  const id = Number(pfBefore?.v.slice("pf:".length));
  await expect(selected(page)).toContainText("Тестовый");
  await expect(selected(page)).toContainText(`фильм ${id}`);
  await expect(page.locator(".app-main-content-sub-headline", { hasText: `Тестовый фильм ${id}` }),
    "полное название плитки в фокусе — в шапке рядом с заголовком (V-10)").toBeVisible();
  expect(tl.filter((e) => e.k === "act" && e.v === "reload:content"), "одна перерисовка на одну догрузку").toHaveLength(1);

  const calls = await mock.calls();
  expect(listCalls(calls, "movie", 2), "вторая порция из mock (page=2)").not.toHaveLength(0);
});

test("CE-03: клавиатура поиска — ввод, стирание, раскладка, клавиши 1 и 2", async () => {
  // Back из списка, открытого из меню, возвращает фокус в меню.
  await page.keyboard.press("Backspace");
  await expect(menuSelected(page)).toHaveText("Фильмы");
  await page.keyboard.press("ArrowUp");
  await expect(menuSelected(page)).toHaveText("Поиск");
  await until(page, (tl) => resAfter(tl, ids.search()) !== undefined, 10_000, "MSX загрузил «Поиск» по выбору в меню");
  await expectContent(page, "Наберите название");
  const calls0 = (await mock.calls()).length;
  const from = await mark(page);
  await page.keyboard.press("ArrowRight");
  await expect(selected(page), "фокус на первой букве").toHaveText("а");

  const typed = async (msg: string): Promise<void> => {
    await until(page, (tl) => tl.some((e) => e.k === "msg" && e.v === msg), 3000, msg, from);
  };
  await page.keyboard.press("Enter");
  await typed(msgs.searchInput("а"));
  await expectContent(page, "а_");
  // «м» — второй ряд RU (11 букв в ряд, Р-13), третья колонка.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(selected(page)).toHaveText("м");
  await page.keyboard.press("Enter");
  await typed(msgs.searchInput("м"));
  // «⌫» — клавиша Delete (key "delete" у «Стереть»): раньше, чем истекут 500 мс дебаунса «ам».
  await page.keyboard.press("Delete");
  await typed(msgs.searchControl("back"));
  await expectContent(page, "а_");
  // К «Раскладка: RU» (V-29): вправо до управляющей колонки (9 шагов от «м» — «Пробел»), вниз на две кнопки.
  for (let n = 0; n < 9; n++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(selected(page)).toContainText("Раскладка: RU");
  await page.keyboard.press("Enter");
  await typed(msgs.searchControl("lang"));
  await expect(content(page).getByText("z", { exact: true }), "раскладка EN").toBeVisible();
  await page.keyboard.press("1");
  await typed(msgs.searchInput("1"));
  const lastKeyAt = Date.now();
  await page.keyboard.press("2");
  await typed(msgs.searchInput("2"));

  await expectContent(page, "а12_");
  await expectContent(page, "Ничего не найдено");
  const tl = await timeline(page, from);
  expect(tl.filter((e) => e.k === "msg" && e.v.startsWith("search:")).map((e) => e.v), "сообщения клавиатуры по порядку").toEqual([
    msgs.searchInput("а"), msgs.searchInput("м"), msgs.searchControl("back"), msgs.searchControl("lang"), msgs.searchInput("1"), msgs.searchInput("2"),
  ]);
  const s = await stats(page);
  expect(s.messages.filter((m) => m.startsWith("search:")).slice(-6)).toEqual([
    "search:input:а", "search:input:м", "search:control:back", "search:control:lang", "search:input:1", "search:input:2",
  ]);

  const search = (await mock.calls()).slice(calls0).filter((c) => c.path === "/v1/items/search");
  expect(search.map((c) => new URLSearchParams(c.query).get("q")), "один запрос к API — на итоговую строку").toEqual(["а12"]);
  expect(search[0].t - lastKeyAt, "запрос после паузы ввода 500 мс").toBeGreaterThanOrEqual(500);
});

test("CE-06: догрузка пришла после ухода в карточку — карточка не перерисована, список уже расширен", async () => {
  // Первый GET /v1/items (порция 1 «Сериалов») — без задержки, второй (фоновая порция 2) — с задержкой: правила
  // mock смотрят только путь, поэтому порядок задаёт `times`.
  await mock.scenario({ rules: [
    { path: "^/v1/items$", method: "GET", times: 1 },
    { path: "^/v1/items$", method: "GET", times: 1, delayMs: SLOW_PAGE_MS },
  ] });
  await page.keyboard.press("Backspace");
  await expect(menuSelected(page)).toHaveText("Поиск");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(menuSelected(page)).toHaveText("Сериалы");
  await until(page, (tl) => resAfter(tl, ids.list(serials)) !== undefined, 10_000, "MSX загрузил «Сериалы» по выбору в меню");
  await expectContent(page, /сериал \d+/i);
  await page.keyboard.press("ArrowRight");
  await expect(selected(page)).toContainText(/сериал \d+/);

  // До последнего ряда порции без пауз: вторая порция ещё в пути (mock держит её SLOW_PAGE_MS).
  const from = await mark(page);
  for (let r = 1; r < ROWS; r++) await page.keyboard.press("ArrowDown");
  const ext = msgs.extend(`${serials}:down:${PORTION}`);
  await until(page, (tl) => tl.some((e) => e.k === "msg" && e.v === ext), 3000, ext, from);
  await page.keyboard.press("Enter");
  const tl0 = await until(page, (tl) => tl.some((e) => e.k === "req" && e.v.startsWith("item:")), 3000, "Enter на плитке открыл карточку", from);
  const itemReq = tl0.find((e) => e.k === "req" && e.v.startsWith("item:"))!;
  const loading = await kpWith(page, (k, key) => k.ctx.state.lists.get(key)?.loading !== undefined, serials);
  expect(loading, "к открытию карточки догрузка ещё идёт — иначе сценарий не проверяет гонку").toBe(true);

  const openedAt = Date.now();
  await expect.poll(() => kpWith(page, (k, key) => k.ctx.state.lists.get(key).items.length as number, serials),
    { message: "догрузка «Сериалов» закончилась, пока открыта карточка", timeout: SLOW_PAGE_MS + 5000, intervals: [100] })
    .toBe(2 * PORTION);
  await sleep(Math.max(QUIET_MS - (Date.now() - openedAt), 1000));
  const tl = await timeline(page, itemReq.i);
  expect(tl.filter((e) => e.k === "act" && e.v.startsWith("reload:content")), "после запроса item: — без reload:content").toEqual([]);
  expect((await stats(page)).requests.at(-1), "текущий экран — карточка").toBe(itemReq.v);
  const id = Number(itemReq.v.slice("item:".length));
  await expectContent(page, `Тестовый сериал ${id}`);
  await expectContent(page, "Сезоны");
  const st = await kpWith(page, (k, key) => {
    const l = k.ctx.state.lists.get(key);
    return { items: l.items.length as number, loading: l.loading !== undefined, from: l.from as number, to: l.to as number };
  }, serials);
  expect(st, "пока открыта карточка, догрузка закончилась и сдвинула окно в памяти").toEqual({ items: 2 * PORTION, loading: false, from: 0, to: 2 * PORTION });
  expect(listCalls(await mock.calls(), "serial", 2)).toHaveLength(1);

  const calls0 = (await mock.calls()).length;
  const m = await mark(page);
  await page.keyboard.press("Backspace");
  const back = await until(page, (x) => resAfter(x, ids.list(serials)) !== undefined, 5000, "Back вернул список «Сериалы»", m);
  expect(resAfter(back, ids.list(serials))?.n, "список при возврате — уже 96 плиток").toBe(2 * PORTION);
  await expectContent(page, /сериал \d+/i);
  await sleep(500);
  // Постеры новых плиток MSX грузит сам (/poster/…): это картинки, не данные списка.
  const api = (await mock.calls()).slice(calls0).filter((c) => c.path.startsWith("/v1/"));
  expect(api.map((c) => `${c.method} ${c.path}?${c.query.replace(/access_token=[^&]*&?/, "")}`),
    "ответ из памяти: ни одного запроса к API mock").toEqual([]);
});

test("CE-04: WebM в плеере MSX — load, play, тики, pause с marktime, Back-снимок и stop", async () => {
  await exec(page, contentAction(P, ids.item(FIX.SERIAL_SMALL)));
  await expectContent(page, "Тестовый сериал «Короткий»");
  await expect(selected(page), "фокус на главной кнопке карточки").toContainText("▶");
  const from = await mark(page);
  await page.keyboard.press("Enter");
  await until(page, (tl) => tl.some((e) => e.k === "req" && e.v === ids.playContinue(FIX.SERIAL_SMALL)), 10_000, "resolve play:2002:continue", from);
  expect((await stats(page)).requests).toContain(ids.playContinue(FIX.SERIAL_SMALL));

  // heartbeat — триггер `trigger:10t` (HEARTBEAT_TICKS=10 в e2e-сборке, Р-26): снимки приходят в handleData.
  const ticks = (tl: Tl[]): Tl[] => tl.filter((e) => e.k === "ev" && e.v === "handleData:video" && (e.pos ?? 0) > 0);
  let tl = await until(page, (x) => x.some((e) => e.v === "handleEvent:video:load") && ticks(x).length >= 2, 40_000, "video:load и два снимка тиков", from);
  const shots = ticks(tl).map((e) => e.pos!);
  expect(shots[1], "снимки тиков с растущей позицией").toBeGreaterThan(shots[0]);
  expect(tl.some((e) => e.v === "started"), "трекер увидел старт").toBe(true);

  await expect.poll(() => videoTime(page), { message: `WebM дошёл до ${PAUSE_AFTER_SEC} с`, timeout: 30_000, intervals: [250] })
    .toBeGreaterThan(PAUSE_AFTER_SEC);
  const m = await mark(page);
  await exec(page, "player:pause");
  tl = await until(page, (x) => x.some((e) => e.v === "handleEvent:video:pause" && e.pos !== undefined), 5000, "video:pause с позицией", m);
  const pausePos = Math.floor(tl.find((e) => e.v === "handleEvent:video:pause")!.pos!);
  expect(pausePos).toBeGreaterThanOrEqual(30);
  await expect.poll(async () => (await mock.calls()).filter((c) => c.path === "/v1/watching/marktime").map((c) => new URLSearchParams(c.query).get("time")),
    { message: `marktime с позицией паузы ${pausePos} в mock`, timeout: 5000, intervals: [100] })
    .toContain(String(pausePos));

  // Автостарт web MSX не шлёт video:play (только load); play приходит при снятии с паузы.
  await exec(page, "player:play");
  await until(page, (x) => x.some((e) => e.v === "handleEvent:video:play"), 5000, "video:play после player:play", m);

  // Первое Back при видимой панели плеера только прячет её; второе закрывает плеер через trigger:back.
  let stop: Tl | undefined;
  let pressedAt = 0;
  for (let n = 0; n < 3 && stop === undefined; n++) {
    pressedAt = await pluginNow(page);
    const mb = await mark(page);
    await page.keyboard.press("Backspace");
    stop = await until(page, (x) => x.some((e) => e.v === "handleEvent:video:stop"), 1500, "video:stop", mb)
      .then((x) => x.find((e) => e.v === "handleEvent:video:stop"), () => undefined);
  }
  expect(stop, "Back закрыл плеер: video:stop дошёл до плагина").toBeDefined();
  expect(stop!.pos ?? 0, "video:stop с позицией").toBeGreaterThanOrEqual(pausePos);
  tl = await timeline(page, m);
  const backShot = tl.filter((e) => e.v === "handleData:video" && e.t >= pressedAt && e.i < stop!.i);
  expect(backShot.length, "Back-снимок (trigger:back) раньше video:stop").toBeGreaterThanOrEqual(1);
  expect(backShot.at(-1)!.pos ?? 0).toBeGreaterThanOrEqual(pausePos);
  expect(tl.find((e) => e.v === "stop")?.pos, "трекер закрыл сессию с позицией").toBe(stop!.pos);
  await expectContent(page, "Тестовый сериал «Короткий»");
});

test("CE-05: панель поверх карточки; за весь файл iframe плагина не перезагружался", async () => {
  // V-15: на кнопке озвучки — студия без подписи «Озвучка:».
  const studio = findItem(FIX.SERIAL_SMALL)?.seasons?.[0]?.episodes[0]?.audios[0]?.author?.title;
  expect(studio, "у озвучки SERIAL_SMALL есть студия").toBeDefined();
  await press(page, "b_audio", studio!);
  const panel = page.locator("#appPanelContent");
  await expect(panel).toBeVisible();
  await expect(panel).not.toContainText(/Content Not Available|Содержимое недоступно/i);
  await until(page, (tl) => tl.some((e) => e.k === "res" && e.v.startsWith(`panel:audio:${FIX.SERIAL_SMALL}:`)), 5000, "панель озвучки");
  await page.keyboard.press("Backspace");
  await expect(panel).toBeHidden();
  await expectContent(page, "Тестовый сериал «Короткий»");

  // Р-30: перезагрузку выдаёт смена bootId, а не число запросов init (после входа replace:menu законно повторяет init).
  const s = await stats(page);
  expect(s.bootId).toBe(bootId);
  expect(s.readyCount).toBe(1);
  expect(page.frames().filter((f) => f.url() === P)).toHaveLength(1);
  const kinds = new Set((await timeline(page)).filter((e) => e.k === "req").map((e) => e.v.split(":")[0]));
  expect([...kinds].sort(), "сессия прошла меню, главную, списки, поиск, карточку, плеер и панель").toEqual(
    expect.arrayContaining(["home", "init", "item", "list", "panel", "play", "search"]));
});
