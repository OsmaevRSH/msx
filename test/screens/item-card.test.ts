import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MsxResolveResponse } from "../../src/msx/types.ts";
import { cacheKeys } from "../../src/cache/repo.ts";
import { commitMsg, contentAction, resolveAction } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { ids, msgs, parseDataId } from "../../src/router/ids.ts";
import { itemHash, onItemAct } from "../../src/screens/item.ts";
import { FIX, castOf, directorOf, findItem } from "../../tools/kpmock/fixtures.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

// Карточка v1.19 (пакет «Карточка»): «Буду смотреть», трейлер, актёры и режиссёр, статус сериала, «просмотрено N из M»,
// озвучки; тексты укладываются в строки сетки 1920×1080 (9 строк под заголовком на три ряда, 12 — на четыре).

const BIG = FIX.SERIAL_BIG;
const P = "https://example.github.io/msx/app/index.html";
/** Знаков в строке при 1920×1080 с запасом (LINE и CPL в item.ts; замер скриншотом web MSX — 82–87): факты и сюжет. */
const LINE = 80;
const CPL = 70;

let apps: TestApp[] = [];
afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(): Promise<TestApp> {
  const t = await createTestApp({ loggedIn: true });
  apps.push(t);
  return t;
}

const open = async (t: TestApp, id: number): Promise<MsxContentRoot> => (await t.request(ids.item(id))) as MsxContentRoot;
const items = (s: MsxContentRoot): MsxContentItem[] => s.pages?.[0]?.items ?? [];
const el = (s: MsxContentRoot, id: string): MsxContentItem | undefined => items(s).find((i) => i.id === id);
const about = (s: MsxContentRoot): MsxContentItem => items(s).find((i) => i.type === "space" && i.headline !== undefined)!;
const lines = (s: MsxContentRoot): string[] => (about(s).text ?? "").split("{br}");
const options = (s: MsxContentRoot): { label?: string; action?: string }[] => (s.options?.items ?? []).map((i) => ({ label: i.label, action: i.action }));
const calls = (t: TestApp, path: string): number => t.mock.calls().filter((c) => c.path === path).length;
/** Строк, которые займёт текст: факты — по `LINE`, сюжет (последний, с переносом по словам) — по `CPL`. */
const rowsOf = (s: MsxContentRoot): number =>
  lines(s).reduce((n, l, i, all) => n + Math.max(1, Math.ceil(l.length / (i === all.length - 1 ? CPL : LINE))), 0);

describe("card v1.19: secondary row — trailer and «Буду смотреть»", () => {
  it("serial in the list: «Трейлер» and «✓ В списке» above «▶»; the text takes three rows", async () => {
    const t = await make();
    const s = await open(t, BIG);
    const tr = el(s, "b_trailer");
    assert.equal(tr?.layout, "3,3,2,1");
    assert.equal(tr?.label, "{ico:movie} Трейлер");
    assert.equal(tr?.action, resolveAction(P, "play:2001:trailer"));
    const wl = el(s, "b_wl");
    assert.equal(wl?.layout, "5,3,3,1");
    assert.equal(wl?.label, "✓ В списке");
    assert.equal(wl?.action, commitMsg(msgs.act("item", "wl", BIG, 0)));
    assert.equal(about(s).layout, "3,0,9,3");
    assert.equal(el(s, "b_main")?.focus, true);
  });

  it("an unsubscribed serial: «★ Буду смотреть»; a film never has the watchlist button", async () => {
    const t = await make();
    t.mock.state.watchlist.set(BIG, false);
    assert.equal(el(await open(t, BIG), "b_wl")?.label, "★ Буду смотреть");
    assert.equal(el(await open(t, BIG), "b_wl")?.action, commitMsg(msgs.act("item", "wl", BIG, 1)));
    const film = await open(t, FIX.MOVIE_SIMPLE);
    assert.equal(el(film, "b_wl"), undefined);
    assert.equal(el(film, "b_trailer")?.layout, "3,3,2,1");
  });

  it("no trailer and not a serial: no secondary row, the text keeps four rows", async () => {
    const t = await make();
    const s = await open(t, FIX.MOVIE_MULTI);
    assert.equal(el(s, "b_trailer"), undefined);
    assert.equal(el(s, "b_wl"), undefined);
    assert.equal(about(s).layout, "3,0,9,4");
  });
});

