import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

// Выход и потеря сессии (спец. §6.3, §12; V-39): гостевое меню и причина уведомлением.

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(): Promise<TestApp> {
  const t = await createTestApp({ loggedIn: true });
  apps.push(t);
  return t;
}

const REFRESH_MENU = `replace:menu:menu:request:interaction:init@${TEST_P}`;
/**
 * X-3: `replace:menu` MSX выполняет только на корневом экране — сначала `home` и `cleanup` (на корне `home` открывает
 * системное «Меню» MSX), замена меню — после анимации.
 */
const TO_MENU = (toast: string): string => `[home|cleanup|lazy:${REFRESH_MENU}|info:${toast}]`;
const actions = (t: TestApp): string[] => t.host.actions.map((a) => a.action);

describe("auth.onLoggedOut (createApp)", () => {
  it("logout → home, the guest menu and «Вы вышли из KinoPub»", async () => {
    const t = await make();
    await t.run(t.ctx.auth.logout());
    assert.equal(t.ctx.auth.isLoggedIn(), false);
    assert.deepEqual(actions(t), [TO_MENU("Вы вышли из KinoPub")]);
  });

  it("a rejected refresh → home, the guest menu and the KP-AUTH reason", async () => {
    const t = await make();
    t.mock.setScenario({ refreshInvalid: true });
    await t.run(t.ctx.auth.refresh(1).catch(() => undefined));
    assert.equal(t.ctx.auth.isLoggedIn(), false);
    assert.deepEqual(actions(t), [TO_MENU("Сессия KinoPub завершена, войдите снова")]);
  });

  it("a login code in progress is dropped: the next login screen starts a new one", async () => {
    const t = await make();
    t.ctx.state.login = { stop: () => undefined } as never;
    await t.run(t.ctx.auth.logout());
    assert.equal(t.ctx.state.login, undefined);
  });
});
