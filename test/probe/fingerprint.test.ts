import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeSchema, schemaOf } from "../../src/probe/fingerprint.ts";

describe("schemaOf: path → type without values (spec §13, decision R-29)", () => {
  it("merges array element types: {a:[{b:1},{b:'2'}]} → a[].b number|string", () => {
    assert.deepEqual(schemaOf({ a: [{ b: 1 }, { b: "2" }] }), { "a[].b": "number|string" });
  });

  it("nested objects, primitive arrays, null and boolean", () => {
    assert.deepEqual(schemaOf({ x: { y: true, z: null }, tags: ["a", "b"], n: 1 }), {
      "x.y": "boolean", "x.z": "null", "tags[]": "string", n: "number",
    });
  });

  it("empty containers keep a marker, root primitive gets $", () => {
    assert.deepEqual(schemaOf({ list: [], obj: {} }), { list: "[]", obj: "{}" });
    assert.deepEqual(schemaOf(5), { $: "number" });
  });

  it("prefix is prepended to every path", () => {
    assert.deepEqual(schemaOf({ a: 1, b: [{ c: "x" }] }, "item"), { "item.a": "number", "item.b[].c": "string" });
    assert.deepEqual(schemaOf([1, "s"], "arr"), { "arr[]": "number|string" });
  });

  it("numeric keys (maps by id) collapse into {id}: ids are values too", () => {
    assert.deepEqual(schemaOf({ byId: { "1001": { t: "x" }, "1002": { t: 2 } } }), { "byId.{id}.t": "number|string" });
  });

  it("stores no values: strings, numbers and tokens never appear", () => {
    const json = { status: 200, user: { username: "tester", profile: { name: "Тестер" }, token: "mock-at-5", days: 30 } };
    const text = JSON.stringify(schemaOf(json));
    for (const v of ["tester", "Тестер", "mock-at-5", "30", "200"]) assert.ok(!text.includes(v), v);
  });
});

describe("mergeSchema", () => {
  it("unions types per path, sorted and without duplicates", () => {
    assert.deepEqual(
      mergeSchema({ a: "number", b: "string", c: "null|string" }, { a: "string", c: "string", d: "boolean" }),
      { a: "number|string", b: "string", c: "null|string", d: "boolean" },
    );
  });

  it("does not modify its arguments", () => {
    const a = { x: "number" };
    const b = { x: "string" };
    mergeSchema(a, b);
    assert.deepEqual(a, { x: "number" });
    assert.deepEqual(b, { x: "string" });
  });
});