describe("card v1.19: facts in the middle", () => {
  it("serial: «Выходит», «просмотрено 3 из 200», director, cast (4–6 names in one line), voice-overs", async () => {
    const t = await make();
    const s = await open(t, BIG);
    const [head, facts, director, cast, voices, blank] = lines(s);
    assert.match(head ?? "", /^\d{4} · /);
    assert.match(facts ?? "", /^КП \d,\d · IMDb \d,\d · \d+ мин · Выходит · просмотрено 3 из 200$/);
    const big = findItem(BIG)!;
    assert.equal(director, `Режиссёр: ${directorOf(big).join(", ")}`);
    assert.ok(cast?.startsWith(`В ролях: ${castOf(big).slice(0, 4).join(", ")}`), cast);
    const shown = (cast ?? "").slice("В ролях: ".length).split(", ");
    assert.ok(shown.length >= 4 && shown.length <= 6, cast);
    assert.ok((cast ?? "").length <= LINE, cast);
    assert.equal(voices, "Озвучки: Студия Бета");
    assert.equal(blank, "");
    assert.match(lines(s)[6] ?? "", /^Синтетическое описание тайтла 2001/);
  });

  it("a finished serial says «Завершён»; a film has no status and no «просмотрено»", async () => {
    const t = await make();
    const small = await open(t, FIX.SERIAL_SMALL);
    assert.match(lines(small)[1] ?? "", / · Завершён · просмотрено 1 из 6$/);
    const film = await open(t, FIX.MOVIE_SIMPLE);
    assert.doesNotMatch(lines(film)[1] ?? "", /Выходит|Завершён|просмотрено/);
  });

  it("voice-overs: three studios and «и ещё N»; without `voice` — the studios of the unit", async () => {
    const t = await make();
    assert.ok(lines(await open(t, FIX.MOVIE_AUDIO12)).includes("Озвучки: Студия Альфа, Студия Бета, Студия Гамма и ещё 2"));
    // У нечётных id mock нет студий в `voice` (null): озвучка — тип дорожки единицы «Продолжить».
    assert.ok(lines(await open(t, 1001)).includes("Озвучки: Дубляж"));
  });

  it("CNFR: the text never needs more rows than the grid gives — the plot is clipped to what is left", async () => {
    const t = await make();
    for (const id of [BIG, FIX.MOVIE_MULTI, FIX.MOVIE_AUDIO12]) {
      const got = await t.run(t.ctx.repo.item(id));
      got.value.plot = "Длинное описание. ".repeat(80);
      got.value.cast = ["Очень Длинноеимя Актёрамаксимальное", "Вторая Длиннаяфамилия", "Третья Фамилия", "Четвёртая", "Пятая", "Шестая", "Седьмая"];
      const s = await open(t, id);
      const rows = Number(about(s).layout?.split(",")[3]);
      assert.ok(rowsOf(s) <= rows * 3, `${id}: ${rowsOf(s)} lines in ${rows} rows`);
      assert.match(lines(s).at(-1) ?? "", /…$/, "the plot is clipped, not cut by MSX");
    }
  });
});

describe("card v1.19: options — search by director and cast", () => {
  it("director rows, then up to 6 cast rows → the person list; playback and refresh stay last", async () => {
    const t = await make();
    const s = await open(t, BIG);
    const big = findItem(BIG)!;
    const rows = options(s);
    const people = rows.filter((r) => r.label?.startsWith("{ico:search}"));
    assert.deepEqual(people.map((r) => r.label), [
      ...directorOf(big).map((n) => `{ico:search} Режиссёр: ${n}`), ...castOf(big).slice(0, 6).map((n) => `{ico:search} В ролях: ${n}`),
    ]);
    assert.equal(people[0]?.action, contentAction(P, ids.person("director", directorOf(big)[0]!)));
    assert.equal(people[1]?.action, contentAction(P, ids.person("cast", castOf(big)[0]!)));
    assert.deepEqual(rows.slice(-2).map((r) => r.label), ["Способ воспроизведения", "Обновить"]);
  });

  it("the card hints at the options: «■ Ещё» in extension", async () => {
    const t = await make();
    assert.equal((await open(t, BIG)).extension, "{ico:msx-red:stop} Ещё");
  });
});

