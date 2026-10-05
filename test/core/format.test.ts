import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fmtClock, fmtDate, fmtMinutes, fmtRemaining, fmtTime, ruTitle } from "../../src/core/format.ts";

describe("fmtClock", () => {
  it("h:mm:ss from an hour, m:ss below", () => {
    assert.equal(fmtClock(3735), "1:02:15");
    assert.equal(fmtClock(59), "0:59");
    assert.equal(fmtClock(0), "0:00");
    assert.equal(fmtClock(600), "10:00");
    assert.equal(fmtClock(3600), "1:00:00");
    assert.equal(fmtClock(1200), "20:00");
  });

  it("drops fractions and clamps invalid input to zero", () => {
    assert.equal(fmtClock(61.9), "1:01");
    assert.equal(fmtClock(-5), "0:00");
    assert.equal(fmtClock(Number.NaN), "0:00");
  });
});

describe("fmtMinutes / fmtRemaining", () => {
  it("minutes below an hour, hours with zero-padded minutes above", () => {
    assert.equal(fmtMinutes(2820), "47 мин");
    assert.equal(fmtMinutes(7260), "2 ч 01 мин");
    assert.equal(fmtMinutes(3600), "1 ч 00 мин");
    assert.equal(fmtMinutes(5400), "1 ч 30 мин");
  });

  it("rounds to whole minutes; anything positive is at least 1 minute", () => {
    assert.equal(fmtMinutes(89), "1 мин");
    assert.equal(fmtMinutes(91), "2 мин");
    assert.equal(fmtMinutes(10), "1 мин");
    assert.equal(fmtMinutes(0), "0 мин");
    assert.equal(fmtMinutes(-30), "0 мин");
  });

  it("fmtRemaining prefixes «осталось»", () => {
    assert.equal(fmtRemaining(2820), "осталось 47 мин");
    assert.equal(fmtRemaining(7260), "осталось 2 ч 01 мин");
  });
});

describe("fmtDate", () => {
  it("formats Unix seconds as DD.MM.YYYY", () => {
    assert.match(fmtDate(0), /^\d{2}\.\d{2}\.\d{4}$/);
    const d = new Date(2026, 2, 7, 12, 0, 0);
    assert.equal(fmtDate(d.getTime() / 1000), "07.03.2026");
  });
});

describe("fmtTime", () => {
  it("formats epoch milliseconds as local HH:MM", () => {
    assert.equal(fmtTime(new Date(2026, 2, 7, 9, 5, 59).getTime()), "09:05");
    assert.equal(fmtTime(new Date(2026, 2, 7, 23, 40).getTime()), "23:40");
  });
});

describe("ruTitle", () => {
  it("takes the part before « / »", () => {
    assert.equal(ruTitle("Черное зеркало / Black Mirror"), "Черное зеркало");
    assert.equal(ruTitle("Тестовый фильм 1000 / Test Movie 1000"), "Тестовый фильм 1000");
  });

  it("returns the whole title when there is no separator", () => {
    assert.equal(ruTitle("Брат"), "Брат");
    assert.equal(ruTitle("AC/DC: Live"), "AC/DC: Live");
    assert.equal(ruTitle("  Пробелы  "), "Пробелы");
  });
});
