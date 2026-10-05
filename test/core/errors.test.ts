import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KpError, isKpError, toKpError } from "../../src/core/errors.ts";

describe("KpError", () => {
  it("keeps code, message, status and detail", () => {
    const e = new KpError("KP-5XX", "server error", 502, "bad gateway");
    assert.ok(e instanceof Error);
    assert.equal(e.name, "KpError");
    assert.equal(e.code, "KP-5XX");
    assert.equal(e.message, "server error");
    assert.equal(e.status, 502);
    assert.equal(e.detail, "bad gateway");
  });

  it("leaves status and detail undefined when omitted", () => {
    const e = new KpError("KP-NET", "offline");
    assert.equal(e.status, undefined);
    assert.equal(e.detail, undefined);
  });

  it("isKpError distinguishes KpError from other values", () => {
    assert.equal(isKpError(new KpError("KP-BAD", "x")), true);
    assert.equal(isKpError(new Error("x")), false);
    assert.equal(isKpError({ code: "KP-BAD" }), false);
    assert.equal(isKpError(undefined), false);
  });
});

describe("toKpError", () => {
  it("TypeError from fetch → KP-NET", () => {
    const e = toKpError(new TypeError("Failed to fetch"));
    assert.equal(e.code, "KP-NET");
    assert.equal(e.message, "Failed to fetch");
  });

  it("AbortError → KP-NET", () => {
    assert.equal(toKpError(new DOMException("The operation was aborted.", "AbortError")).code, "KP-NET");
    const ac = new AbortController();
    ac.abort();
    assert.equal(toKpError(ac.signal.reason).code, "KP-NET");
  });

  it("TimeoutError → KP-NET", () => {
    assert.equal(toKpError(new DOMException("timed out", "TimeoutError")).code, "KP-NET");
  });

  it("KpError passes through unchanged", () => {
    const original = new KpError("KP-429", "too many", 429);
    assert.equal(toKpError(original), original);
  });

  it("anything else → KP-BAD", () => {
    assert.equal(toKpError(new SyntaxError("Unexpected token <")).code, "KP-BAD");
    assert.equal(toKpError(new Error("boom")).code, "KP-BAD");
    const s = toKpError("oops");
    assert.equal(s.code, "KP-BAD");
    assert.equal(s.message, "oops");
    assert.equal(toKpError(undefined).code, "KP-BAD");
  });
});
