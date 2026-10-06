import { expect } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { contentAction } from "../src/msx/actions.ts";
import { MOCK_URL, P, consoleTail, content, exec, kp, mock, pluginFrame } from "./fixtures.ts";
import type { MockCall } from "./fixtures.ts";

// Помощники сценариев E-03…E-14 (e2e/flows.spec.ts, этап 34): хронология плагина с ответами на запросы MSX и событиями
// трекера, вызовы mock, второй ТВ того же аккаунта, перемотка и закрытие плеера web MSX.

/** Хронология плагина (как в ce.spec.ts) и сессия событий трекера: сезон и серия из `kp:*` ответа resolve. */
export interface Tl { i: number; t: number; k: "req" | "res" | "msg" | "act" | "ev"; v: string; n?: number; pos?: number; s?: { mid: number; season: number; video: number } }

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const selected = (p: Page) => content(p).locator(".app-main-content-item.selected");
export const panel = (p: Page) => p.locator("#appPanelContent");
export const isPf = (e: Tl): boolean => e.k === "msg" && e.v.startsWith("pf:");
export const resAfter = (tl: Tl[], dataId: string): Tl | undefined => tl.find((e) => e.k === "res" && e.v === dataId);
export const evs = (tl: Tl[], v: string): Tl[] => tl.filter((e) => e.k === "ev" && e.v === v);

export async function kpWith<A, T>(p: Page, fn: (k: any, a: A) => T, arg: A): Promise<T> {
  return (await pluginFrame(p)).evaluate(`(${fn.toString()})(globalThis.__kp, ${JSON.stringify(arg)})`) as Promise<T>;
}

/** Обёртки `__kp.app` и `ctx.host` пишут хронологию в `__kp.tl`, последний ответ на каждый `dataId` — в `__kp.res`. */
export async function installTimeline(p: Page): Promise<void> {
  await kp(p, (k) => {
    const tl: any[] = [];
    k.tl = tl;
    k.res = {};
    const now = (): number => Math.round(performance.now());
    const app = k.app;
    const handleRequest = app.handleRequest.bind(app);
    app.handleRequest = async (id: string, d: unknown) => {
      tl.push({ t: now(), k: "req", v: id });
      const r = await handleRequest(id, d);
      k.res[id] = r;
      tl.push({ t: now(), k: "res", v: id, n: Array.isArray(r?.items) ? r.items.length : undefined });
      return r;
    };
    const handleData = app.handleData.bind(app);
    app.handleData = (d: any) => {
      if (typeof d?.message === "string") tl.push({ t: now(), k: "msg", v: d.message });
      handleData(d);
    };
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
      const s = e.s === undefined ? undefined : { mid: e.s.mid, season: e.s.season, video: e.s.video };
      tl.push({ t: now(), k: "ev", v: raw ? `${e.source}:${e.name}` : e.kind, pos: raw ? e.position : e.pos ?? e.time, s });
    });
  });
}

export async function timeline(p: Page, from = 0): Promise<Tl[]> {
  return kpWith(p, (k, f) => k.tl.slice(f).map((e: any, j: number) => ({ ...e, i: f + j })), from);
}

export async function mark(p: Page): Promise<number> {
  return kp(p, (k) => k.tl.length as number);
}

export async function until(p: Page, pred: (tl: Tl[]) => boolean, timeoutMs: number, what: string, from = 0): Promise<Tl[]> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const tl = await timeline(p, from);
    if (pred(tl)) return tl;
    if (Date.now() > end) throw new Error(`не дождались за ${timeoutMs} мс: ${what}\nхронология: ${JSON.stringify(tl.slice(-30))}\n${consoleTail(p)}`);
    await sleep(50);
  }
}

/** Плагин ответил на запрос MSX `dataId` после отметки `from`. */
export async function answered(p: Page, dataId: string, from: number, timeoutMs = 10_000): Promise<Tl[]> {
  return until(p, (x) => resAfter(x, dataId) !== undefined, timeoutMs, `ответ на ${dataId}`, from);
}

/** Открыть экран действием `content:` (короткий путь) и дождаться ответа; возвращает отметку до действия. */
export async function open(p: Page, dataId: string): Promise<number> {
  const m = await mark(p);
  await exec(p, contentAction(P, dataId));
  await answered(p, dataId, m);
  return m;
}

/** Действия плагина в срезе хронологии, начинающиеся с `prefix`. */
export const acts = (tl: Tl[], prefix: string): Tl[] => tl.filter((e) => e.k === "act" && e.v.startsWith(prefix));

/** Последний ответ плагина на `dataId` (JSON MSX). */
export async function answer(p: Page, dataId: string): Promise<any> {
  return kpWith(p, (k, id) => k.res[id], dataId);
}

/** Сколько раз сверка экрана закончилась так (`refresh.ts`): «not_current home», «replaced item_2002»… */
export async function refreshes(p: Page, outcome: string): Promise<number> {
  return kpWith(p, (k, m) => k.ctx.log.entries().filter((e: any) => e.tag === "refresh" && e.msg === m).length as number, outcome);
}

/** Вызовы mock после `from` с путём под `re`; `q` — разобранный query. */
export async function callsSince(from: number, re: RegExp): Promise<(MockCall & { q: URLSearchParams })[]> {
  return (await mock.calls()).slice(from).filter((c) => re.test(c.path)).map((c) => ({ ...c, q: new URLSearchParams(c.query) }));
}

