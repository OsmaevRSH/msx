import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { persistState } from "../../src/app/context.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
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

  it("SET-4: KinoPub did not confirm the unlink → the guest menu and «устройство осталось в аккаунте»", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/device/unlink$", status: 502 }] });
    await t.run(t.ctx.auth.logout());
    assert.equal(t.ctx.auth.isLoggedIn(), false);
    assert.deepEqual(actions(t), [TO_MENU("Вы вышли, но устройство осталось в аккаунте KinoPub — удалите его в списке устройств на сайте")]);
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

describe("device setup after login (createApp)", () => {
  // SET-7: регистрация идёт фоном; устройство, прочитанное в кэш до её настроек (панель CDN), сбрасывается после них.
  it("SET-7: device/info cached while the background setup runs is dropped once the setup saves the settings", async () => {
    const t = await createTestApp();
    apps.push(t);
    t.ctx.prefs.update({ maxQuality: 2160 });
    t.mock.setScenario({ rules: [{ path: "^/v1/device/\\d+/settings$", method: "POST", delayMs: 100 }] });
    await t.run(t.ctx.auth.completeLogin({ ...t.mock.issueToken(), expiresIn: 3600 }, "MSX TV"));
    assert.equal((await t.run(t.ctx.repo.deviceInfo())).value.settings.support4k, 0, "read before the setup saved 4K");
    await t.run(t.ctx.auth.deviceReady());
    assert.equal((await t.run(t.ctx.repo.deviceInfo())).value.settings.support4k, 1);
  });
});

// SET-8: выход стирает личное прежнего входа (кэш, outbox, оверлей, списки в памяти); kp.cfg.* — настройки ТВ — остаются.
describe("SET-8: what logout leaves behind (createApp)", () => {
  const keys = (t: TestApp, prefix: string): string[] =>
    Array.from({ length: t.storage.length }, (_, i) => t.storage.key(i) ?? "").filter((k) => k.startsWith(prefix));

  async function used(): Promise<TestApp> {
    const t = await make();
    t.ctx.prefs.update({ maxQuality: 720 });
    await t.run(t.ctx.repo.user());
    t.ctx.overlay.set(FIX.SERIAL_SMALL, 1, 1, { time: 100, status: 0 });
    t.ctx.outbox.putMarktime(FIX.SERIAL_SMALL, 1, 1, 100);
    persistState(t.ctx, true);
    t.ctx.state.lists.set("k", { key: "k", items: [], page: 1, totalPages: 1, done: true });
    assert.ok(keys(t, "kp.l2.").length > 0 && keys(t, "kp.out.").length > 0);
    return t;
  }

  for (const [why, unlink] of [["logout", undefined], ["logout-local", 502]] as const) {
    it(`${why}: no kp.l2.* and kp.out.*, empty caches, overlay and lists; kp.cfg.* stays`, async () => {
      const t = await used();
      if (unlink !== undefined) t.mock.setScenario({ rules: [{ path: "^/v1/device/unlink$", status: unlink }] });
      await t.run(t.ctx.auth.logout());
      assert.deepEqual([keys(t, "kp.l2."), keys(t, "kp.out.")], [[], []]);
      await t.clock.advance(60_000);
      assert.deepEqual(keys(t, "kp.out."), [], "SET-15: the wiped (unchanged) overlay is not written back by the 30 s tick");
      assert.ok(keys(t, "kp.cfg.").includes("kp.cfg.prefs"));
      assert.equal(t.ctx.repo.peekUser(), undefined);
      assert.equal(t.ctx.overlay.get(FIX.SERIAL_SMALL, 1, 1), undefined);
      assert.equal(t.ctx.state.lists.size, 0);
    });
  }

  it("refresh-rejected (the same account, its session expired): the data stays", async () => {
    const t = await used();
    t.mock.setScenario({ refreshInvalid: true });
    await t.run(t.ctx.auth.refresh(1).catch(() => undefined));
    assert.equal(t.ctx.auth.isLoggedIn(), false);
    assert.ok(keys(t, "kp.l2.").length > 0 && keys(t, "kp.out.").length > 0);
    assert.notEqual(t.ctx.repo.peekUser(), undefined);
    assert.equal(t.ctx.state.lists.size, 1);
  });
});

describe("persistState (SET-15)", () => {
  // SET-15: у квоты localStorage каждая запись kp.out.* раз в 30 с стирала L2 — оверлей пишется, только если изменился.
  it("SET-15: kp.out.overlay is written only when the overlay changed", async () => {
    const t = await make();
    const n = (): number => t.storage.writes.filter((k) => k === "kp.out.overlay").length;
    persistState(t.ctx, false);
    persistState(t.ctx, false);
    await t.clock.advance(60_000);
    assert.equal(n(), 0, "an empty overlay of a fresh start is not written at all");
    t.ctx.overlay.set(FIX.SERIAL_SMALL, 1, 1, { time: 5, status: 0 });
    persistState(t.ctx, false);
    persistState(t.ctx, false);
    await t.clock.advance(30_000);
    assert.equal(n(), 1);
    t.ctx.overlay.set(FIX.SERIAL_SMALL, 1, 1, { time: 35, status: 0 });
    await t.clock.advance(30_000);
    assert.equal(n(), 2);
  });
});
