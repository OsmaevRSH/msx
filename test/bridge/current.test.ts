import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CurrentScreen } from "../../src/bridge/current.ts";

describe("CurrentScreen (спец. §6.3, CD-16)", () => {
  it("nothing is current before the first content request", () => {
    const c = new CurrentScreen();
    assert.equal(c.get(), undefined);
    assert.equal(c.isCurrent("home"), false);
  });

  it("a content request becomes current", () => {
    const c = new CurrentScreen();
    c.onRequest("home");
    c.onRequest("item:1");
    assert.equal(c.get(), "item:1");
    assert.equal(c.isCurrent("item:1"), true);
    assert.equal(c.isCurrent("home"), false);
  });

  it("item:1 → panel:audio:… keeps item:1 current", () => {
    const c = new CurrentScreen();
    c.onRequest("item:1");
    c.onRequest("panel:audio:1:10:c");
    assert.equal(c.get(), "item:1");
  });

  it("dev → probe:flag:<name> (the switch panel) keeps dev current; probe:report:… is content", () => {
    const c = new CurrentScreen();
    c.onRequest("dev");
    c.onRequest("probe:flag:streamMode");
    assert.equal(c.get(), "dev");
    c.onRequest("probe:report:1");
    assert.equal(c.get(), "probe:report:1");
  });

  it("play:… (resolve) does not change the current screen", () => {
    const c = new CurrentScreen();
    c.onRequest("season:2001:1");
    c.onRequest("play:2001:continue");
    c.onRequest("play:2001:2001004:1:4:at597");
    c.onRequest("play:probe:a1:2001:2001001:1:1");
    assert.equal(c.get(), "season:2001:1");
  });

  it("init (menu) is not content and does not change the current screen", () => {
    const c = new CurrentScreen();
    c.onRequest("list:abc");
    c.onRequest("init");
    assert.equal(c.get(), "list:abc");
  });

  it("probe pages and login are content", () => {
    const c = new CurrentScreen();
    c.onRequest("login");
    assert.equal(c.get(), "login");
    c.onRequest("probe:report:2");
    assert.equal(c.get(), "probe:report:2");
  });
});
