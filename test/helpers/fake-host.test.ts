import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FakeHost } from "./fake-host.ts";

describe("FakeHost", () => {
  it("records executed actions and clears them", () => {
    const h = new FakeHost();
    h.executeAction("reload:menu");
    h.executeAction("info:x", { a: 1 });
    assert.deepEqual(h.actions, [{ action: "reload:menu" }, { action: "info:x", data: { a: 1 } }]);
    h.clearActions();
    assert.deepEqual(h.actions, []);
  });

  it("answers requestData from responses and logs requested ids", async () => {
    const h = new FakeHost();
    h.responses.set("info", { info: { platform: "tizen" } });
    let pos = 60;
    h.responses.set("video", () => ({ video: { data: { position: (pos += 10) } } }));
    assert.deepEqual(await h.requestData("info"), { info: { platform: "tizen" } });
    assert.deepEqual(await h.requestData("video"), { video: { data: { position: 70 } } });
    assert.equal(await h.requestData("unknown"), undefined);
    assert.deepEqual(h.requests, ["info", "video", "unknown"]);
  });
});
