import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fnv1a } from "../../src/core/hash.ts";

describe("fnv1a", () => {
  it("matches the reference FNV-1a 32-bit vectors", () => {
    assert.equal(fnv1a(""), "811c9dc5");
    assert.equal(fnv1a("a"), "e40c292c");
    assert.equal(fnv1a("foobar"), "bf9cf968");
  });

  it("always returns 8 lowercase hex digits and hashes UTF-8", () => {
    for (const s of ["", "x", "Черное зеркало", "list|catalog|type=movie"]) {
      assert.match(fnv1a(s), /^[0-9a-f]{8}$/);
    }
    assert.notEqual(fnv1a("жанр"), fnv1a("жанp"));
  });
});
