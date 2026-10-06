import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ItemSummary } from "../../src/api/models.ts";
import { GRID, ROW, TILE_STYLE, gridPreload, gridTemplate, iconTile, posterTile, posterTiles, posterUrl, shelfTile, titleLines, yearRating } from "../../src/screens/tiles.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(o: Omit<TestAppOptions, "loggedIn"> = {}): Promise<TestApp> {
  const t = await createTestApp({ ...o, loggedIn: true });
  apps.push(t);
  return t;
}

const summary = (over: Partial<ItemSummary> = {}): ItemSummary => ({
  id: 1001, type: "movie", subtype: "", title: "Тестовый фильм 1001 / Test Movie 1001", year: 2001,
  genres: [], countries: [], quality: 1080, kpRating: 7.912,
  posters: { small: "https://cdn.test/s/1001.jpg", medium: "https://cdn.test/m/1001.jpg", big: "https://cdn.test/b/1001.jpg" },
  ...over,
});

describe("titleLines (V-10, крупные плитки)", () => {
  it("up to 12 characters — the first line and an empty second one: titles in a row start at one height", () => {
    assert.equal(titleLines("Брат 2"), "{col:msx-white}Брат 2{br} ");
    assert.equal(titleLines("Достучаться!"), "{col:msx-white}Достучаться!{br} ");
  });

  it("longer — split at the last word boundary within 12 characters, the rest on the second line (MSX cuts it with «…»)", () => {
    assert.equal(titleLines("Тестовый фильм 1001"), "{col:msx-white}Тестовый{br}фильм 1001");
    assert.equal(titleLines("Властелин колец: Братство кольца"), "{col:msx-white}Властелин{br}колец: Братство кольца");
    assert.equal(titleLines("Москва слезам не верит"), "{col:msx-white}Москва{br}слезам не верит");
  });

  it("a first word longer than a line stays whole (MSX adds «…»); one long word — one line", () => {
    assert.equal(titleLines("Достопримечательности Москвы"), "{col:msx-white}Достопримечательности{br}Москвы");
    assert.equal(titleLines("Достопримечательности"), "{col:msx-white}Достопримечательности{br} ");
  });
});

describe("yearRating", () => {
  it("«2001 · 7,9»; empty parts are dropped; a whole rating keeps one decimal", () => {
    assert.equal(yearRating(2001, 7.912), "2001 · 7,9");
    assert.equal(yearRating(undefined, 7.912), "7,9");
    assert.equal(yearRating(2001, undefined), "2001");
    assert.equal(yearRating(2001, 0), "2001");
    assert.equal(yearRating(2001, 8), "2001 · 8,0");
    assert.equal(yearRating(0, undefined), "");
  });
});

describe("posterUrl: one address per poster on every screen (HTTP cache of the TV)", () => {
  const p = { small: "https://cdn.test/s/1.jpg", medium: "https://cdn.test/m/1.jpg", big: "https://cdn.test/b/1.jpg" };
  it("the size from prefs; a missing size falls back to medium", () => {
    assert.equal(posterUrl(p, "medium"), "https://cdn.test/m/1.jpg");
    assert.equal(posterUrl(p, "small"), "https://cdn.test/s/1.jpg");
    assert.equal(posterUrl({ ...p, small: "" }, "small"), "https://cdn.test/m/1.jpg");
  });

  it("https, no query and no fragment; the host stays as the API gave it", () => {
    assert.equal(posterUrl({ ...p, medium: "http://m.staticpop.net/poster/item/medium/1.jpg?v=2#x" }, "medium"), "https://m.staticpop.net/poster/item/medium/1.jpg");
    assert.equal(posterUrl({ ...p, medium: "//m.pushbr.com/poster/item/medium/1.jpg" }, "medium"), "https://m.pushbr.com/poster/item/medium/1.jpg");
    assert.equal(posterUrl({ ...p, medium: "  https://cdn.test/m/1.jpg?t=123  " }, "medium"), "https://cdn.test/m/1.jpg");
  });

  it("development hosts keep http (kpmock, local stands); not an absolute address — as is", () => {
    assert.equal(posterUrl({ ...p, medium: "http://127.0.0.1:8787/poster/medium/1.svg" }, "medium"), "http://127.0.0.1:8787/poster/medium/1.svg");
    assert.equal(posterUrl({ ...p, medium: "http://localhost:8787/p.svg?x=1" }, "medium"), "http://localhost:8787/p.svg");
    assert.equal(posterUrl({ ...p, medium: "http://kp.test/p.jpg" }, "medium"), "http://kp.test/p.jpg");
    assert.equal(posterUrl({ ...p, medium: "" }, "medium"), "");
  });
});

