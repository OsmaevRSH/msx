import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ids } from "../src/router/ids.ts";
import { FIX, findItem } from "../tools/kpmock/fixtures.ts";
import { exec, kp, login, mock, newMsxPage, openMsx, press } from "./fixtures.ts";
import {
  answer, answered, attachDiagnostics, closePlayer, evs, focusPlayerButton, installTimeline, mark, open, playing, resAfter, seek, sleep,
  timeline, until, watchCalls,
} from "./flows-kit.ts";

// Пакет fix-qa-play (QA 2026-10-22) в web MSX: отмена запуска до первого кадра — не сбой цепочки (QA-PLAY-2), запасной
// режим `playerPropsIn: item` после автоперехода — свойства, сессия и прогресс следующей серии (QA-PLAY-6). Одна сессия
// web MSX на файл.

test.describe.configure({ mode: "serial" });

let page: Page;
/** Серии SERIAL_SMALL по 60 с — как WebM mock; S1E1 просмотрена, «▶» карточки — S1E2 с начала. */
const SMALL = FIX.SERIAL_SMALL;
const [S1E2, S1E3] = findItem(SMALL)!.seasons![0]!.episodes.slice(1, 3).map((e) => e.id);
/** Повторный resolve без признака старта через ≥ 8 с прежде считался сбоем (RETRY_AFTER_MS). */
const AFTER_MS = 9000;
const lastStep = (p: Page): Promise<number | undefined> =>
  kp(p, (k) => k.ctx.log.entries().filter((e: any) => e.tag === "resolve" && e.msg === "resolved").at(-1)?.data?.step as number | undefined);

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

test("E-47: «▶», «Назад» до первого кадра, через 9 с снова «▶» — тот же способ, без «Предыдущий запуск не удался»", async () => {
  const play = ids.playContinue(SMALL);
  await open(page, ids.item(SMALL));
  // Поток отвечает через 6 с: «Назад» успевает до первого кадра, как у нетерпеливого зрителя на ТВ.
  await mock.scenario({ rules: [{ path: "^/cdn/media/sample\\.webm$", delayMs: 6000 }] });
  let first: number;
  try {
    first = await mark(page);
    await press(page, "b_main", "Смотреть");
    await answered(page, play, first);
    await until(page, (x) => evs(x, "load").some((e) => e.s?.mid === S1E2), 10_000, "video:load S1E2", first);
    await closePlayer(page);
  } finally {
    await mock.scenario({ rules: [] });
  }
  const t0 = (await until(page, (x) => resAfter(x, play) !== undefined, 1000, "ответ resolve", first)).find((e) => e.k === "res" && e.v === play)!.t;
  expect(evs(await timeline(page, first), "started"), "плеер не стартовал").toEqual([]);
  expect(await lastStep(page)).toBe(1);

  const now = await kp(page, () => Math.round(performance.now()));
  await sleep(Math.max(0, t0 + AFTER_MS - now));
  const again = await mark(page);
  await press(page, "b_main", "Смотреть");
  await answered(page, play, again);
  const res = await answer(page, play);
  expect(res.properties["trigger:load"], "отмена — не сбой: без «Предыдущий запуск не удался»").toBeUndefined();
  expect(await lastStep(page), "тот же шаг цепочки — 1").toBe(1);
  await playing(page, S1E2, again);
  await closePlayer(page);
});

test("E-48: playerPropsIn: item — автопереход S1E2 → S1E3: у S1E3 свойства из resolve, сессия, marktime и наши кнопки", async () => {
  await kp(page, (k) => k.ctx.flags.set("playerPropsIn", "item"));
  try {
    const season = ids.season(SMALL, 1);
    await open(page, season);
    const root = await answer(page, season);
    expect(root.template?.properties?.["kp:m"], "свойства плеера — в шаблоне сезона (Р-18)").toBe("{context:kmid}");
    const from = await mark(page);
    await press(page, `e${S1E2}`, "Серия 2");
    await playing(page, S1E2, from);
    await seek(page, 52);
    const next = ids.playEp(SMALL, S1E3, 1, 3);
    const end = await until(page, (x) => resAfter(x, next) !== undefined && evs(x, "load").some((e) => e.s?.mid === S1E3), 25_000, "автопереход на S1E3", from);
    expect(evs(end, "load").at(-1)?.s, "сессия S1E3 из kp:* ответа resolve").toEqual({ mid: S1E3, season: 1, video: 3 });
    expect((await answer(page, next)).properties, "ответ resolve несёт полные свойства (QA-PLAY-6)").toMatchObject({
      "kp:i": String(SMALL), "kp:m": String(S1E3), "kp:e": "3", "button:content:icon": "audiotrack",
    });
    await playing(page, S1E3, end.at(-1)!.i);
    await seek(page, 35);
    await exec(page, "player:pause");
    await expect.poll(async () => (await watchCalls("marktime", SMALL)).some((c) => c.q.get("video") === "3" && Number(c.q.get("time")) >= 30),
      { message: "marktime серии 3 с позиции паузы", timeout: 10_000 }).toBe(true);
    await focusPlayerButton(page, "audiotrack");
    await closePlayer(page);
  } finally {
    await kp(page, (k) => k.ctx.flags.set("playerPropsIn", "resolve"));
  }
});
