import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chain, commitMsg, panelAction, replaceContent } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { decodeListKey, encodeListKey, ids, listFlag, msgs } from "../../src/router/ids.ts";
import type { ListKey } from "../../src/router/ids.ts";
import { b64urlDecode } from "../../src/core/b64url.ts";
import { KpError } from "../../src/core/errors.ts";
import { fmtCount } from "../../src/core/format.ts";
import { errorScreen } from "../../src/screens/error.ts";
import { listScreen, listSource, onExtend } from "../../src/screens/list.ts";
import type { ListEntry } from "../../src/screens/list.ts";
import { FILMS } from "../../src/screens/list-head.ts";
import { onPanelAct } from "../../src/screens/panels.ts";
import { ALL_COUNTRIES, FIX, catalog } from "../../tools/kpmock/fixtures.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

// Фильтры каталога (спец. §11.4, v1.16): красная кнопка → панель «Сортировка и фильтры», панели года, страны и рейтинга,
// переключатели 4K и «Завершённые», «Сбросить»; ключ списка и кэша с фильтрами, память раздела на сессию.

const P = TEST_P;
const CHECK = "{ico:check} ";
let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(o: { storage?: TestApp["storage"]; mock?: TestApp["mock"] } = {}): Promise<TestApp> {
  const t = await createTestApp({ ...o, loggedIn: true });
  apps.push(t);
  return t;
}

const MOVIES: ListKey = { src: "catalog", type: "movie", sort: "-updated" };
const SERIALS: ListKey = { src: "catalog", type: "serial", sort: "-updated" };
const UHD: ListKey = { src: "catalog", sort: "-updated", quality: "4" };
const key = (k: ListKey): string => encodeListKey(k);
const list = async (t: TestApp, k: ListKey): Promise<MsxContentRoot> => (await t.request(ids.list(key(k)))) as MsxContentRoot;
const panel = async (t: TestApp, type: string, k: ListKey): Promise<MsxContentRoot> =>
  (await t.request(ids.panel(type, key(k)))) as MsxContentRoot;
const rows = (s: MsxContentRoot): MsxContentItem[] => s.items ?? [];
const labels = (s: MsxContentRoot): (string | undefined)[] => rows(s).map((r) => r.label);
const row = (s: MsxContentRoot, label: string): MsxContentItem => {
  const found = rows(s).find((r) => r.label === label || r.label === CHECK + label);
  assert.ok(found, `no row ${label} in ${JSON.stringify(labels(s))}`);
  return found;
};
const pick = (field: string, value: string | number): string => commitMsg(msgs.act("panel", "filter", field, value));
const open = (type: string, k: ListKey): string => chain(["back", panelAction(P, ids.panel(type, key(k)))]);
const replace = (from: ListKey, to: ListKey): string => chain(["back", replaceContent(listFlag(key(from)), P, ids.list(key(to)))]);
const act = (t: TestApp, ...args: string[]): Promise<void> => t.run(onPanelAct(t.ctx, "filter", args));
const actions = (t: TestApp): string[] => t.host.actions.map((a) => a.action);
const items = (t: TestApp): URLSearchParams[] => t.mock.calls().filter((c) => c.path === "/v1/items").map((c) => new URLSearchParams(c.query));
const visible = (pred: (it: ReturnType<typeof catalog>[number]) => boolean): number =>
  catalog().filter((it) => !it.deleted && !it.unlisted && pred(it)).length;