describe("posterTile", () => {
  it("id, kid and the full name for the headline, the title in two lines, year and КП rating below, medium poster, action to the card", async () => {
    const t = await make();
    assert.deepEqual(posterTile(t.ctx, summary()), {
      id: "i1001", kid: "1001", kt: "Тестовый фильм 1001", titleHeader: "{col:msx-white}Тестовый{br}фильм 1001", titleFooter: "2001 · 7,9",
      image: "https://cdn.test/m/1001.jpg", action: `content:request:interaction:item:1001@${TEST_P}`,
    });
  });

  it("kt — the Russian title in full, whatever the two lines show", async () => {
    const t = await make();
    assert.equal(posterTile(t.ctx, summary({ title: "Властелин колец: Братство кольца / The Lord of the Rings" })).kt, "Властелин колец: Братство кольца");
    assert.equal(posterTile(t.ctx, summary({ title: "Брат 2" })).kt, "Брат 2");
  });

  it("without year and rating — no grey line", async () => {
    const t = await make();
    const { year: _y, kpRating: _r, ...bare } = summary();
    assert.ok(!("titleFooter" in posterTile(t.ctx, bare)));
    assert.equal(posterTile(t.ctx, summary({ kpRating: 0 })).titleFooter, "2001");
  });

  it("badge «4K» only for quality ≥ 2160", async () => {
    const t = await make();
    assert.equal(posterTile(t.ctx, summary({ quality: 2160 })).badge, "4K");
    assert.ok(!("badge" in posterTile(t.ctx, summary({ quality: 1080 }))));
  });

  it("the poster size follows prefs.posterSize; a missing size falls back to medium", async () => {
    const t = await make();
    t.ctx.prefs.update({ posterSize: "small" });
    assert.equal(posterTile(t.ctx, summary()).image, "https://cdn.test/s/1001.jpg");
    const p = summary().posters;
    assert.equal(posterTile(t.ctx, summary({ posters: { ...p, small: "" } })).image, "https://cdn.test/m/1001.jpg");
  });

  it("a 4K title from the mock: badge and the mock poster", async () => {
    const t = await make();
    const got = await t.run(t.ctx.repo.item(2004));
    const tile = posterTile(t.ctx, got.value);
    assert.equal(tile.badge, "4K");
    assert.equal(tile.titleHeader, "{col:msx-white}Тестовый{br}фильм «12 озвучек»");
    assert.equal(tile.image, got.value.posters.medium);
  });

  it("posterTiles gives the same tiles in order", async () => {
    const t = await make();
    const list = [summary(), summary({ id: 1002, quality: 2160 })];
    assert.deepEqual(posterTiles(t.ctx, list), list.map((it) => posterTile(t.ctx, it)));
  });
});

describe("shelfTile and iconTile (pages of the home screen)", () => {
  it("shelfTile: the full look in the tile, the same data and poster address as in the grid, the full name and prefetch in selection", async () => {
    const t = await make();
    const tile = shelfTile(t.ctx, summary(), "medium");
    const { id: _id, kid: _kid, kt: _kt, ...data } = posterTile(t.ctx, summary());
    assert.deepEqual(tile, { ...TILE_STYLE, ...data, selection: { headline: "Тестовый фильм 1001", action: "interaction:commit:message:pf:1001" } });
  });

  it("shelfTile without prefetch: the selection only names the tile", async () => {
    const t = await make({ flags: { focusPrefetch: "off" } });
    assert.deepEqual(shelfTile(t.ctx, summary(), "medium").selection, { headline: "Тестовый фильм 1001" });
  });

  it("iconTile: a large icon in place of the poster, the name in two lines and a grey line, both cut to one line each", () => {
    assert.deepEqual(iconTile("bookmark", "Избранное", "2 шт.", "x"), {
      type: "default", color: "msx-glass", round: true, truncation: "titleHeader|titleFooter", icon: "bookmark", iconSize: "large",
      titleHeader: "{col:msx-white}Избранное{br} ", titleFooter: "2 шт.", action: "x",
    });
    assert.ok(!("titleFooter" in iconTile("arrow-forward", "Показать все", "", "x")));
  });
});

describe("gridTemplate", () => {
  it("6 per row 2×4 in 12×6: the poster 2:3 in the wrapped image, badges on it; the full title in the headline, focus prefetch (CD-10)", async () => {
    const t = await make();
    assert.deepEqual(GRID, { width: 12, height: 6, w: 2, h: 4, poster: true });
    assert.equal(ROW, GRID.width / GRID.w);
    assert.deepEqual(gridTemplate(t.ctx), {
      color: "msx-glass", imageHeight: 2.75, imageFiller: "cover", imageBoundary: true, round: true, truncation: "titleHeader",
      layout: "0,0,2,4", enumerate: false,
      selection: { headline: "{context:kt}", action: "interaction:commit:message:pf:{context:kid}" },
    });
  });

  it("in a compressed root the tiles stay 12×6 at full font size; the poster height in 108 px units", async () => {
    const t = await make();
    const tpl = gridTemplate(t.ctx, true);
    assert.deepEqual([tpl.decompress, tpl.compress, tpl.imageHeight, tpl.layout], [true, false, 3.67, "0,0,2,4"]);
  });

  it("V-11: tiles are not enumerated — MSX hides its «(57/96)» counter of the window", async () => {
    const t = await make();
    assert.equal(gridTemplate(t.ctx).enumerate, false);
  });

  it("focusPrefetch: off → the selection only names the tile, no prefetch message", async () => {
    const t = await make({ flags: { focusPrefetch: "off" } });
    assert.deepEqual(gridTemplate(t.ctx).selection, { headline: "{context:kt}" });
  });
});

describe("gridPreload", () => {
  it("next by default, nothing when switched off", async () => {
    assert.deepEqual(gridPreload((await make()).ctx), { preload: "next" });
    assert.deepEqual(gridPreload((await make({ flags: { gridPreload: "none" } })).ctx), {});
  });
});
