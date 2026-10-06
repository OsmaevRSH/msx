import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { MsxMenuItem, MsxMenuRoot } from "../../src/msx/types.ts";
import { decodeListKey, encodeListKey } from "../../src/router/ids.ts";
import type { ListKey } from "../../src/router/ids.ts";
import { SECTIONS, buildMenu, menuStore } from "../../src/screens/menu.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(loggedIn: boolean): Promise<TestApp> {
  const t = await createTestApp({ loggedIn });
  apps.push(t);
  return t;
}

const req = (dataId: string): string => `request:interaction:${dataId}@${TEST_P}`;
const list = (k: ListKey): string => req(`list:${encodeListKey(k)}`);
const catalog = (type: string, genre?: string): ListKey =>
  genre === undefined ? { src: "catalog", type, sort: "-updated" } : { src: "catalog", type, sort: "-updated", genre };

/** Сравнение без `id`: проверяются метки, иконки, типы и точные `data`. */
const shape = (m: MsxMenuRoot): Omit<MsxMenuItem, "id">[] => m.menu.map(({ id: _id, ...rest }) => rest);

describe("buildMenu (S3)", () => {
  it("root: headline, clock in the extension, Russian MSX dictionary, cached, flag for replace:menu", async () => {
    const t = await make(false);
    const m = buildMenu(t.ctx);
    assert.equal(m.headline, "KinoPub");
    assert.equal(m.extension, "{ico:msx-white:access-time} {now:time:hh:mm}");
    assert.equal(m.dictionary, "http://msx.benzac.de/dic/ru.json");
    assert.equal(m.cache, true);
    // MSX не выполняет reload:menu для меню из start parameter; replace:menu требует флаг (smoke-e2e этапа 27).
    assert.equal(m.flag, "menu");
  });

  it("without login: «Вход», «Диагностика», «Настройки MSX»", async () => {
    const t = await make(false);
    assert.deepEqual(shape(buildMenu(t.ctx)), [
      { icon: "login", label: "Вход", data: req("login") },
      { icon: "build", label: "Диагностика", data: req("probe") },
      { type: "settings", label: "Настройки MSX" },
    ]);
  });

  it("with login: «Главная», «Я смотрю», «Поиск», «Новинки», the former items, the new sections, settings last (v1.11)", async () => {
    const t = await make(true);
    assert.deepEqual(shape(buildMenu(t.ctx)), [
      { icon: "home", label: "Главная", data: req("home") },
      { icon: "visibility", label: "Я смотрю", data: req("watching") },
      { icon: "search", label: "Поиск", data: req("search") },
      { icon: "new-releases", label: "Новинки", data: list({ src: "fresh" }) },
      { type: "separator", label: "Каталог" },
      { icon: "movie", label: "Фильмы", data: list(catalog("movie")) },
      { icon: "tv", label: "Сериалы", data: list(catalog("serial")) },
      { icon: "child-care", label: "Мультфильмы", data: list(catalog("movie,serial", "23")) },
      { icon: "public", label: "Документальное", data: list(catalog("documovie,docuserial")) },
      { icon: "live-tv", label: "ТВ-шоу", data: list(catalog("tvshow")) },
      { icon: "music-note", label: "Концерты", data: list(catalog("concert")) },
      { type: "separator" },
      { icon: "bookmark", label: "Закладки", data: req("bookmarks") },
      { icon: "history", label: "История", data: list({ src: "history" }) },
      { type: "separator", label: "Ещё" },
      { icon: "collections-bookmark", label: "Подборки", data: list({ src: "collections" }) },
      { icon: "trending-up", label: "Популярное", data: list({ src: "popular" }) },
      { icon: "whatshot", label: "Горячее", data: list({ src: "hot" }) },
      { icon: "animation", label: "Аниме", data: list(catalog("movie,serial", "25")) },
      { icon: "theater-comedy", label: "Стендап", data: list(catalog("movie", "101")) },
      { icon: "3d-rotation", label: "3D", data: list(catalog("3d")) },
      { icon: "4k", label: "4K", data: list({ src: "catalog", sort: "-updated", quality: "4" }) },
      { icon: "sports-soccer", label: "Спорт", data: req("tv") },
      { type: "separator" },
      { icon: "tune", label: "Просмотр и аккаунт", data: req("settings") },
      { icon: "build", label: "Диагностика", data: req("probe") },
      { type: "settings", label: "Настройки MSX" },
    ]);
  });

  it("existing item ids keep their values: MSX keeps the selected item by id across replace:menu", async () => {
    const t = await make(true);
    const got = buildMenu(t.ctx).menu.map((i) => i.id);
    for (const id of ["home", "search", "movies", "serials", "cartoons", "docs", "tvshows", "concerts", "bookmarks", "settings", "probe", "msx_settings"]) {
      assert.ok(got.includes(id), id);
    }
  });

  it("«Пункты меню»: hidden items disappear, the order is the user's, «Настройки MSX» stays last", async () => {
    const t = await make(true);
    const store = menuStore(t.ctx);
    const order = store.get().order;
    store.set({ order: ["sport", ...order.filter((id) => id !== "sport")], hidden: ["home", "fresh", "probe"] });
    const m = buildMenu(t.ctx).menu;
    const labels = m.map((i) => i.label ?? "—");
    assert.deepEqual(labels.slice(0, 5), ["Спорт", "—", "Я смотрю", "Поиск", "Каталог"]);
    assert.ok(!labels.includes("Главная") && !labels.includes("Новинки") && !labels.includes("Диагностика"));
    assert.equal(m.at(-1)?.type, "settings");
    assert.equal(m.at(-2)?.label, "Просмотр и аккаунт");
    // Группа «Ещё» встречается дважды: «Спорт» первым пунктом (над ним разделителя нет), затем подборки — с подписью.
    assert.equal(m.filter((i) => i.label === "Ещё").length, 1);
    assert.equal(m.filter((i) => i.type === "separator" && i.label === "Каталог").length, 1);
    assert.equal(m[0]?.type, undefined, "no separator above the first item");
  });

  it("«Просмотр и аккаунт» cannot be hidden even by a stored value", async () => {
    const t = await make(true);
    t.ctx.store.set("cfg", "menu", { hidden: ["settings", "watching"] });
    const labels = buildMenu(t.ctx).menu.map((i) => i.label);
    assert.ok(labels.includes("Просмотр и аккаунт"));
    assert.ok(!labels.includes("Я смотрю"));
  });

  it("without login the menu ignores «Пункты меню»", async () => {
    const t = await make(false);
    t.ctx.store.set("cfg", "menu", { hidden: ["probe"] });
    assert.deepEqual(buildMenu(t.ctx).menu.map((i) => i.label), ["Вход", "Диагностика", "Настройки MSX"]);
  });

  it("every section is in SECTIONS once, with an icon and a label", () => {
    assert.equal(new Set(SECTIONS.map((x) => x.id)).size, SECTIONS.length);
    for (const x of SECTIONS) assert.ok(x.icon !== "" && x.label !== "" && x.dataId() !== "", x.id);
  });

  it("«Мультфильмы» decodes to catalog movie,serial with genre 23", async () => {
    const t = await make(true);
    const item = buildMenu(t.ctx).menu.find((i) => i.label === "Мультфильмы");
    const key = /^request:interaction:list:([^@]+)@/.exec(item?.data ?? "")?.[1] ?? "";
    assert.deepEqual(decodeListKey(key), { src: "catalog", type: "movie,serial", genre: "23", sort: "-updated" });
  });

  it("item ids are unique", async () => {
    const t = await make(true);
    const idsSeen = buildMenu(t.ctx).menu.map((i) => i.id).filter((id) => id !== undefined);
    assert.equal(new Set(idsSeen).size, idsSeen.length);
  });

  for (const loggedIn of [false, true]) {
    it(`answers init within 100 ms without requests to the API (CNFR-03, loggedIn: ${loggedIn})`, async () => {
      const t = await make(loggedIn);
      const wall = performance.now();
      const t0 = t.ctx.clock.perf();
      const m = (await t.request("init")) as MsxMenuRoot;
      assert.ok(performance.now() - wall <= 100);
      assert.ok(t.ctx.clock.perf() - t0 <= 100);
      assert.deepEqual(m, buildMenu(t.ctx));
      assert.equal(t.mock.calls().length, 0);
    });
  }
});