/** `marktime` или `toggle` тайтла в mock за весь файл. */
export async function watchCalls(what: "marktime" | "toggle", id: number): Promise<(MockCall & { q: URLSearchParams })[]> {
  return (await callsSince(0, new RegExp(`^/v1/watching/${what}$`))).filter((c) => c.q.get("id") === String(id));
}

export const callCount = async (): Promise<number> => (await mock.calls()).length;
export const ITEM_PATH = /^\/v1\/items\/\d+$/;

/** Другой ТВ того же аккаунта (свой токен mock) отмечает позицию: персональные данные меняются вне этого плагина. */
export async function otherTvMarktime(id: number, video: number, time: number): Promise<void> {
  const { access } = (await (await fetch(`${MOCK_URL}/__mock/token`, { method: "POST" })).json()) as { access: string };
  const q = new URLSearchParams({ id: String(id), video: String(video), time: String(time), access_token: access });
  expect((await fetch(`${MOCK_URL}/v1/watching/marktime?${q}`)).status, "marktime другого ТВ").toBe(200);
}

export async function videoTime(p: Page): Promise<number> {
  return p.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime);
}

/** Позиция плеера так, как её видит MSX (`requestData("video")`): она отстаёт от `<video>` до полсекунды. */
export async function msxPos(p: Page): Promise<number> {
  return kp(p, async (k) => Number((await k.ctx.host.requestData("video"))?.video?.data?.position ?? -1));
}

/** Перемотка действием MSX `player:seek`: ролик mock 60 с, ждать его целиком долго. */
export async function seek(p: Page, sec: number): Promise<void> {
  await exec(p, `player:seek:${sec}`);
  await expect.poll(() => msxPos(p), { message: `MSX перемотал на ${sec} с`, timeout: 5000, intervals: [100] }).toBeGreaterThanOrEqual(sec);
}

/** Первое Back при видимой панели плеера только прячет её; следующее закрывает плеер через `trigger:back` (CE-04). */
export async function closePlayer(p: Page): Promise<Tl> {
  for (let n = 0; n < 3; n++) {
    const m = await mark(p);
    await p.keyboard.press("Backspace");
    const stop = await until(p, (x) => evs(x, "handleEvent:video:stop").length > 0, 1500, "video:stop", m)
      .then((x) => evs(x, "handleEvent:video:stop")[0], () => undefined);
    if (stop !== undefined) return stop;
  }
  throw new Error(`Back не закрыл плеер\n${consoleTail(p)}`);
}

/**
 * Панель озвучки поверх плеера — действие его кнопки `button:content` — и выбор другой дорожки (`keys`): плагин
 * перезапускает ту же серию с позиции плеера (спец. §11 S10, X-2). Возвращает ответ на resolve перезапуска.
 */
export async function switchAudio(p: Page, action: string, now: string, keys: string[], next: string, restart: RegExp): Promise<Tl> {
  const from = await mark(p);
  await exec(p, action);
  await expect(panel(p)).toContainText("Озвучка");
  await expect(p.locator("video"), "панель поверх плеера: видео не закрыто").toHaveCount(1);
  const sel = panel(p).locator(".selected");
  await expect(sel, "фокус на играющей дорожке").toContainText(now);
  for (const k of keys) await p.keyboard.press(k);
  await expect(sel).toContainText(next);
  await p.keyboard.press("Enter");
  const tl = await until(p, (x) => x.some((e) => e.k === "res" && restart.test(e.v)), 10_000, `resolve ${restart}`, from);
  await expect(panel(p)).toBeHidden();
  return tl.find((e) => e.k === "res" && restart.test(e.v))!;
}

/** Плеер открыт и играет `mid`: трекер открыл сессию по `video:load`, ролик идёт. */
export async function playing(p: Page, mid: number, from: number): Promise<Tl[]> {
  const tl = await until(p, (x) => evs(x, "load").some((e) => e.s?.mid === mid), 15_000, `video:load mid ${mid}`, from);
  await expect.poll(() => videoTime(p), { message: "WebM играет", timeout: 15_000, intervals: [200] }).toBeGreaterThan(0.5);
  return tl;
}

/** Вложения упавшего теста: экран MSX, консоль, хронология и журнал плагина. */
export async function attachDiagnostics(p: Page, info: TestInfo): Promise<void> {
  await info.attach("msx.png", { body: await p.screenshot(), contentType: "image/png" });
  await info.attach("console.txt", { body: consoleTail(p, 80), contentType: "text/plain" });
  const tl = (await timeline(p).catch(() => [])).slice(-60).map((e) => `${e.t} ${e.k} ${e.v.slice(0, 100)}${e.n === undefined ? "" : ` n=${e.n}`}${e.pos === undefined ? "" : ` pos=${e.pos}`}`);
  await info.attach("timeline.txt", { body: tl.join("\n"), contentType: "text/plain" });
  const log = await kp(p, (k) => k.ctx.log.tail(80).map((e: any) => `${e.t} ${e.level} ${e.tag} ${e.msg} ${JSON.stringify(e.data ?? {})}`)).catch(() => []);
  await info.attach("plugin-log.txt", { body: (log as string[]).join("\n"), contentType: "text/plain" });
}
