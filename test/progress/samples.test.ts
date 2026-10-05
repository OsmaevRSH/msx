import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { numberFrom, positionFrom, propsFrom } from "../../src/progress/samples.ts";

describe("numberFrom", () => {
  it("numbers and numeric strings", () => {
    assert.equal(numberFrom(12), 12);
    assert.equal(numberFrom("12.5"), 12.5);
    assert.equal(numberFrom(" 7 "), 7);
    assert.equal(numberFrom(-3), -3);
  });

  it("anything else is undefined", () => {
    for (const v of [undefined, null, "", "  ", "abc", "12px", NaN, Infinity, true, {}, [5]]) {
      assert.equal(numberFrom(v), undefined, String(v));
    }
  });
});

describe("positionFrom", () => {
  it("snapshot from a trigger: video.data.position", () => {
    assert.deepEqual(positionFrom({ video: { data: { position: 12 } } }), { position: 12 });
  });

  it("handleEvent: data.position as a string", () => {
    assert.deepEqual(positionFrom({ data: { position: "12.5" } }), { position: 12.5 });
  });

  it("bare position", () => {
    assert.deepEqual(positionFrom({ position: 12 }), { position: 12 });
  });

  it("empty payloads give nothing", () => {
    for (const p of [undefined, null, {}, "12", 12, { video: {} }, { data: null }]) {
      assert.deepEqual(positionFrom(p), {}, JSON.stringify(p));
    }
  });

  it("duration comes along, numbers or strings", () => {
    assert.deepEqual(positionFrom({ video: { info: {}, data: { position: "600", duration: "2700" } } }), { position: 600, duration: 2700 });
    assert.deepEqual(positionFrom({ data: { state: 1, position: 61.2, duration: 3720, ended: false } }), { position: 61.2, duration: 3720 });
  });

  it("video.data wins over data, data wins over the bare field", () => {
    assert.deepEqual(positionFrom({ video: { data: { position: 1 } }, data: { position: 2 }, position: 3 }), { position: 1 });
    assert.deepEqual(positionFrom({ data: { position: 2 }, position: 3 }), { position: 2 });
  });

  it("invalid or negative values are skipped in favour of the next source", () => {
    assert.deepEqual(positionFrom({ video: { data: { position: "abc" } }, data: { position: 40 } }), { position: 40 });
    assert.deepEqual(positionFrom({ data: { position: -1, duration: "" }, position: 5 }), { position: 5 });
    assert.deepEqual(positionFrom({ video: { data: { position: null, duration: 100 } } }), { duration: 100 });
  });
});

describe("propsFrom", () => {
  const props = { "kp:i": "2001", "kp:m": "2001004" };

  it("from video.info.properties (snapshot)", () => {
    assert.deepEqual(propsFrom({ video: { info: { url: "u", properties: props }, data: { position: 1 } } }), props);
  });

  it("from info.properties (handleEvent video:load)", () => {
    assert.deepEqual(propsFrom({ event: "video:load", info: { properties: props } }), props);
  });

  it("from data.info.properties", () => {
    assert.deepEqual(propsFrom({ data: { info: { properties: props } } }), props);
  });

  it("video.info wins over info", () => {
    assert.deepEqual(propsFrom({ video: { info: { properties: props } }, info: { properties: { "kp:i": "1" } } }), props);
  });

  it("no properties or not an object — undefined", () => {
    for (const p of [undefined, null, 5, "x", {}, { video: { info: {} } }, { info: { properties: "x" } }, { info: { properties: ["kp:i"] } }]) {
      assert.equal(propsFrom(p), undefined, JSON.stringify(p));
    }
  });
});
