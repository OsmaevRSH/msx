import assert from "node:assert/strict";
import type { MsxContentItem, MsxContentRoot, MsxMenuRoot } from "../../src/msx/types.ts";
import type { CallRecord } from "../../tools/kpmock/server.ts";
import type { TestApp } from "../helpers/harness.ts";
import { TEST_P } from "../helpers/harness.ts";
import { noCorsCalls } from "../progress/progress-rig.ts";

// Общие помощники сквозных contract-тестов Phase 1 (этап 29): плагин ведётся только действиями из своих ответов,
// как это сделал бы MSX, а проверки трафика и журнала — по журналу kpmock и `ctx.log`.

/** Меню из start parameter перерисовывается только `replace:menu` (smoke-e2e этапа 27). */
export const CHAIN_DONE = `[info:Вход выполнен|replace:menu:menu:request:interaction:init@${TEST_P}]`;
const COMMIT = "interaction:commit:message:";

/** `request:…`, `content:request:…`, `panel:request:…`, `video:resolve:request:…` с полным адресом плагина → dataId. */
export function follow(action: string | undefined, kind: "" | "content" | "panel" | "video:resolve"): string {
  const head = `${kind === "" ? "" : `${kind}:`}request:interaction:`;
  const tail = `@${TEST_P}`;
  assert.ok(action?.startsWith(head) === true && action.endsWith(tail), `not a ${kind || "request"} action of the plugin: ${action}`);
  return action.slice(head.length, -tail.length);
}

/** `interaction:commit:message:<msg>` → `<msg>`, как его получит `handleData`. */
export function message(action: string | undefined): string {
  assert.ok(action?.startsWith(COMMIT) === true, `not a commit message: ${action}`);
  return action.slice(COMMIT.length);
}

/** MSX выполнил `interaction:commit:message:…` из элемента. */
export function commit(t: TestApp, action: string | undefined): void {
  t.app.handleData({ message: message(action) });
}

/** Ждать в поддельном времени (через `t.run`), пока условие не выполнится. */
export async function until(pred: () => boolean): Promise<void> {
  while (!pred()) await new Promise<void>((resolve) => setImmediate(resolve));
}

export const actions = (t: TestApp): string[] => t.host.actions.map((a) => a.action);

export function menuItem(m: MsxMenuRoot, id: string): { data?: string } {
  const it = m.menu.find((x) => x.id === id);
  assert.ok(it, `no menu item ${id}: ${m.menu.map((x) => x.id).join(",")}`);
  return it;
}

export function pick(list: MsxContentItem[] | undefined, pred: (i: MsxContentItem) => boolean, what: string): MsxContentItem {
  const found = list?.find(pred);
  assert.ok(found, `no ${what}`);
  return found;
}

export const pageItems = (s: MsxContentRoot): MsxContentItem[] => s.pages?.[0]?.items ?? [];

/** Причина и код экрана ошибки S14 (`<текст>{br}Код: KP-…`), иначе undefined. */
export function errorCode(s: MsxContentRoot): string | undefined {
  const text = pageItems(s)[0]?.text ?? "";
  return /Код: (KP-[A-Z0-9]+)$/.exec(text)?.[1];
}

/** Ни один экран не говорит о CORS: `KP-CORS` выносит только пробник CDG-01 (спец. §5.3 п. 3). */
export function assertNoCorsVerdict(screens: unknown[]): void {
  for (const s of screens) assert.ok(!JSON.stringify(s).includes("KP-CORS"), `KP-CORS on a screen: ${JSON.stringify(s).slice(0, 200)}`);
}

/** CNFR-16: размер ответа в байтах UTF-8. */
export const bytes = (v: unknown): number => new TextEncoder().encode(JSON.stringify(v)).length;

export const apiOf = (calls: CallRecord[]): CallRecord[] => calls.filter((c) => c.path.startsWith("/v1/") || c.path.startsWith("/oauth2/"));

/**
 * CC-01, CNFR-19, CM-01 по журналу mock: ни одного `OPTIONS`, ни одного `Authorization`, тело POST — только форма,
 * каждая проба `no-cors` — `GET /v1/types?access_token=x`; эмуляторы CORS не делали preflight.
 */
export function assertCleanTraffic(calls: CallRecord[], apps: TestApp[]): void {
  assert.deepEqual(calls.filter((c) => c.method === "OPTIONS").map((c) => c.path), [], "preflight requests");
  assert.deepEqual(calls.filter((c) => c.hasAuthHeader).map((c) => c.path), [], "Authorization header");
  for (const c of calls) {
    const ok = c.contentType === undefined || c.contentType.startsWith("application/x-www-form-urlencoded");
    assert.ok(ok, `${c.method} ${c.path}: Content-Type ${c.contentType}`);
  }
  for (const c of calls.filter((x) => x.origin === undefined)) {
    assert.equal(`${c.method} ${c.path}?${c.query}`, "GET /v1/types?access_token=x", "a no-cors probe");
  }
  for (const t of apps) assert.equal(t.fetch.preflights, 0);
}

/** Пробы `no-cors` в журнале mock (без `Origin`), строкой запроса. */
export const probes = (t: TestApp): string[] => noCorsCalls(t).map((c) => `${c.method} ${c.path}?${c.query}`);

/** CNFR-20: в журнале плагина нет токенов, кодов входа и самого слова `user_code`. */
export function assertLogClean(t: TestApp, secrets: string[] = []): void {
  const text = JSON.stringify(t.ctx.log.entries());
  for (const s of ["mock-at-", "mock-rt-", "mock-dc-", "user_code", ...secrets]) {
    assert.ok(!text.includes(s), `the plugin log contains ${s}`);
  }
}
