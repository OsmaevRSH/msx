import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crawl } from "../tools/crawl.ts";
import {
  actionIssues, addressIssues, answerIssues, contextIssues, edgeIssues, expandContext, placeholderIssues, sizeLimit, splitChain,
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
      "player:commit:message:subs:off", "player:seek:-10", "player:seek:+30",
      // X-3: меню после входа и выхода — `home`, `cleanup`, затем `replace:menu` после анимации.
      `[home|cleanup|lazy:replace:menu:menu:${req("init")}|info:Готово]`,
      // Страж края (src/msx/edges.ts): фокус обратно на плитку — внутреннее действие MSX.
      "focus:i1001", "focus:k3_1",
      // Эфир канала «Спорт» (v1.11): адрес потока прямо, без resolve и `kp:*`.
      "video:https://cdn.example/tv/sport1/playlist.m3u8?t=1",
      // «Пункты меню» (v1.11): меню и панель перерисовываются вместе.
      `[replace:menu:menu:${req("init")}|reload:panel]`,
      // Системные настройки MSX строкой «Настройки» (v1.16): действие MSX без плагина.
      "settings",
    ]) assert.deepEqual(actionIssues(a), [], a);
    // Только сами настройки MSX: отдельные их пункты (`settings:reset`, `settings:start`) плагин не открывает.
    assert.deepEqual(actionIssues("settings:reset"), ["settings:reset: unknown action"]);
    assert.deepEqual(actionIssues("video:file:///etc/x"), ["video:file:///etc/x: unknown action"]);
    assert.deepEqual(actionIssues("lazy:reload:menu"), ["lazy:reload:menu: unknown action"]);
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

  it("{context:…}: only in template.selection (action, headline, text), template.properties and template.options, item fields are strings", () => {
    const good = {
      template: {
        selection: { action: "interaction:commit:message:pf:{context:kid}", headline: "{context:kname}", text: "{context:kid}" },
        properties: { "kp:i": "{context:kid}" },
        // v1.17: опции плитки в фокусе (действия над плиткой).
        options: { headline: "{context:kname}", items: [{ action: "[back|interaction:commit:message:act:tile:del:{context:kid}]" }] },
      },
      items: [{ kid: "1", kname: "Один" }, { kid: "2", kname: "" }],
    };
    assert.deepEqual(contextIssues(good), []);
    assert.deepEqual(expandContext("pf:{context:kid}", { kid: "7" }), "pf:7");
    const where = "{context:…} outside template.selection (action, headline, text), template.properties and template.options";
    assert.deepEqual(contextIssues({
      template: { action: "content:{context:kid}", selection: { action: "pf:{context:kid}", headline: "{context:kname}", label: "{context:kid}" } },
      items: [{ kid: 1, kname: "А" }, { title: "{context:kid}" }],
    }), [
      `template.action: ${where}`,
      `template.selection.label: ${where}`,
      `items[1].title: ${where}`,
      "items[0].kid: {context:kid} needs a string field, got number",
      "items[1].kid: {context:kid} needs a string field, got undefined",
      "items[1].kname: {context:kname} needs a string field, got undefined",
    ]);
  });

  it("edge guards: focus targets exist and are not guards; inserts need template and items, a context insert — its break", () => {
    const guard = (target: string) => ({ layout: "0,0,2,1", selection: { action: `focus:${target}` } });
    const ok = {
      template: { layout: "0,0,2,4" }, items: [{ id: "i1" }, { id: "i2", break: "context:end" }],
      inserts: [{ position: "page:0", items: [guard("i1")] }, { position: "context:end", items: [guard("i2")] }],
    };
    assert.deepEqual(edgeIssues(ok, "list:x"), []);
    assert.deepEqual(edgeIssues({ pages: [{ items: [{ id: "a" }, guard("a"), guard("b")] }] }, "home"), ["home: ? → focus:b — нет такого элемента"]);
    assert.deepEqual(edgeIssues({ pages: [{ items: [{ id: "g", ...guard("a") }, { id: "a", ...guard("g") }] }] }, "x"), [
      "x: g → focus:a — цель сама страж", "x: a → focus:g — цель сама страж",
    ]);
    assert.deepEqual(edgeIssues({ ...ok, items: [{ id: "i1" }, { id: "i2" }] }, "list:x"), ["list:x: вставка context:end без разрыва у элемента"]);
    assert.deepEqual(edgeIssues({ inserts: ok.inserts, pages: [{ items: [{ id: "i1" }, { id: "i2" }] }] }, "list:x"), [
      "list:x: inserts без template и items — MSX их не покажет", "list:x: вставка context:end без разрыва у элемента",
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
    assert.equal(sizeLimit("search", { type: "list", template: {}, items: tiles }), 32 * 1024);
    assert.equal(sizeLimit("search", { type: "list", pages: [{ items: [] }] }), 8 * 1024, "the keyboard alone is redrawn on every key");
    assert.equal(sizeLimit("init"), 6 * 1024);
    assert.equal(sizeLimit("panel:audio:1:2:c"), 16 * 1024);
    assert.equal(sizeLimit("play:1:start"), 6 * 1024);
  });
});

