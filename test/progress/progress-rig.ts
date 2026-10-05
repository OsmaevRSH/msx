import { afterEach } from "node:test";
import { sleep } from "../../src/core/clock.ts";
import type { TrackerEvent } from "../../src/progress/tracker.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import type { CallRecord } from "../../tools/kpmock/server.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";

// Общий стенд тестов трекера, heartbeat и outbox (этап 19): приложение со входом против своего kpmock.

export interface Unit { item: number; mid: number; season: number; video: number; duration: number }

/** `SERIAL_BIG` S1E5: в mock не начата (статус −1), 2450 с; 90 % — 2205 с. */
export const EP: Unit = { item: FIX.SERIAL_BIG, mid: FIX.SERIAL_BIG * 1000 + 5, season: 1, video: 5, duration: 2450 };
/** `MOVIE_SIMPLE`: фильм, сезона нет; в mock начат (1200 с). */
export const MOVIE: Unit = { item: FIX.MOVIE_SIMPLE, mid: FIX.MOVIE_SIMPLE * 1000 + 1, season: 0, video: 1, duration: 5400 };

export const pct = (u: Unit, p: number): number => Math.round((u.duration * p) / 100);

/** Свойства ответа resolve с маркерами `kp:*` (MSX возвращает их строками). */
export function kpProps(u: Unit = EP, over: Record<string, string> = {}): Record<string, string> {
  const p: Record<string, string> = { "kp:i": String(u.item), "kp:m": String(u.mid), "kp:e": String(u.video), "kp:d": String(u.duration), "kp:n": "1" };
  if (u.season > 0) p["kp:s"] = String(u.season);
  return { ...p, ...over };
}

/** Стенды теста закрываются после него; у каждого свой mock, журналы не смешиваются. */
export function useApps(): (o?: TestAppOptions) => Promise<TestApp> {
  let apps: TestApp[] = [];
  afterEach(async () => {
    for (const t of apps) await t.close();
    apps = [];
  });
  return async (o = {}) => {
    const t = await createTestApp({ loggedIn: true, ...o });
    apps.push(t);
    return t;
  };
}

export function recordEvents(t: TestApp): TrackerEvent[] {
  const out: TrackerEvent[] = [];
  t.ctx.tracker.addListener((e) => out.push(e));
  return out;
}

// --- Входы MSX (спец. §10.1, msx-platform §4.6) ---

export function load(t: TestApp, props: Record<string, string> = kpProps(), position = 0, duration = EP.duration): void {
  t.app.handleEvent({ event: "video:load", info: { id: "v", url: "https://cdn.invalid/v.m3u8", label: "v", properties: props }, data: { state: 0, position, duration } });
}

export function player(t: TestApp, name: "play" | "pause" | "stop", data?: Record<string, unknown>): void {
  t.app.handleEvent(data === undefined ? { event: `video:${name}` } : { event: `video:${name}`, data });
}

/** `interaction:commit:video` из триггеров плеера (`trigger:60t`, `trigger:back`, `trigger:90%`). */
export function snapshot(t: TestApp, position: number, props: Record<string, string> = kpProps(), duration = EP.duration): void {
  t.app.handleData({ video: { info: { properties: props }, data: { position, duration } } });
}

export function videoData(position: number, props: Record<string, string> = kpProps(), duration = EP.duration): unknown {
  return { video: { info: { properties: props }, data: { position, duration } } };
}

// --- Время ---

/** Поддельное время идёт `ms`, ввод-вывод mock успевает завершиться. Не больше 120 с за вызов. */
export function pass(t: TestApp, ms: number): Promise<void> {
  return t.run(sleep(t.clock, ms));
}

/** Ждать условия, двигая поддельное время шагами по `stepMs` (не дольше `maxMs` поддельного времени). */
export function waitFor(t: TestApp, cond: () => boolean, what: string, maxMs = 60_000, stepMs = 50): Promise<void> {
  const until = t.clock.now() + maxMs;
  return t.clock.runUntilSettled(new Promise<void>((resolve, reject) => {
    const check = (): void => {
      if (cond()) resolve();
      else if (t.clock.now() > until) reject(new Error(`waitFor: ${what}`));
      else t.clock.setTimeout(check, stepMs);
    };
    check();
  }), maxMs + 1000);
}

// --- Журнал mock ---

export const q = (c: CallRecord): URLSearchParams => new URLSearchParams(c.query);
export const apiCalls = (t: TestApp, path: string): CallRecord[] => t.mock.calls().filter((c) => c.path === path);

export interface Mark { id: number; video: number; season: number | undefined; time: number }

export function marktimes(t: TestApp): Mark[] {
  return apiCalls(t, "/v1/watching/marktime").map((c) => {
    const p = q(c);
    const season = p.get("season");
    return { id: Number(p.get("id")), video: Number(p.get("video")), season: season === null ? undefined : Number(season), time: Number(p.get("time")) };
  });
}

export const toggles = (t: TestApp): CallRecord[] => apiCalls(t, "/v1/watching/toggle");
export const watchingReads = (t: TestApp): CallRecord[] => apiCalls(t, "/v1/watching");

/** Пробы `no-cors` идут без заголовка Origin (эмулятор CORS, спец. §5.3 п. 2). */
export const noCorsCalls = (t: TestApp): CallRecord[] => t.mock.calls().filter((c) => c.origin === undefined);

export const logged = (t: TestApp, msg: string): number => t.ctx.log.entries().filter((e) => e.msg === msg).length;
