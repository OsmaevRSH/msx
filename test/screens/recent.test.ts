import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KvStore } from "../../src/bridge/storage.ts";
import { RECENT_MAX, forgetQueries, recentQueries, rememberQuery } from "../../src/screens/recent.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";

function setup(): { mem: MemoryStorage; kv: KvStore } {
  const mem = new MemoryStorage();
  return { mem, kv: new KvStore(mem) };
}

describe("recent search queries (S7, kp.cfg.recent)", () => {
  it("empty storage — no queries", () => {
    assert.deepEqual(recentQueries(setup().kv), []);
  });

  it("the newest first, stored as kp.cfg.recent", () => {
    const { mem, kv } = setup();
    rememberQuery(kv, "матрица");
    rememberQuery(kv, "тест");
    assert.deepEqual(recentQueries(kv), ["тест", "матрица"]);
    assert.equal(mem.getItem("kp.cfg.recent"), JSON.stringify(["тест", "матрица"]));
  });

  it("a repeated query moves to the top without a duplicate", () => {
    const { kv } = setup();
    for (const q of ["а1", "б2", "в3", "а1"]) rememberQuery(kv, q);
    assert.deepEqual(recentQueries(kv), ["а1", "в3", "б2"]);
  });

  it("at most 6: the oldest falls off", () => {
    const { kv } = setup();
    assert.equal(RECENT_MAX, 6);
    for (let n = 1; n <= 8; n++) rememberQuery(kv, `запрос ${n}`);
    assert.deepEqual(recentQueries(kv), ["запрос 8", "запрос 7", "запрос 6", "запрос 5", "запрос 4", "запрос 3"]);
  });

  it("«Очистить историю» removes the key", () => {
    const { mem, kv } = setup();
    rememberQuery(kv, "тест");
    forgetQueries(kv);
    assert.deepEqual(recentQueries(kv), []);
    assert.equal(mem.getItem("kp.cfg.recent"), null);
  });

  it("blank, too long and non-string entries are ignored on read and write", () => {
    const { mem, kv } = setup();
    rememberQuery(kv, "  ");
    rememberQuery(kv, "я".repeat(33));
    assert.equal(mem.getItem("kp.cfg.recent"), null);
    mem.setItem("kp.cfg.recent", JSON.stringify(["тест", 5, "", null, "я".repeat(33), "фи"]));
    assert.deepEqual(recentQueries(kv), ["тест", "фи"]);
    mem.setItem("kp.cfg.recent", "{broken");
    assert.deepEqual(recentQueries(kv), []);
    mem.setItem("kp.cfg.recent", JSON.stringify({ q: "тест" }));
    assert.deepEqual(recentQueries(kv), []);
  });
});