describe("catalog filters: the red button and the panels (spec §11.4)", () => {
  it("the options of a catalog are one Option Shortcut row: the red button opens «Сортировка и фильтры» at once", async () => {
    const t = await make();
    for (const k of [MOVIES, UHD, { ...MOVIES, year: "2010-2019", kp: "7" }]) {
      const s = await list(t, k);
      assert.deepEqual(s.options, {
        headline: "Сортировка и фильтры", template: { type: "control", layout: "0,0,8,1" },
        items: [{ id: "o_filters", icon: "tune", label: "Сортировка и фильтры", key: "red", action: chain(["cleanup", panelAction(P, ids.panel("filters", key(k)))]) }],
      });
    }
  });

  it("«Фильмы»: sort, genre, year, country, rating and the 4K switch; values close this panel before their own; no «Завершённые» and no reset", async () => {
    const t = await make();
    await list(t, MOVIES);
    const s = await panel(t, "filters", MOVIES);
    assert.deepEqual([s.type, s.headline, s.cache, s.reuse, s.template], ["list", "Сортировка и фильтры", false, false, { type: "control", layout: "0,0,8,1" }]);
    assert.deepEqual(rows(s).map((r) => [r.id, r.icon, r.label, r.action]), [
      ["f_sort", "sort", "Сортировка: Обновлённые", open("sort", MOVIES)],
      ["f_genre", "category", "Жанр: все жанры", open("genre", MOVIES)],
      ["f_year", "date-range", "Год: любой", open("year", MOVIES)],
      ["f_country", "public", "Страна: любая", open("country", MOVIES)],
      ["f_kp", "star", "Рейтинг: любой", open("kp", MOVIES)],
      ["f_uhd", "check-box-outline-blank", "4K", pick("uhd", 1)],
    ]);
  });

  it("current values in the rows; «Завершённые» only for series, 4K only with a type, reset only with a filter", async () => {
    const t = await make();
    const k: ListKey = { ...SERIALS, sort: "-kinopoisk_rating", genre: "9", year: "2010-2019", country: "1", kp: "7", quality: "4", fin: "1" };
    await list(t, k);
    assert.deepEqual(labels(await panel(t, "filters", k)), [
      "Сортировка: Рейтинг КП", "Жанр: Драма", "Год: 2010-е", "Страна: США", "Рейтинг: КП ≥ 7", "4K", "Завершённые", "Сбросить фильтры",
    ]);
    const s = await panel(t, "filters", k);
    assert.deepEqual(rows(s).slice(5).map((r) => [r.icon, r.action]), [
      ["check-box", pick("uhd", "")], ["check-box", pick("fin", "")], ["clear", commitMsg(msgs.act("panel", "filter", "reset"))],
    ]);
    assert.deepEqual(rows(await panel(t, "filters", SERIALS)).map((r) => r.id).slice(-2), ["f_uhd", "f_fin"]);
    assert.deepEqual(rows(await panel(t, "filters", UHD)).map((r) => r.id), ["f_sort", "f_genre", "f_year", "f_country", "f_kp"], "4K is the section itself");
    const docs: ListKey = { src: "catalog", type: "documovie,docuserial", sort: "-updated" };
    assert.ok(!rows(await panel(t, "filters", docs)).some((r) => r.id === "f_fin"), "films have no «finished»");
  });

  it("year: «Любой», decades, «До 2000», «Этот год»; a row sends the value, «Любой» an empty one", async () => {
    const t = await make();
    const s = await panel(t, "year", MOVIES);
    assert.equal(s.headline, "Год");
    assert.deepEqual(labels(s), [`${CHECK}Любой`, "2020-е", "2010-е", "2000-е", "До 2000", "Этот год"]);
    assert.deepEqual(rows(s).map((r) => r.action), [
      pick("year", ""), pick("year", "2020-2029"), pick("year", "2010-2019"), pick("year", "2000-2009"), pick("year", "1900-1999"),
      pick("year", String(new Date(t.clock.now()).getFullYear())),
    ]);
    assert.deepEqual(labels(await panel(t, "year", { ...MOVIES, year: "2000-2009" })).filter((l) => l?.startsWith(CHECK)), [`${CHECK}2000-е`]);
  });

  it("rating: «Любой», КП ≥ 6, 7, 8", async () => {
    const t = await make();
    const s = await panel(t, "kp", { ...MOVIES, kp: "8" });
    assert.equal(s.headline, "Рейтинг КП");
    assert.deepEqual(labels(s), ["Любой", "КП ≥ 6", "КП ≥ 7", `${CHECK}КП ≥ 8`]);
    assert.deepEqual(rows(s).map((r) => r.action), [pick("kp", ""), pick("kp", 6), pick("kp", 7), pick("kp", 8)]);
  });

  it("country: «Любая», the top 10 of /v1/countries in kino.pub order, «Другие страны…» opens the rest A–Я; a country from there is marked", async () => {
    const t = await make();
    const title = (id: number): string => ALL_COUNTRIES.find((c) => c.id === id)?.title ?? "";
    const s = await panel(t, "country", MOVIES);
    assert.deepEqual(s.template, { type: "button", layout: "0,0,4,1" });
    assert.deepEqual(labels(s), [`${CHECK}Любая`, ...[1, 2, 3, 5, 7, 4, 6, 8, 9, 10].map(title), "Другие страны…"]);
    assert.equal(row(s, title(5)).action, pick("country", 5));
    assert.equal(row(s, "Другие страны…").action, open("countries", MOVIES));
    const others = await panel(t, "countries", MOVIES);
    assert.equal(others.headline, "Другие страны");
    const names = labels(others).map(String);
    assert.equal(names.length, ALL_COUNTRIES.length - 10);
    assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "ru")));
    // 92 строки — в пределах 16 КБ панели (краулер), сообщение без ключа списка.
    assert.ok(Buffer.byteLength(JSON.stringify(others)) <= 16 * 1024, `${Buffer.byteLength(JSON.stringify(others))} B`);
    const far: ListKey = { ...MOVIES, country: "30" };
    assert.equal(row(await panel(t, "country", far), `Другие: ${title(30)}`).label, `${CHECK}Другие: ${title(30)}`);
    assert.deepEqual(labels(await panel(t, "countries", far)).filter((l) => l?.startsWith(CHECK)), [CHECK + title(30)]);
    assert.equal(t.mock.calls().filter((c) => c.path === "/v1/countries").length, 1, "the reference is cached for 24 h");
  });

  it("filter panels are only for the catalog: a shelf or a broken key is an error inside the panel", async () => {
    const t = await make();
    for (const type of ["filters", "year", "country", "countries", "kp"]) {
      for (const arg of [key({ src: "fresh", type: "movie" }), "!!"]) {
        const s = (await t.request(ids.panel(type, arg))) as MsxContentRoot;
        assert.match(String(s.pages?.[0]?.items[0]?.text), /KP-BAD/, `${type} ${arg}`);
      }
    }
  });
});

