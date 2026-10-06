import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chain, commitMsg, contentAction, focusAction, panelAction, playerMsg, replaceContent, req, resolveAction } from "../../src/msx/actions.ts";

const P = "https://u.github.io/msx/app/index.html";

describe("MSX action builders", () => {
  it("req", () => {
    assert.equal(req(P, "init"), "request:interaction:init@https://u.github.io/msx/app/index.html");
  });

  it("focusAction: an internal MSX action, no plugin round trip", () => {
    assert.equal(focusAction("i1001"), "focus:i1001");
  });

  it("contentAction", () => {
    assert.equal(contentAction(P, "item:2001"), "content:request:interaction:item:2001@https://u.github.io/msx/app/index.html");
  });

  it("panelAction", () => {
    assert.equal(panelAction(P, "panel:audio:2004"), "panel:request:interaction:panel:audio:2004@https://u.github.io/msx/app/index.html");
  });

  it("resolveAction", () => {
    assert.equal(
      resolveAction(P, "play:2001:continue"),
      "video:resolve:request:interaction:play:2001:continue@https://u.github.io/msx/app/index.html",
    );
  });

  it("replaceContent", () => {
    assert.equal(
      replaceContent("item_2001", P, "item:2001"),
      "replace:content:item_2001:request:interaction:item:2001@https://u.github.io/msx/app/index.html",
    );
  });

  it("commitMsg", () => {
    assert.equal(commitMsg("pf:2001"), "interaction:commit:message:pf:2001");
    assert.equal(commitMsg("search:input:Ё"), "interaction:commit:message:search:input:Ё");
  });
});

describe("playerMsg", () => {
  it("a message to the player (AVPlay properties at runtime)", () => {
    assert.equal(playerMsg("tizen:subtitle:silent:true"), "player:commit:message:tizen:subtitle:silent:true");
  });
});

describe("chain", () => {
  it("joins actions in brackets", () => {
    assert.equal(chain(["a", "b"]), "[a|b]");
    assert.equal(chain(["info:Вход выполнен", "reload:menu"]), "[info:Вход выполнен|reload:menu]");
    assert.equal(chain(["back", replaceContent("home", P, "home")]), `[back|replace:content:home:request:interaction:home@${P}]`);
  });

  it("an empty chain is the MSX no-op", () => {
    assert.equal(chain([]), "[]");
  });

  it("throws when a member contains |, [ or ]", () => {
    assert.throws(() => chain(["a|b"]), /\|/);
    assert.throws(() => chain(["ok", "[a]"]));
    assert.throws(() => chain(["x]"]));
    assert.throws(() => chain([chain(["a", "b"]), "c"]));
  });
});
