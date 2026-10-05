import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { b64urlDecode, b64urlEncode } from "../../src/core/b64url.ts";

describe("b64url", () => {
  it("round-trips UTF-8 text", () => {
    for (const s of ["catalog|type=movie|жанр", "", "a", "ab", "abc", "fresh|type=serial|genre=23", "эмодзи 🎬 и ё"]) {
      assert.equal(b64urlDecode(b64urlEncode(s)), s);
    }
  });

  it("uses the URL-safe alphabet without padding", () => {
    for (const s of ["catalog|type=movie|жанр", "???>>>", "~~~ÿÿÿ", "a", "ab"]) {
      const enc = b64urlEncode(s);
      assert.doesNotMatch(enc, /[+/=]/, `${s} → ${enc}`);
      assert.match(enc, /^[A-Za-z0-9_-]*$/);
    }
  });

  it("matches Node's base64url encoding of UTF-8", () => {
    const s = "catalog|type=movie|sort=-updated|genre=";
    assert.equal(b64urlEncode(s), Buffer.from(s, "utf8").toString("base64url"));
    assert.equal(b64urlEncode("жанр"), Buffer.from("жанр", "utf8").toString("base64url"));
  });

  it("throws on input that is not base64url", () => {
    assert.throws(() => b64urlDecode("a"));
    assert.throws(() => b64urlDecode("@@@@"));
  });
});
