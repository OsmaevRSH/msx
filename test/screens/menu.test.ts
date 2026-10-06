import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import type { MsxMenuItem, MsxMenuRoot } from "../../src/msx/types.ts";
import { decodeListKey, encodeListKey } from "../../src/router/ids.ts";
import type { ListKey } from "../../src/router/ids.ts";
import { buildMenu } from "../../src/screens/menu.ts";
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

  it("with login: full menu with the catalog sections", async () => {
    const t = await make(true);
    assert.deepEqual(shape(buildMenu(t.ctx)), [
      { icon: "home", label: "Главная", data: req("home") },
      { icon: "search", label: "Поиск", data: req("search") },
      { type: "separator", label: "Каталог" },
      { icon: "movie", label: "Фильмы", data: list(catalog("movie")) },
      { icon: "tv", label: "Сериалы", data: list(catalog("serial")) },
      { icon: "child-care", label: "Мультфильмы", data: list(catalog("movie,serial", "23")) },
      { icon: "public", label: "Документальное", data: list(catalog("documovie,docuserial")) },
      { icon: "live-tv", label: "ТВ-шоу", data: list(catalog("tvshow")) },
      { icon: "music-note", label: "Концерты", data: list(catalog("concert")) },
      { type: "separator" },
      { icon: "bookmark", label: "Закладки", data: req("bookmarks") },
      { icon: "tune", label: "Просмотр и аккаунт", data: req("settings") },
      { icon: "build", label: "Диагностика", data: req("probe") },
      { type: "settings", label: "Настройки MSX" },
    ]);
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
