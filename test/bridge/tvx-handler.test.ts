import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PluginApp } from "../../src/bridge/host.ts";
import { KpHandler, TvxHost } from "../../src/bridge/tvx-handler.ts";
import { KpError } from "../../src/core/errors.ts";
import { errorText } from "../../src/screens/error.ts";

class SpyApp implements PluginApp {
  calls: string[] = [];
  result: Promise<unknown> = Promise.resolve({ ok: 1 });
  throwSync: unknown;

  ready(): void {
    this.calls.push("ready");
  }

  handleRequest(dataId: string, data: unknown): Promise<unknown> {
    this.calls.push(`request ${dataId} ${JSON.stringify(data)}`);
    if (this.throwSync !== undefined) throw this.throwSync;
    return this.result;
  }

  handleData(data: any): void {
    this.calls.push(`data ${JSON.stringify(data)}`);
  }

  handleEvent(event: any): void {
    this.calls.push(`event ${JSON.stringify(event)}`);
  }
}

const respond = (h: KpHandler, dataId: string, data: object = {}): Promise<unknown> =>
  new Promise((resolve) => h.handleRequest(dataId, data, resolve));

describe("KpHandler", () => {
  it("handleRequest passes the app result to the callback", async () => {
    const app = new SpyApp();
    assert.deepEqual(await respond(new KpHandler(app), "home", { a: 1 }), { ok: 1 });
    assert.deepEqual(app.calls, ['request home {"a":1}']);
  });

  it("a rejected request answers { error } with the error text", async () => {
    const app = new SpyApp();
    const err = new KpError("KP-NET", "offline");
    app.result = Promise.reject(err);
    assert.deepEqual(await respond(new KpHandler(app), "play:1:continue"), { error: errorText(err).text });
  });

  it("a synchronous throw also answers { error }", async () => {
    const app = new SpyApp();
    app.throwSync = new KpError("KP-BAD", "boom");
    assert.deepEqual(await respond(new KpHandler(app), "home"), { error: errorText(app.throwSync).text });
  });

  it("ready, handleData and handleEvent are forwarded; their exceptions do not escape", () => {
    const app = new SpyApp();
    const h = new KpHandler(app);
    h.ready();
    h.handleData({ message: "pf:1" });
    h.handleEvent({ event: "video:play" });
    assert.deepEqual(app.calls, ["ready", 'data {"message":"pf:1"}', 'event {"event":"video:play"}']);
    app.handleData = () => {
      throw new Error("x");
    };
    app.handleEvent = () => {
      throw new Error("y");
    };
    assert.doesNotThrow(() => h.handleData({}));
    assert.doesNotThrow(() => h.handleEvent({}));
  });
});

describe("TvxHost", () => {
  it("forwards executeAction and turns requestData callbacks into promises", async () => {
    const seen: unknown[] = [];
    const host = new TvxHost({
      executeAction: (a, d) => seen.push([a, d]),
      requestData: (id, cb) => setImmediate(() => cb({ [id]: { platform: "tizen" } })),
    });
    host.executeAction("reload:menu");
    host.executeAction("info:x", { a: 1 });
    assert.deepEqual(seen, [["reload:menu", undefined], ["info:x", { a: 1 }]]);
    assert.deepEqual(await host.requestData("info"), { info: { platform: "tizen" } });
  });
});