describe("card v1.19: trailer resolve play:<id>:trailer — video without progress", () => {
  it("dataId grammar: play:<id>:trailer is a resolve route of its own", () => {
    assert.equal(ids.playTrailer(BIG), "play:2001:trailer");
    assert.deepEqual(parseDataId("play:2001:trailer"), { k: "trailer", id: BIG });
  });

  it("a card without a direct url: items/trailer → the file, a label, no kp:* — the tracker does not mark time", async () => {
    const t = await make();
    await open(t, BIG);
    const r = (await t.request(ids.playTrailer(BIG))) as MsxResolveResponse;
    assert.match(r.url ?? "", /\/cdn\/media\/sample\.webm\?trailer=\d+$/);
    assert.equal(r.label, "Тестовый сериал «Большой» · Трейлер");
    assert.deepEqual(r.properties, { "control:type": "extended", "trigger:back": "player:eject", "trigger:complete": "player:eject" });
    assert.equal(Object.keys(r.properties ?? {}).some((k) => k.startsWith("kp:")), false);
    assert.equal(calls(t, "/v1/items/trailer"), 1);
    assert.equal(t.ctx.current.get(), ids.item(BIG), "resolve does not change the current screen");
  });

  it("a fresh card with a direct url plays it without a request; a stale one asks items/trailer", async () => {
    const t = await make();
    const got = await t.run(t.ctx.repo.item(FIX.MOVIE_SIMPLE));
    got.value.trailer = { url: "https://cdn.example/trailers/t.mp4" };
    assert.equal(((await t.request(ids.playTrailer(FIX.MOVIE_SIMPLE))) as MsxResolveResponse).url, "https://cdn.example/trailers/t.mp4");
    assert.equal(calls(t, "/v1/items/trailer"), 0);
    t.ctx.cache.markStale(cacheKeys.item(FIX.MOVIE_SIMPLE));
    assert.match(((await t.request(ids.playTrailer(FIX.MOVIE_SIMPLE))) as MsxResolveResponse).url ?? "", /sample\.webm/);
    assert.equal(calls(t, "/v1/items/trailer"), 1);
  });

  it("no trailer in KinoPub → { error } for the player, not a screen", async () => {
    const t = await make();
    const r = (await t.request(ids.playTrailer(FIX.MOVIE_MULTI))) as MsxResolveResponse;
    assert.equal(r.url, undefined);
    assert.equal(typeof r.error, "string");
  });
});

describe("act:item:wl — «Буду смотреть» (CM-01)", () => {
  it("re-reads the card, toggles once, re-reads; serials and the card are fresh; the current card is redrawn", async () => {
    const t = await make();
    const before = await open(t, BIG);
    assert.equal(el(before, "b_wl")?.label, "✓ В списке");
    await t.run(t.ctx.repo.serials({ subscribed: true }));
    const n0 = t.mock.calls().length;
    await t.run(onItemAct(t.ctx, "wl", [String(BIG), "0"]));
    assert.equal(t.mock.state.watchlist.get(BIG), false);
    assert.deepEqual(t.mock.calls().slice(n0).map((c) => c.path), [`/v1/items/${BIG}`, "/v1/watching/togglewatchlist", `/v1/items/${BIG}`]);
    assert.deepEqual(t.host.actions.map((a) => a.action), ["reload:content"]);
    assert.equal(t.ctx.cache.peek(cacheKeys.serials(true))?.stale, true, "«Я смотрю» and home are marked stale");
    assert.equal(el(await open(t, BIG), "b_wl")?.label, "★ Буду смотреть");
  });

  it("already as wanted (another TV changed it): no toggle at all", async () => {
    const t = await make();
    await open(t, BIG);
    t.mock.state.watchlist.set(BIG, false);
    await t.run(onItemAct(t.ctx, "wl", [String(BIG), "0"]));
    assert.equal(calls(t, "/v1/watching/togglewatchlist"), 0);
    assert.deepEqual(t.host.actions.map((a) => a.action), ["reload:content"]);
  });

  it("a dropped toggle is not repeated blindly: one call, a notice, the state as KinoPub has it", async () => {
    const t = await make();
    await open(t, BIG);
    t.mock.setScenario({ rules: [{ path: "^/v1/watching/togglewatchlist$", drop: true }] });
    await t.run(onItemAct(t.ctx, "wl", [String(BIG), "0"]));
    assert.equal(calls(t, "/v1/watching/togglewatchlist"), 1);
    assert.equal(t.mock.state.watchlist.get(BIG), undefined);
    assert.match(t.host.actions[0]?.action ?? "", /^info:/);
  });

  it("the watchlist is part of the personal hash: a change elsewhere redraws the card on refresh", async () => {
    const t = await make();
    const got = await t.run(t.ctx.repo.item(BIG));
    const a = itemHash(t.ctx, got.value, got.fetchedAt);
    assert.notEqual(itemHash(t.ctx, { ...got.value, watchlist: false }, got.fetchedAt), a);
  });

  it("malformed arguments send nothing", async () => {
    const t = await make();
    await t.run(onItemAct(t.ctx, "wl", ["x", "1"]));
    await t.run(onItemAct(t.ctx, "wl", [String(BIG), "2"]));
    assert.equal(t.mock.calls().length, 0);
  });
});
