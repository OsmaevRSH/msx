import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gridEdges, guard, perRow } from "../../src/msx/edges.ts";
import type { Grid } from "../../src/msx/edges.ts";
import type { MsxContentItem } from "../../src/msx/types.ts";

// Стражи краёв (спец. §11, навигация без перехода по кругу): разметку проверяет web MSX (e2e и стенд), здесь —
// геометрия, разрывы и цели `focus:`.

const tiles = (n: number): MsxContentItem[] => Array.from({ length: n }, (_, i) => ({ id: `i${i}` }));
const LIST: Grid = { width: 12, height: 6, w: 2, h: 4 };
const POSTERS: Grid = { ...LIST, poster: true };
const targets = (items: MsxContentItem[] | undefined): string[] => (items ?? []).map((g) => String(g.selection?.action));

describe("guard", () => {
  it("a transparent focusable cell above or below its target: same columns, the target's rectangle by offset, focus back", () => {
    assert.deepEqual(guard({ id: "i3", x: 6, y: 0, w: 2, h: 4 }, 0), {
      layout: "6,0,2,1", offset: "0,0,0,3", color: "transparent", selection: { action: "focus:i3" },
    });
    assert.deepEqual(guard({ id: "i3", x: 6, y: 0.5, w: 2, h: 4 }, 5).offset, "0,-4.5,0,3");
  });

  it("band: a row over the opaque top of a poster, no background (lighter list answers); line: zero height, no background", () => {
    assert.deepEqual(guard({ id: "i3", x: 6, y: 0, w: 2, h: 4 }, 4, "band"), { layout: "6,4,2,1", offset: "0,-4,0,0", selection: { action: "focus:i3" } });
    assert.deepEqual(guard({ id: "k3_1", x: 3, y: 1, w: 1, h: 1 }, 0, "line"), { layout: "3,0,1,1", offset: "0,1,0,-1", selection: { action: "focus:k3_1" } });
  });

  it("fractional boxes (decompressed tiles): integer layout, the rest in offset", () => {
    assert.deepEqual(guard({ id: "i1", x: 8 / 3, y: 0, w: 8 / 3, h: 16 / 3 }, 5), {
      layout: "3,5,3,1", offset: "-0.333,-5,-0.333,4.333", color: "transparent", selection: { action: "focus:i1" },
    });
  });
});

describe("gridEdges", () => {
  it("no tiles or no edges — nothing to add", () => {
    assert.deepEqual(gridEdges([], LIST, { top: "shift", bottom: true }), { items: [] });
    const items = tiles(3);
    assert.deepEqual(gridEdges(items, LIST, {}), { items });
    assert.equal(perRow(LIST), 6);
  });

  it("many rows: page:0 insert lifts the first row under its guards; the last row starts the end insert by a break", () => {
    const items = tiles(15);
    const out = gridEdges(items, LIST, { top: "shift", bottom: true });
    const [top, end] = out.inserts ?? [];
    assert.deepEqual({ ...top, items: undefined }, { position: "page:0", area: "0,1,12,5", offset: "0,0,0,-1", template: { offset: "0,-1,0,0" }, items: undefined });
    assert.deepEqual(targets(top?.items), ["focus:i0", "focus:i1", "focus:i2", "focus:i3", "focus:i4", "focus:i5"]);
    assert.deepEqual(top?.items.map((g) => g.layout), ["0,0,2,1", "2,0,2,1", "4,0,2,1", "6,0,2,1", "8,0,2,1", "10,0,2,1"]);
    assert.deepEqual({ ...end, items: undefined }, { position: "context:end", area: "0,0,12,4", offset: "0,0,0,-1", items: undefined });
    assert.deepEqual(targets(end?.items), ["focus:i12", "focus:i13", "focus:i14"]);
    assert.deepEqual(end?.items.map((g) => [g.layout, g.offset]), [["0,4,2,1", "0,-4,0,3"], ["2,4,2,1", "0,-4,0,3"], ["4,4,2,1", "0,-4,0,3"]]);
    assert.equal(out.items[12]?.break, "context:end");
    assert.equal(items[12]?.break, undefined, "the caller's tiles are not changed");
    assert.equal(out.items.filter((i) => i.break !== undefined).length, 1);
  });

  it("one row: one insert with guards above and below, the page as high as the row", () => {
    const out = gridEdges(tiles(4), LIST, { top: "shift", bottom: true });
    assert.equal(out.inserts?.length, 1);
    const [p] = out.inserts ?? [];
    assert.deepEqual([p?.position, p?.area, p?.offset, p?.template], ["page:0", "0,1,12,4", "0,0,0,-2", { offset: "0,-1,0,0" }]);
    assert.deepEqual(p?.items.map((g) => g.layout), ["0,0,2,1", "2,0,2,1", "4,0,2,1", "6,0,2,1", "0,5,2,1", "2,5,2,1", "4,5,2,1", "6,5,2,1"]);
    assert.ok(out.items.every((i) => i.break === undefined));
  });

  it("poster grids get band guards", () => {
    const out = gridEdges(tiles(8), POSTERS, { top: "shift", bottom: true });
    assert.ok((out.inserts ?? []).flatMap((p) => p.items).every((g) => g.color === undefined && /,0$/.test(g.offset ?? "")));
  });

  it("bottom only in a compressed root (search results under the keyboard): the insert decompressed, guards in 16×8 units", () => {
    const out = gridEdges(tiles(8), { ...LIST, scale: 16 / 12 }, { bottom: true });
    const [end] = out.inserts ?? [];
    assert.deepEqual([end?.position, end?.area, end?.decompress], ["context:end", "0,0,12,4", true]);
    assert.deepEqual(end?.items.map((g) => g.layout), ["0,5,3,1", "3,5,3,1"]);
    assert.equal(out.items[6]?.break, "context:end");
  });

  it("several rows per page (folders 4×2 in 16×8): the top insert takes three rows, the end insert the rest that fit", () => {
    const g: Grid = { width: 16, height: 8, w: 4, h: 2 };
    const out = gridEdges(tiles(4 * 5), g, { top: "shift", bottom: true });
    const [top, end] = out.inserts ?? [];
    assert.equal(top?.area, "0,1,16,7");
    assert.deepEqual([end?.area, out.items.findIndex((i) => i.break !== undefined)], ["0,0,16,4", 12]);
    assert.deepEqual(end?.items.map((x) => x.layout), ["0,4,4,1", "4,4,4,1", "8,4,4,1", "12,4,4,1"]);
  });

  it("overlay: the first row is a group caption — the guard sits in its cell above the first focusable row, nothing shifts", () => {
    const g: Grid = { width: 12, height: 6, w: 12, h: 1 };
    const items: MsxContentItem[] = [{ type: "space" }, { id: "s_a" }, { id: "s_b" }, ...Array.from({ length: 10 }, (_, i) => ({ id: `s${i}` }))];
    const out = gridEdges(items, g, { top: "overlay", bottom: true });
    const [top, end] = out.inserts ?? [];
    assert.deepEqual([top?.position, top?.area, top?.offset, top?.template], ["page:0", "0,0,12,6", undefined, undefined]);
    assert.deepEqual(top?.items, [guard({ id: "s_a", x: 0, y: 1, w: 12, h: 1 }, 0)]);
    assert.deepEqual([end?.area, targets(end?.items)], ["0,0,12,5", ["focus:s9"]]);
    assert.equal(out.items.findIndex((i) => i.break !== undefined), 8);
  });
});
