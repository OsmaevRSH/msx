import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { langName, subsLabel } from "../../src/core/lang.ts";
import { audioName, subsName } from "../../src/screens/panels-labels.ts";
import { audioTitle, subsTitle } from "../../src/screens/player.ts";

describe("core/lang: track languages in Russian (V-20)", () => {
  it("voice-over and subtitles forms, any case; other codes in capitals", () => {
    assert.deepEqual(["rus", "ENG", "Ukr", "fre"].map((c) => langName(c, 0)), ["Русский", "Английский", "Украинский", "FRE"]);
    assert.deepEqual(["rus", "ENG", "Ukr", "fre"].map((c) => langName(c, 1)), ["Русские", "Английские", "Украинские", "FRE"]);
    assert.equal(langName("", 0), "");
  });

  it("names of Object.prototype are codes, not dictionary entries", () => {
    assert.equal(langName("constructor", 0), "CONSTRUCTOR");
    assert.equal(langName("__proto__", 1), "__PROTO__");
  });

  it("subtitles: forced — «только надписи»", () => {
    assert.equal(subsLabel({ lang: "eng", forced: false }), "Английские");
    assert.equal(subsLabel({ lang: "eng", forced: true }), "Английские · только надписи");
    assert.equal(subsLabel({ lang: "fre", forced: true }), "FRE · только надписи");
  });

  it("the card, the player and the panels say the same", () => {
    for (const lang of ["rus", "eng", "ukr", "fre"]) {
      for (const forced of [false, true]) assert.equal(subsTitle({ lang, forced }), subsName({ lang, forced }));
      const a = { id: 1, index: 1, codec: "aac", channels: 0, lang };
      assert.equal(audioTitle(a), langName(lang, 0));
      assert.equal(audioName(a, true), langName(lang, 0));
    }
  });
});
