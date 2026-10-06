import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ItemSummary } from "../../src/api/models.ts";
import { gridTemplate, posterTile, posterTiles, titleLines } from "../../src/screens/tiles.ts";
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

describe("titleLines (V-10)", () => {
  it("up to 12 characters — one line", () => {
    assert.deepEqual(titleLines("Брат 2"), { title: "Брат 2" });
    assert.deepEqual(titleLines("Достучаться!"), { title: "Достучаться!" });
  });

  it("longer — split at the last word boundary within 12 characters, the rest white in titleFooter", () => {
    assert.deepEqual(titleLines("Тестовый фильм 1001"), { title: "Тестовый", titleFooter: "{col:msx-white}фильм 1001" });
    assert.deepEqual(titleLines("Властелин колец: Братство кольца"), { title: "Властелин", titleFooter: "{col:msx-white}колец: Братство кольца" });
    assert.deepEqual(titleLines("Москва слезам не верит"), { title: "Москва", titleFooter: "{col:msx-white}слезам не верит" });
  });

  it("a first word longer than a line stays whole (MSX adds «…»); one long word — one line", () => {
    assert.deepEqual(titleLines("Достопримечательности Москвы"), { title: "Достопримечательности", titleFooter: "{col:msx-white}Москвы" });
    assert.deepEqual(titleLines("Достопримечательности"), { title: "Достопримечательности" });
  });
});

describe("posterTile", () => {
  it("id, kid, Russian title in two lines, year and КП rating in the stamp, medium poster, action to the card", async () => {
    const t = await make();
    assert.deepEqual(posterTile(t.ctx, summary()), {
      id: "i1001", kid: "1001", ktail: "фильм 1001", title: "Тестовый", titleFooter: "{col:msx-white}фильм 1001", stamp: "2001 · 7,9",
      image: "https://cdn.test/m/1001.jpg", action: `content:request:interaction:item:1001@${TEST_P}`,
    });
  });

  it("V-10: ktail continues the first line for the headline of the focused tile; a one-line title — an empty string", async () => {
    const t = await make();
    const headline = (it: ItemSummary): string => {
      const tile = posterTile(t.ctx, it);
      return `${String(tile.title)} ${String(tile.ktail)}`.trim();
    };
    assert.equal(headline(summary({ title: "Властелин колец: Братство кольца / The Lord of the Rings" })), "Властелин колец: Братство кольца");
    assert.equal(posterTile(t.ctx, summary({ title: "Брат 2" })).ktail, "");
    assert.equal(headline(summary({ title: "Брат 2" })), "Брат 2");
  });

  it("empty stamp parts are dropped; a whole rating keeps one decimal", async () => {
    const t = await make();
    const { year: _y, ...noYear } = summary();
    const { kpRating: _r, ...noRating } = summary();
    assert.equal(posterTile(t.ctx, noYear).stamp, "7,9");
    assert.equal(posterTile(t.ctx, noRating).stamp, "2001");
    assert.equal(posterTile(t.ctx, summary({ kpRating: 0 })).stamp, "2001");
    assert.equal(posterTile(t.ctx, summary({ kpRating: 8 })).stamp, "2001 · 8,0");
    const { year: _y2, kpRating: _r2, ...bare } = summary();
    assert.ok(!("stamp" in posterTile(t.ctx, bare)));
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
    assert.deepEqual([tile.title, tile.titleFooter], ["Тестовый", "{col:msx-white}фильм «12 озвучек»"]);
    assert.equal(tile.image, got.value.posters.medium);
  });

  it("posterTiles gives the same tiles in order", async () => {
    const t = await make();
    const list = [summary(), summary({ id: 1002, quality: 2160 })];
    assert.deepEqual(posterTiles(t.ctx, list), list.map((it) => posterTile(t.ctx, it)));
  });
});

describe("gridTemplate", () => {
  it("separate glass tile with cover and round corners; the full title in the headline (V-10), focus prefetch (CD-10)", async () => {
    const t = await make();
    assert.deepEqual(gridTemplate(t.ctx, "0,0,2,4"), {
      type: "separate", layout: "0,0,2,4", color: "msx-glass", imageFiller: "cover", round: true, enumerate: false,
      selection: { headline: "{context:title} {context:ktail}", action: "interaction:commit:message:pf:{context:kid}" },
    });
  });

  it("V-11: tiles are not enumerated — MSX hides its «(57/96)» counter of the window", async () => {
    const t = await make();
    assert.equal(gridTemplate(t.ctx, "0,0,2,4").enumerate, false);
  });

  it("focusPrefetch: off → the selection only names the tile, no prefetch message", async () => {
    const t = await make({ flags: { focusPrefetch: "off" } });
    const tpl = gridTemplate(t.ctx, "0,0,2,4");
    assert.deepEqual(tpl.selection, { headline: "{context:title} {context:ktail}" });
    assert.equal(tpl.layout, "0,0,2,4");
  });
});
