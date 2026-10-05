import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { b64urlDecode } from "../../src/core/b64url.ts";
import { fnv1a } from "../../src/core/hash.ts";
import { decodeListKey, encodeListKey, ids, listFlag, msgs, parseDataId, parseMessage } from "../../src/router/ids.ts";
import type { ListKey, Msg, Route } from "../../src/router/ids.ts";

describe("parseDataId: round trip of every route (§0.6.7)", () => {
  const key = encodeListKey({ src: "catalog", type: "movie", sort: "-updated" });
  const cases: [string, Route][] = [
    [ids.init(), { k: "init" }],
    [ids.login(), { k: "login" }],
    [ids.home(), { k: "home" }],
    [ids.list(key), { k: "list", key }],
    [ids.search(), { k: "search" }],
    [ids.item(2001), { k: "item", id: 2001 }],
    [ids.season(2001, 3), { k: "season", id: 2001, n: 3 }],
    [ids.panel("audio", 2004, 2004001, "p"), { k: "panel", type: "audio", args: ["2004", "2004001", "p"] }],
    [ids.panel("loc"), { k: "panel", type: "loc", args: [] }],
    [ids.panel("sort", key), { k: "panel", type: "sort", args: [key] }],
    [ids.settings(), { k: "settings" }],
    [ids.bookmarks(), { k: "bookmarks" }],
    [ids.dev(), { k: "dev" }],
    [ids.probe(), { k: "probe" }],
    [ids.probe("report:2"), { k: "probe", page: "report:2" }],
    [ids.playContinue(2001), { k: "play", id: 2001, what: "continue" }],
    [ids.playStart(2006), { k: "play", id: 2006, what: "start" }],
    [ids.playEp(2001, 2001004, 1, 4), { k: "playEp", id: 2001, mid: 2001004, s: 1, e: 4, start: false }],
    [ids.playEp(2006, 2006001, 0, 1, { start: true }), { k: "playEp", id: 2006, mid: 2006001, s: 0, e: 1, start: true }],
    [ids.playEp(2001, 2001004, 1, 4, { at: 597 }), { k: "playEp", id: 2001, mid: 2001004, s: 1, e: 4, start: false, at: 597 }],
    [ids.probePlay("a2", 2001, 2001001, 1, 1), { k: "probePlay", variant: "a2", id: 2001, mid: 2001001, s: 1, e: 1 }],
  ];
  for (const [dataId, route] of cases) {
    it(dataId, () => {
      assert.deepEqual(parseDataId(dataId), route);
    });
  }

  it("builds the exact strings of the grammar", () => {
    assert.equal(ids.item(7), "item:7");
    assert.equal(ids.season(7, 2), "season:7:2");
    assert.equal(ids.panel("audio", 7, 70, "c"), "panel:audio:7:70:c");
    assert.equal(ids.probe("report:1"), "probe:report:1");
    assert.equal(ids.playContinue(7), "play:7:continue");
    assert.equal(ids.playStart(7), "play:7:start");
    assert.equal(ids.playEp(7, 70, 1, 2), "play:7:70:1:2");
    assert.equal(ids.playEp(7, 70, 1, 2, { start: true }), "play:7:70:1:2:start");
    assert.equal(ids.playEp(7, 70, 1, 2, { at: 321.7 }), "play:7:70:1:2:at321");
    assert.equal(ids.probePlay("ticks", 7, 70, 1, 2), "play:probe:ticks:7:70:1:2");
  });

  it("play:2001:2001004:1:4:at597 → at: 597", () => {
    assert.deepEqual(parseDataId("play:2001:2001004:1:4:at597"), { k: "playEp", id: 2001, mid: 2001004, s: 1, e: 4, start: false, at: 597 });
  });

  it("play:probe:<variant>:… for every variant", () => {
    for (const variant of ["a1", "a2", "hls2", "props", "ticks", "autonext"] as const) {
      assert.deepEqual(parseDataId(`play:probe:${variant}:2001:2001020:1:20`), { k: "probePlay", variant, id: 2001, mid: 2001020, s: 1, e: 20 });
    }
  });

  it("unknown and malformed ids → unknown", () => {
    for (const raw of [
      "", "nope", "item:", "item:abc", "item:-1", "item:0", "item:1:2", "season:1", "season:1:x", "list:", "panel:",
      "play:1", "play:1:later", "play:x:continue", "play:1:2:3", "play:1:2:1:4:at", "play:1:2:1:4:atx", "play:1:2:1:4:end",
      "play:probe:zz:1:2:1:1", "play:probe:a1:1:2:1", "home:1", "init:x", "settings:1",
    ]) {
      assert.deepEqual(parseDataId(raw), { k: "unknown", raw }, raw);
    }
  });
});