describe("catalog filters: choice, the list and the session memory (spec §11.4)", () => {
  it("a choice applies to the open list: replace by its flag with the filter in the key; the API gets year, conditions[], country, quality, finished", async () => {
    const t = await make();
    await list(t, MOVIES);
    await act(t, "year", "2010-2019");
    const y: ListKey = { ...MOVIES, year: "2010-2019" };
    assert.deepEqual(actions(t), [replace(MOVIES, y)]);
    t.host.clearActions();
    // MSX запрашивает новый ключ — он текущий, и следующий выбор добавляет фильтр к нему.
    const s = await list(t, y);
    assert.equal(s.flag, listFlag(key(y)));
    await act(t, "kp", "7");
    const yk: ListKey = { ...y, kp: "7" };
    assert.deepEqual(actions(t), [replace(y, yk)]);
    const f = await list(t, yk);
    const q = items(t).find((p) => p.get("conditions[]") !== null && p.get("page") === "1");
    assert.deepEqual(["type", "sort", "year", "conditions[]", "page", "perpage"].map((n) => q?.get(n)), [
      "movie", "-updated", "2010-2019", "kinopoisk_rating>=7", "1", "48",
    ]);
    const n = visible((it) => it.type === "movie" && it.year >= 2010 && it.year <= 2019 && it.kinopoisk_rating >= 7);
    assert.ok(n > 0 && n < 203, `${n}`);
    assert.equal(f.extension, `{ico:msx-red:stop} Обновлённые · 2010-е · КП ≥ 7 · ${fmtCount(n, FILMS)}`);
    assert.equal(f.headline, "Фильмы · Обновлённые");
    assert.equal((f.items ?? []).length, Math.min(n, 48));

    const all: ListKey = { ...SERIALS, genre: "9", year: "1990-1999", country: "2", kp: "6", quality: "4", fin: "1" };
    await list(t, all);
    const a = items(t).find((p) => p.get("finished") !== null);
    assert.deepEqual(["genre", "year", "country", "conditions[]", "quality", "finished"].map((p) => a?.get(p)), ["9", "1990-1999", "2", "kinopoisk_rating>=6", "4", "1"]);
  });

  it("the head: «Обновлённые · 2010-е · США · КП ≥ 7 · 4K · завершённые · Драма · N» — short, in the extension", async () => {
    const t = await make();
    const s = await list(t, { ...SERIALS, genre: "9", year: "2010-2019", country: "1", kp: "7", quality: "4", fin: "1" });
    assert.match(s.extension ?? "", /^\{ico:msx-red:stop\} Обновлённые · 2010-е · США · КП ≥ 7 · 4K · завершённые · Драма( · \d+ сериал(а|ов)?)?$/);
    const far = await list(t, { ...MOVIES, country: "40", year: "2026" });
    assert.equal(far.extension, `{ico:msx-red:stop} Обновлённые · 2026 · ${ALL_COUNTRIES.find((c) => c.id === 40)?.title}`);
    assert.deepEqual(far.pages?.[0]?.items.map((i) => i.text ?? i.label), ["Ничего не найдено", "Назад"]);
  });

  it("the menu key gets the filters of its section for the session; another section keeps its own; reset forgets them", async () => {
    const t = await make();
    await list(t, MOVIES);
    await act(t, "country", "1");
    const us: ListKey = { ...MOVIES, country: "1" };
    await list(t, us);
    await act(t, "uhd", "1");
    const usUhd: ListKey = { ...us, quality: "4" };
    // Пункт меню «Фильмы» (ключ без фильтров): тот же список в памяти, флаг и перерисовка — по ключу меню.
    await list(t, usUhd);
    const calls = t.mock.calls().length;
    const menu = await list(t, MOVIES);
    assert.equal(t.mock.calls().length, calls, "the menu key reuses the filtered list in memory");
    assert.equal(menu.flag, listFlag(key(MOVIES)));
    assert.match(menu.extension ?? "", /^\{ico:msx-red:stop\} Обновлённые · США · 4K/);
    assert.equal((t.ctx.state.lists.get(key(usUhd)) as ListEntry | undefined)?.dataId, ids.list(key(MOVIES)));
    assert.equal(row(await panel(t, "filters", MOVIES), "Страна: США").id, "f_country", "the panel of the menu key shows the session filters");
    // Жанр из панели ключа меню: фильтры раздела остаются.
    const drama = await list(t, { ...MOVIES, genre: "9" });
    assert.match(drama.extension ?? "", /США · 4K · Драма/);
    // «Сериалы» — свой раздел.
    assert.doesNotMatch((await list(t, SERIALS)).extension ?? "", /США/);
    // «Сбросить» с открытого «Фильмов» из меню — ключ без фильтров, и меню снова без них.
    await list(t, MOVIES);
    t.host.clearActions();
    await act(t, "reset");
    assert.deepEqual(actions(t), [replace(MOVIES, MOVIES)]);
    assert.equal((await list(t, MOVIES)).extension, "{ico:msx-red:stop} Обновлённые · 203 фильма");
  });

  it("toggles: «Завершённые» on and off keep only finished serials; 4K with a type is a filter of the section", async () => {
    const t = await make();
    await list(t, SERIALS);
    await act(t, "fin", "1");
    const fin: ListKey = { ...SERIALS, fin: "1" };
    assert.deepEqual(actions(t), [replace(SERIALS, fin)]);
    const s = await list(t, fin);
    const finished = catalog().filter((it) => it.type === "serial" && !it.deleted && !it.unlisted && it.id % 2 === 0).length;
    assert.match(s.extension ?? "", new RegExp(`· завершённые · ${finished} сериал`));
    t.host.clearActions();
    await act(t, "fin", "");
    assert.deepEqual(actions(t), [replace(fin, SERIALS)]);
    await list(t, MOVIES);
    t.host.clearActions();
    await act(t, "uhd", "1");
    assert.deepEqual(actions(t), [replace(MOVIES, { ...MOVIES, quality: "4" })]);
    const uhd = await list(t, { ...MOVIES, quality: "4" });
    assert.deepEqual((uhd.items ?? []).map((i) => i.id), [`i${FIX.MOVIE_AUDIO12}`]);
    assert.equal(uhd.headline, "Фильмы · Обновлённые", "4K with a type is a filter, not the «4K» section");
  });

  it("bad choices change nothing: unknown field, bad value, 4K in the «4K» section, a screen that is not a catalog", async () => {
    const t = await make();
    await list(t, MOVIES);
    for (const args of [["genre", "9"], ["year", "20x0"], ["kp", "10"], ["country", "us"], ["fin", "0"], ["uhd", "4"], [], ["year", "2010-2019", "x"]]) {
      await act(t, ...args);
    }
    await list(t, UHD);
    await act(t, "uhd", "1");
    await t.request(ids.home());
    await act(t, "year", "2010-2019");
    assert.deepEqual(actions(t).filter((a) => a.includes("replace:")), []);
    assert.ok(t.ctx.log.entries().filter((e) => e.tag === "filters" && e.msg === "bad_args").length >= 9);
  });

  it("the key and the cache know the filters; a bad value in a key is KP-BAD; extend keeps the filters", async () => {
    const t = await make();
    assert.deepEqual(listSource({ ...MOVIES, year: "2010-2019", country: "1", kp: "7", fin: "1", quality: "4" }), {
      kind: "catalog", type: "movie", sort: "-updated", quality: "4", year: "2010-2019", country: "1", kp: "7", fin: "1",
    });
    assert.deepEqual(decodeListKey(key({ ...MOVIES, year: "2010-2019", kp: "7" })), { ...MOVIES, year: "2010-2019", kp: "7" });
    for (const bad of [{ year: "2010-x" }, { country: "1,2" }, { kp: "7.5" }, { fin: "0" }]) {
      const k = key({ ...MOVIES, ...bad });
      assert.deepEqual(await t.run(listScreen(t.ctx, k)), errorScreen(t.ctx, new KpError("KP-BAD", "bad"), ids.list(k)), JSON.stringify(bad));
    }
    const old: ListKey = { ...MOVIES, year: "1990-1999" };
    const s = await list(t, old);
    const live = (s.items ?? []).at(-1)?.live?.action ?? "";
    const EXTEND = "interaction:commit:message:extend:";
    assert.ok(live.startsWith(EXTEND), live);
    await t.run(onExtend(t.ctx, live.slice(EXTEND.length)));
    assert.ok(items(t).some((q) => q.get("page") === "2" && q.get("year") === "1990-1999"), "page 2 with the same filter");
    const again = await list(t, old);
    assert.equal((again.items ?? []).length, Math.min(96, visible((it) => it.type === "movie" && it.year <= 1999)));
    assert.ok(Buffer.byteLength(JSON.stringify(again)) <= 32 * 1024);
  });

  it("session only: after a restart the menu key has no filters and L2 holds no filtered page", async () => {
    const a = await make();
    await list(a, MOVIES);
    await act(a, "kp", "8");
    await list(a, { ...MOVIES, kp: "8" });
    a.ctx.l2.flush();
    const sources = Array.from({ length: a.storage.length }, (_, i) => a.storage.key(i) ?? "")
      .filter((k) => k.startsWith("kp.l2.list:")).map((k) => JSON.parse(b64urlDecode(k.split(":")[1] ?? "")) as Record<string, string>);
    assert.ok(sources.some((src) => src.type === "movie" && src.kp === undefined), "the plain first page is in L2");
    assert.deepEqual(sources.filter((src) => src.kp !== undefined), [], "no filtered page in L2");
    const b = await make({ storage: a.storage, mock: a.mock });
    assert.equal((await list(b, MOVIES)).extension, "{ico:msx-red:stop} Обновлённые · 203 фильма");
  });
});
