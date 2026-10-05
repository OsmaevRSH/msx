import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Metrics, stat } from "../../src/core/metrics.ts";

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("stat", () => {
  it("nearest-rank percentiles for 1..100", () => {
    assert.deepEqual(stat(range(1, 100)), { n: 100, p50: 50, p95: 95, min: 1, max: 100 });
  });

  it("does not depend on input order and does not mutate it", () => {
    const values = [5, 1, 4, 2, 3];
    assert.deepEqual(stat(values), { n: 5, p50: 3, p95: 5, min: 1, max: 5 });
    assert.deepEqual(values, [5, 1, 4, 2, 3]);
  });

  it("single value and empty input", () => {
    assert.deepEqual(stat([7]), { n: 1, p50: 7, p95: 7, min: 7, max: 7 });
    assert.deepEqual(stat([]), { n: 0, p50: 0, p95: 0, min: 0, max: 0 });
  });

  it("p95 of 20 values is the 19th", () => {
    assert.equal(stat(range(1, 20)).p95, 19);
  });
});

describe("Metrics", () => {
  it("record keeps the last 200 values per name", () => {
    const m = new Metrics();
    for (const v of range(1, 250)) m.record("api:/v1/items", v);
    m.record("ttff", 900);
    const s = m.summary();
    assert.deepEqual(s.values["api:/v1/items"], stat(range(51, 250)));
    assert.equal(s.values["api:/v1/items"]?.n, 200);
    assert.equal(s.values["api:/v1/items"]?.min, 51);
    assert.deepEqual(s.values.ttff, { n: 1, p50: 900, p95: 900, min: 900, max: 900 });
  });

  it("inc sums counters, by 1 by default", () => {
    const m = new Metrics();
    m.inc("429");
    m.inc("429");
    m.inc("outbox", 5);
    m.inc("outbox", -2);
    assert.deepEqual(m.summary().counters, { "429": 2, outbox: 3 });
  });

  it("ignores non-finite values", () => {
    const m = new Metrics();
    m.record("x", Number.NaN);
    m.record("x", Number.POSITIVE_INFINITY);
    m.record("x", 3);
    assert.equal(m.summary().values.x?.n, 1);
  });

  it("empty summary", () => {
    assert.deepEqual(new Metrics().summary(), { values: {}, counters: {} });
  });
});
