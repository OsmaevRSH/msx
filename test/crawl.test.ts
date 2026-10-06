import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crawl } from "../tools/crawl.ts";
import {
  actionIssues, addressIssues, answerIssues, contextIssues, expandContext, placeholderIssues, sizeLimit, splitChain,
} from "../tools/crawl-rules.ts";
import { TEST_P } from "./helpers/harness.ts";

// Краулер графа действий (этап 32, спец. §14.1): правила на заведомо плохих ответах и обход от init через kpmock.

const P = TEST_P;
const req = (id: string): string => `request:interaction:${id}@${P}`;

describe("crawl rules", () => {
  it("unexpanded {…}: MSX keywords pass, anything else is reported", () => {
    const ok = {
      headline: "{ico:msx-white:access-time} {now:time:hh:mm}",
      text: "{txt:msx-gray:1080p}{br}{col:msx-red}x{tb}{dic:key|y}{pipe}",
      live: { titleFooter: "{progress:time:hh:mm:ss}" },
      template: { selection: { action: "interaction:commit:message:pf:{context:kid}" } },
    };
    assert.deepEqual(placeholderIssues(ok), []);
    assert.deepEqual(placeholderIssues({ items: [{ title: "Сезон {n}" }, { label: "{ico}x{undefined}" }] }), [
      "items[0].title: {n}", "items[1].label: {ico}", "items[1].label: {undefined}",
    ]);
  });

  it("every @ address is the plugin address P", () => {
    assert.deepEqual(addressIssues({ action: `content:${req("home")}` }, P), []);
    assert.deepEqual(addressIssues({ a: "content:request:interaction:home@http://127.0.0.1:8080/app/index.html" }, P), [
      "a: home@http://127.0.0.1:8080/app/index.html",
    ]);
    assert.deepEqual(addressIssues({ a: "info:пишите на me@example.com" }, P), [], "only request:interaction addresses count");
    assert.deepEqual(addressIssues({ a: [`[back|content:request:interaction:item:1@${P}/]`] }, P), [`a[0]: item:1@${P}/`]);
  });

  it("actions: known MSX forms only, chains without nesting, no reload:menu, bare request only as menu data", () => {
    for (const a of [
      "back", "[]", "reload:content", "reload:panel", "[invalidate:content|reload:content]", "info:Готово",
      `content:${req("home")}`, `panel:${req("panel:sort:x")}`, `video:resolve:${req("play:1:start")}`,
      `replace:content:list_1a2b3c4d:${req("list:x")}`, `replace:menu:menu:${req("init")}`,
      "interaction:commit:message:act:item:refresh:1", "interaction:commit:video", "shot:interaction:commit:video",
      "[interaction:commit:video|player:eject]", "player:button:next:execute", "player:ticking:restart",
      "player:commit:message:subs:off",
    ]) assert.deepEqual(actionIssues(a), [], a);
    assert.deepEqual(actionIssues("reload:menu"), ["reload:menu: unknown action"]);
    assert.deepEqual(actionIssues(req("home")), [`${req("home")}: unknown action`]);
    assert.deepEqual(actionIssues("[back|[info:x]]"), ["[back|[info:x]]: nested chain"]);
    assert.deepEqual(actionIssues("[back|]"), ["[back|]: empty member"]);
    assert.deepEqual(actionIssues(`content:request:interaction:@${P}`), [`content:request:interaction:@${P}: empty dataId`]);
    assert.deepEqual(actionIssues(""), [": empty action"]);
    assert.deepEqual(splitChain("[a|b]"), ["a", "b"]);
    assert.deepEqual(splitChain("[]"), []);
    assert.deepEqual(splitChain("a"), ["a"]);
  });

  it("{context:…}: only in template.selection.action and template.properties, item fields are strings", () => {
    const good = {
      template: { selection: { action: "interaction:commit:message:pf:{context:kid}" }, properties: { "kp:i": "{context:kid}" } },
      items: [{ kid: "1" }, { kid: "2" }],
    };
    assert.deepEqual(contextIssues(good), []);
    assert.deepEqual(expandContext("pf:{context:kid}", { kid: "7" }), "pf:7");
    assert.deepEqual(contextIssues({
      template: { action: "content:{context:kid}", selection: { action: "pf:{context:kid}" } },
      items: [{ kid: 1 }, { title: "{context:kid}" }],
    }), [
      "template.action: {context:…} outside template.selection.action and template.properties",
      "items[1].title: {context:…} outside template.selection.action and template.properties",
      "items[0].kid: {context:kid} needs a string field, got number",
      "items[1].kid: {context:kid} needs a string field, got undefined",
    ]);
  });

  it("answers: markup by route, list window, resolve shape, size limits by screen", () => {
    assert.deepEqual(answerIssues("home", { type: "list", items: [{ label: "x" }] }).map((i) => i.rule), ["markup"]);
    assert.deepEqual(answerIssues("init", { menu: [] }).map((i) => i.rule), ["markup", "markup"]);
    assert.deepEqual(answerIssues("play:1:start", { url: "http://x/a.m3u8", properties: { "kp:i": "1" } }), []);
    assert.deepEqual(answerIssues("play:1:start", { error: "Не удалось" }), []);
    assert.deepEqual(answerIssues("play:1:start", { properties: { n: 1 } }).map((i) => i.detail), [
      "resolve: neither url nor error", "resolve: property n is number",
    ]);
    const tiles = Array.from({ length: 97 }, (_, i) => ({ id: `i${i}` }));
    assert.deepEqual(answerIssues("list:Y2F0YWxvZw", { type: "list", template: {}, items: tiles }).map((i) => i.rule), ["window"]);
    assert.deepEqual(answerIssues("search", { type: "list", template: {}, items: tiles }).map((i) => i.rule), ["window"]);
    assert.deepEqual(answerIssues("home", null).map((i) => i.rule), ["json"]);
    assert.deepEqual(answerIssues("home", [1]).map((i) => i.rule), ["json"]);
    assert.equal(sizeLimit("item:1"), 20 * 1024);
    assert.equal(sizeLimit("list:x"), 32 * 1024);
    assert.equal(sizeLimit("season:1:1"), 32 * 1024);
    assert.equal(sizeLimit("search"), 32 * 1024);
    assert.equal(sizeLimit("init"), 6 * 1024);
    assert.equal(sizeLimit("panel:audio:1:2:c"), 16 * 1024);
    assert.equal(sizeLimit("play:1:start"), 6 * 1024);
  });
});

describe("crawl: the action graph from init through kpmock (§14.1, CNFR-16, CD-16)", () => {
  it("visits at least 60 nodes and finds no failures", { timeout: 300_000 }, async () => {
    const r = await crawl();
    assert.deepEqual(r.failures, []);
    assert.ok(r.nodes >= 60, `nodes: ${r.nodes}`);
    for (const k of ["init", "home", "search", "item", "season", "play", "list:catalog", "panel:audio", "settings", "probe:"]) {
      assert.ok(r.maxBytes[k] !== undefined, `${k} not crawled: ${Object.keys(r.maxBytes).join(" ")}`);
    }
    assert.ok((r.maxBytes["item"] ?? 0) <= 20 * 1024);
  });

  it("player properties in the season template ({context:…}, CDG-06) crawl without failures", { timeout: 300_000 }, async () => {
    const r = await crawl({ maxNodes: 120, flags: { playerPropsIn: "item" } });
    assert.deepEqual(r.failures, []);
    assert.ok(r.maxBytes["season"] !== undefined && r.maxBytes["playEp"] !== undefined, Object.keys(r.maxBytes).join(" "));
  });
});