describe("parseMessage: round trip of every message (§0.6.7)", () => {
  const key = encodeListKey({ src: "fresh", type: "serial" });
  const cases: [string, Msg][] = [
    [msgs.extend(key), { k: "extend", key }],
    [msgs.extend("search"), { k: "extend", key: "search" }],
    [msgs.searchInput("ж"), { k: "searchInput", ch: "ж" }],
    [msgs.searchInput("1"), { k: "searchInput", ch: "1" }],
    [msgs.searchControl("back"), { k: "searchControl", c: "back" }],
    [msgs.searchControl("clear"), { k: "searchControl", c: "clear" }],
    [msgs.searchControl("space"), { k: "searchControl", c: "space" }],
    [msgs.searchControl("lang"), { k: "searchControl", c: "lang" }],
    [msgs.pf(1001), { k: "pf", id: 1001 }],
    [msgs.act("item", "watched", 1, 0, 1, 1), { k: "act", module: "item", name: "watched", args: ["1", "0", "1", "1"] }],
    [msgs.act("login", "new"), { k: "act", module: "login", name: "new", args: [] }],
    [msgs.act("panel", "audio", 2004, 2004001, 7, "c"), { k: "act", module: "panel", name: "audio", args: ["2004", "2004001", "7", "c"] }],
    [msgs.act("set", "quality", 720), { k: "act", module: "set", name: "quality", args: ["720"] }],
    [msgs.act("probe", "run", "CDG-01"), { k: "act", module: "probe", name: "run", args: ["CDG-01"] }],
  ];
  for (const [m, msg] of cases) {
    it(m, () => {
      assert.deepEqual(parseMessage(m), msg);
    });
  }

  it("builds the exact strings of the grammar", () => {
    assert.equal(msgs.extend("abc"), "extend:abc");
    assert.equal(msgs.searchInput("а"), "search:input:а");
    assert.equal(msgs.searchControl("clear"), "search:control:clear");
    assert.equal(msgs.pf("{context:kid}"), "pf:{context:kid}");
    assert.equal(msgs.act("item", "watched", 1, 0, 1, 1), "act:item:watched:1:0:1:1");
  });

  it("search input keeps a space", () => {
    assert.deepEqual(parseMessage("search:input: "), { k: "searchInput", ch: " " });
  });

  it("unknown and malformed messages → unknown", () => {
    for (const raw of [
      "", "hello", "extend:", "search:input:", "search:control:up", "pf:", "pf:abc", "pf:{context:kid}", "pf:0",
      "act:", "act:item", "act:item:", "act:other:x", "watched",
    ]) {
      assert.deepEqual(parseMessage(raw), { k: "unknown", raw }, raw);
    }
  });
});

describe("ListKey", () => {
  it("encodes only set fields in the fixed order as base64url", () => {
    const s = encodeListKey({ id: 5, genre: "23", src: "catalog", sort: "-updated", type: "movie,serial" });
    assert.match(s, /^[A-Za-z0-9_-]+$/);
    assert.equal(b64urlDecode(s), "catalog|type=movie,serial|sort=-updated|genre=23|id=5");
    assert.equal(b64urlDecode(encodeListKey({ src: "folder", folder: 12 })), "folder|folder=12");
  });

  it("round trips every source, including Cyrillic values", () => {
    const keys: ListKey[] = [
      { src: "catalog", type: "movie", sort: "-updated" },
      { src: "catalog", type: "movie,serial", sort: "-updated", genre: "23" },
      { src: "fresh", type: "serial" },
      { src: "popular", type: "movie" },
      { src: "hot" },
      { src: "folder", folder: 7 },
      { src: "similar", id: 2001 },
      { src: "catalog", sort: "-year", genre: "Комедия ёж" },
    ];
    for (const k of keys) assert.deepEqual(decodeListKey(encodeListKey(k)), k);
  });

  it("rejects a value with the field separator and malformed keys", () => {
    assert.throws(() => encodeListKey({ src: "catalog", genre: "a|b" }));
    const raw = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
    assert.throws(() => decodeListKey("%%%"));
    assert.throws(() => decodeListKey(raw("nope")));
    assert.throws(() => decodeListKey(raw("folder|folder=x")));
    assert.throws(() => decodeListKey(raw("catalog|color=red")));
  });

  it("listFlag = list_ + fnv1a(key)", () => {
    const key = encodeListKey({ src: "catalog", type: "movie", sort: "-updated" });
    assert.equal(listFlag(key), `list_${fnv1a(key)}`);
    assert.match(listFlag(key), /^list_[0-9a-f]{8}$/);
  });
});