describe("crawl: the action graph from init through kpmock (§14.1, CNFR-16, CD-16)", () => {
  it("visits at least 60 nodes and finds no failures", { timeout: 300_000 }, async () => {
    const trace: string[] = [];
    const r = await crawl({ trace: (line) => trace.push(line) });
    assert.deepEqual(r.failures, []);
    // v1.16: «Диагностики» в меню нет — обход доходит до неё из «Настроек», со входом и без.
    // Строка обхода — «<глубина> <in|out> <узел> ← <откуда>»; перезапросы («(reload)») не в счёт.
    const via = (auth: string, id: string): string[] =>
      trace.flatMap((l) => (l.startsWith(`${l.split(" ")[0]} ${auth} ${id} ← `) ? [l.split(" ← ")[1] ?? ""] : []));
    assert.deepEqual(via("in", "probe"), ["settings"]);
    // Без входа: «Настройки» — из гостевого меню, «Диагностика» — первой из экрана входа (его кнопка) или из «Настроек».
    assert.deepEqual(via("out", "settings"), ["init"]);
    assert.equal(via("out", "probe").filter((v) => v === "login" || v === "settings").length, 1);
    assert.ok(r.nodes >= 60, `nodes: ${r.nodes}`);
    for (const k of [
      "init", "home", "search", "item", "season", "play", "list:catalog", "panel:audio", "settings", "probe:",
      // v1.11: «Я смотрю», «Спорт», «Новинки», «История», подборки и их содержимое, «Пункты меню».
      "watching", "tv", "list:fresh", "list:history", "list:collections", "list:collection", "panel:menu",
      // v1.13: «Секции главной» — из настроек и красной кнопкой главной.
      "panel:home",
      // v1.14: панель вкладок полки и вкладка, выбранная в ней (не из «Показать все» главной).
      "panel:type", "list:fresh:documovie",
      // v1.17: папка с опциями плиток и подтверждение «Очистить всю историю» (спец. §11.4).
      "list:folder", "panel:tile",
    ]) {
      assert.ok(r.maxBytes[k] !== undefined, `${k} not crawled: ${Object.keys(r.maxBytes).join(" ")}`);
    }
    // Действия над плиткой найдены в опциях и проверены как действия, но не отправлены: обход не удаляет данные.
    const kinds = new Set(r.skipped.map((m) => m.split(":").slice(0, 3).join(":")));
    assert.deepEqual([...kinds].sort(), ["act:tile:clear", "act:tile:del", "act:tile:unfold", "act:tile:unwatch"]);
    assert.ok((r.maxBytes["item"] ?? 0) <= 20 * 1024);
  });

  it("player properties in the season template ({context:…}, CDG-06) crawl without failures", { timeout: 300_000 }, async () => {
    const r = await crawl({ maxNodes: 120, flags: { playerPropsIn: "item" } });
    assert.deepEqual(r.failures, []);
    assert.ok(r.maxBytes["season"] !== undefined && r.maxBytes["playEp"] !== undefined, Object.keys(r.maxBytes).join(" "));
  });
});
