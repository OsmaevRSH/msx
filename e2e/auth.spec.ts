import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { ids } from "../src/router/ids.ts";
import { P, content, exec, expectContent, kp, menuItem, mock, newMsxPage, openMsx } from "./fixtures.ts";
import type { MockCall } from "./fixtures.ts";
import { attachDiagnostics, installTimeline, selected } from "./flows-kit.ts";
import { panelAction } from "../src/msx/actions.ts";

// Вход и выход без связи (пакет fix-qa-auth, QA 2026-10-22): отказ KinoPub при опросе входа (QA-SET-6) и выход, когда
// KinoPub не подтверждает отвязку устройства (QA-SET-4). Одна сессия web MSX: сначала вход отклонён, «Повторить» даёт
// новый код, его mock подтверждает; затем выход с висящим `device/unlink`.

test.describe.configure({ mode: "serial" });

let page: Page;

const codeGrants = (calls: MockCall[]): number =>
  calls.filter((c) => c.path === "/oauth2/device" && new URLSearchParams(c.query).get("grant_type") === "device_code").length;
const userCode = (): Promise<string | undefined> => kp(page, (k) => k.ctx.state.login?.state().userCode as string | undefined);

test.beforeAll(async ({ browser }) => {
  await mock.reset();
  await mock.scenario({ pendingPolls: 1_000_000 });
  page = await newMsxPage(browser);
  await openMsx(page);
  await installTimeline(page);
});

test.afterEach(async ({}, info) => {
  if (info.status !== info.expectedStatus) await attachDiagnostics(page, info);
});

test.afterAll(async () => {
  await page?.close();
});

test("E-43: отказ KinoPub при опросе входа — «KinoPub отклонил вход» с причиной и «Повторить»; сам код не меняется, «Повторить» — новый код", async () => {
  await expectContent(page, "Введите код", { timeout: 15_000 });
  const first = await userCode();
  expect(first, "код входа от mock").toMatch(/^[A-Z]{6}$/);
  // Следующий опрос (раз в 5 с) получает 400 с незнакомой ошибкой — как отказ при лимите устройств.
  await mock.scenario({ rules: [{ path: "^/oauth2/device$", status: 400, times: 1 }] });
  await expectContent(page, "KinoPub отклонил вход", { timeout: 15_000 });
  await expectContent(page, "Проверьте число устройств в аккаунте KinoPub");
  await expect(content(page).locator(`img[src*="${first as string}"]`), "старого кода на экране нет").toHaveCount(0);
  // Экран входа открыт из меню при старте: фокус в меню MSX, «вправо» — в контент, на «Повторить».
  await page.keyboard.press("ArrowRight");
  await expect(selected(page), "фокус на «Повторить»").toContainText("Повторить");
  const grants = codeGrants(await mock.calls());
  // Раньше здесь через секунды появлялся новый код без объяснений; теперь экран отказа держится.
  await page.waitForTimeout(7000);
  expect(codeGrants(await mock.calls()), "новый код не запрашивается сам").toBe(grants);
  await expectContent(page, "KinoPub отклонил вход");

  await page.keyboard.press("Enter");
  await expectContent(page, "Введите код", { timeout: 15_000 });
  const next = await userCode();
  expect(next).toMatch(/^[A-Z]{6}$/);
  expect(next, "«Повторить» — новый код").not.toBe(first);
  await expect(content(page).locator(`img[src*="${next as string}"]`), "новый код картинкой на экране").toBeVisible();
  expect(codeGrants(await mock.calls())).toBe(grants + 1);
});

test("E-44: выход при висящем device/unlink — сразу «Выхожу из KinoPub…», не дольше 6 с — «Вы вышли, но устройство осталось…»", async () => {
  // Новый код подтверждается на ближайшем опросе: вход выполнен.
  await mock.scenario({ pendingPolls: 0, rules: [] });
  await expect.poll(() => kp(page, (k) => k.ctx.auth.isLoggedIn() as boolean), { message: "вход выполнен", timeout: 30_000, intervals: [200] })
    .toBe(true);
  // Фокус в контенте (E-43), меню MSX свёрнуто до значков: подписи пунктов есть, но скрыты.
  await expect(menuItem(page, "Главная"), "меню после входа").toHaveCount(1, { timeout: 15_000 });

  await mock.scenario({ rules: [{ path: "^/v1/device/unlink$", hang: true }] });
  await exec(page, panelAction(P, ids.panel("setting", "account")));
  const panel = page.locator("#appPanelContent");
  await expect(panel).toContainText("Выйти из KinoPub?");
  await page.keyboard.press("ArrowUp");
  await expect(panel.locator(".selected")).toContainText("Выйти");
  const t0 = Date.now();
  await page.keyboard.press("Enter");
  const toast = page.locator("#appNotificationScene");
  await expect(toast, "выход виден сразу").toContainText("Выхожу из KinoPub…", { timeout: 3000 });
  await expect(toast).toContainText("Вы вышли, но устройство осталось в аккаунте KinoPub — удалите его в списке устройств на сайте", { timeout: 10_000 });
  expect(Date.now() - t0, "не дольше 6 с ожидания отвязки (и запаса на анимации)").toBeLessThan(9000);
  expect(await kp(page, (k) => k.ctx.auth.isLoggedIn() as boolean)).toBe(false);
  await expect(menuItem(page, "Вход"), "меню гостевое").toHaveCount(1, { timeout: 15_000 });
  await expect(menuItem(page, "Главная")).toHaveCount(0);
  const keys = await kp(page, (k) => {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i) ?? "");
    return out.filter((x) => x.startsWith("kp.auth.") || x.startsWith("kp.out."));
  });
  expect(keys, "SET-8: ни токенов, ни outbox прежнего входа").toEqual([]);
});
