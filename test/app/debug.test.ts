import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Ring, installDebugHooks } from "../../src/app/debug.ts";
import type { DebugStats } from "../../src/app/debug.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

const g = globalThis as { __kp?: { ctx: unknown; stats(): DebugStats } };

let t: TestApp | undefined;
afterEach(async () => {
  delete g.__kp;
  await t?.close();
  t = undefined;
});

describe("Ring", () => {
  it("keeps the last N values in order", () => {
    const r = new Ring<number>(3);
    for (let i = 1; i <= 5; i++) r.push(i);
    assert.deepEqual(r.items(), [3, 4, 5]);
  });
});

describe("installDebugHooks", () => {
  it("does nothing without build.debugHooks", async () => {
    t = await createTestApp();
    const host = t.ctx.host;
    installDebugHooks(t.ctx, t.app);
    assert.equal(g.__kp, undefined);
    assert.equal(t.ctx.host, host);
  });

  it("exposes __kp.stats() with requests, recorded actions and messages", async () => {
    t = await createTestApp({ loggedIn: true });
    t.ctx.build.debugHooks = true;
    installDebugHooks(t.ctx, t.app);
    assert.ok(g.__kp);
    assert.equal(g.__kp.ctx, t.ctx);
    t.app.ready();
    await t.request("init");
    t.ctx.host.executeAction("reload:content");
    t.app.handleData({ message: "pf:7" });
    const s = g.__kp.stats();
    assert.equal(s.bootId, t.ctx.state.bootId);
    assert.equal(s.readyCount, 1);
    assert.equal(s.initCount, 1);
    assert.equal(typeof s.readyAt, "number");
    assert.equal(typeof s.initAnsweredAt, "number");
    assert.deepEqual(s.requests, ["init"]);
    assert.ok(s.actions.includes("reload:content"));
    assert.deepEqual(s.messages, ["pf:7"]);
    // Прокси передаёт действия настоящему хосту.
    assert.ok(t.host.actions.some((a) => a.action === "reload:content"));
  });

  it("actions of services (onLoggedOut) go through the recording proxy", async () => {
    t = await createTestApp({ loggedIn: true });
    t.ctx.build.debugHooks = true;
    installDebugHooks(t.ctx, t.app);
    await t.run(t.ctx.auth.logout());
    assert.ok(g.__kp?.stats().actions.includes("reload:menu"));
  });
});
