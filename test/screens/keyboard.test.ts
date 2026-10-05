import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { SearchState } from "../../src/app/context.ts";
import type { MsxContentItem, MsxContentPage } from "../../src/msx/types.ts";
import { DIGITS, KEY_CHARS, LAYOUTS, keyboardPage } from "../../src/screens/keyboard.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

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

const state = (over: Partial<SearchState> = {}): SearchState => ({
  query: "", lang: "ru", items: [], page: 0, totalPages: 0, done: false, seq: 0, status: "idle", ...over,
});

const input = (ch: string): string => `interaction:commit:message:search:input:${ch}`;
const control = (c: string): string => `interaction:commit:message:search:control:${c}`;
const box = (i: MsxContentItem): number[] => (i.layout ?? "").split(",").map(Number);
const isLetter = (i: MsxContentItem): boolean => i.type === "button" && !DIGITS.includes(i.label ?? "") && box(i)[2] === 1;
const letters = (p: MsxContentPage): MsxContentItem[] => p.items.filter(isLetter);
const digits = (p: MsxContentPage): MsxContentItem[] => p.items.filter((i) => i.key !== undefined && DIGITS.includes(i.key));
const controls = (p: MsxContentPage): MsxContentItem[] => p.items.filter((i) => i.type === "button" && box(i)[2] === 4);
const inputRow = (p: MsxContentPage): MsxContentItem => {
  const row = p.items.find((i) => i.layout === "0,0,16,1");
  assert.ok(row !== undefined, "input row");
  return row;
};

describe("LAYOUTS (decision Р-13)", () => {
  it("RU: 33 letters in alphabetical order, EN: 26, digits 1…0, no duplicates", () => {
    assert.equal(LAYOUTS.ru, "абвгдеёжзийклмнопрстуфхцчшщъыьэюя");
    assert.equal(LAYOUTS.en, "abcdefghijklmnopqrstuvwxyz");
    assert.equal(DIGITS, "1234567890");
    assert.equal(new Set(KEY_CHARS).size, 33 + 26 + 10);
  });
});

describe("keyboardPage (S7, spec §3.4)", () => {
  it("RU: 33 letter buttons in 3 rows of 11, each commits search:input:<letter>", async () => {
    const t = await make();
    const page = keyboardPage(t.ctx, state());
    const ru = letters(page);
    assert.equal(ru.length, 33);
    assert.deepEqual(ru.map((i) => i.label).join(""), LAYOUTS.ru);
    ru.forEach((i, n) => {
      assert.equal(i.layout, `${n % 11},${1 + Math.floor(n / 11)},1,1`);
      assert.equal(i.action, input(LAYOUTS.ru[n]));
    });
  });

  it("EN: 26 letter buttons in rows of 9, 9 and 8", async () => {
    const t = await make();
    const en = letters(keyboardPage(t.ctx, state({ lang: "en" })));
    assert.equal(en.length, 26);
    assert.deepEqual(en.map((i) => i.label).join(""), LAYOUTS.en);
    assert.deepEqual(en.map((i) => i.action), [...LAYOUTS.en].map(input));
    const rows = [1, 2, 3].map((y) => en.filter((i) => box(i)[1] === y).length);
    assert.deepEqual(rows, [9, 9, 8]);
    assert.deepEqual(en.slice(0, 9).map((i) => box(i)[0]), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("digits 1…0 in row 4 with remote keys 0–9 in both layouts", async () => {
    const t = await make();
    for (const lang of ["ru", "en"] as const) {
      const ds = digits(keyboardPage(t.ctx, state({ lang })));
      assert.deepEqual(ds.map((i) => [i.layout, i.label, i.key, i.action]),
        [...DIGITS].map((d, x) => [`${x},4,1,1`, d, d, input(d)]));
    }
  });

  it("controls on the right: erase (Delete key), space, clear, RU/EN with stable ids", async () => {
    const t = await make();
    for (const lang of ["ru", "en"] as const) {
      const cs = controls(keyboardPage(t.ctx, state({ lang })));
      assert.deepEqual(cs.map((i) => [i.id, i.layout, i.action]), [
        ["k_back", "12,1,4,1", control("back")],
        ["k_space", "12,2,4,1", control("space")],
        ["k_clear", "12,3,4,1", control("clear")],
        ["k_lang", "12,4,4,1", control("lang")],
      ]);
      assert.equal(cs[0].key, "delete");
      assert.ok(cs.every((i) => (i.label ?? "") !== ""));
    }
  });

  it("all items stay inside the 16×8 grid and do not overlap", async () => {
    const t = await make();
    for (const lang of ["ru", "en"] as const) {
      const page = keyboardPage(t.ctx, state({ lang }));
      const taken = new Set<string>();
      for (const i of page.items) {
        const [x, y, w, h] = box(i);
        assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 16 && y + h <= 8, `${lang} ${i.layout}`);
        for (let cx = x; cx < x + w; cx++) {
          for (let cy = y; cy < y + h; cy++) {
            assert.ok(!taken.has(`${cx},${cy}`), `${lang}: ${i.layout} overlaps at ${cx},${cy}`);
            taken.add(`${cx},${cy}`);
          }
        }
      }
      assert.equal(page.items.length, 1 + LAYOUTS[lang].length + 10 + 4);
    }
  });

  it("the input row shows the query with a cursor and the state hint", async () => {
    const t = await make();
    const row = (over: Partial<SearchState>): string | undefined => {
      const r = inputRow(keyboardPage(t.ctx, state(over)));
      assert.equal(r.type, "space");
      return r.headline;
    };
    assert.equal(row({}), "{ico:search} _ {col:msx-white-soft}· Наберите название");
    assert.equal(row({ query: "м", status: "short" }), "{ico:search} м_ {col:msx-white-soft}· Минимум 2 символа");
    assert.equal(row({ query: "мат", status: "loading" }), "{ico:search} мат_ {col:msx-white-soft}· Ищу…");
    assert.equal(row({ query: "мат", status: "empty" }), "{ico:search} мат_ {col:msx-white-soft}· Ничего не найдено");
    assert.equal(row({ query: "фи", status: "ready", items: [], totalPages: 6 }), "{ico:search} фи_ {col:msx-white-soft}· Найдено: 0");
    assert.equal(row({ query: "фи", status: "error", error: "KP-NET" }),
      "{ico:search} фи_ {col:msx-white-soft}· Нет связи с KinoPub. Проверьте VPN (KP-NET)");
  });

  it("«Найдено» takes the API total when the screen knows it", async () => {
    const t = await make();
    const s = Object.assign(state({ query: "фи", status: "ready" }), { total: 263 });
    assert.equal(inputRow(keyboardPage(t.ctx, s)).headline, "{ico:search} фи_ {col:msx-white-soft}· Найдено: 263");
  });

  it("the keyboard page JSON is light: ≤ 6 KB in both layouts (it is redrawn on every key)", async () => {
    const t = await make();
    for (const lang of ["ru", "en"] as const) {
      const bytes = Buffer.byteLength(JSON.stringify(keyboardPage(t.ctx, state({ lang, query: "абвгдеёжзийклмнопрстуфхцчшщъыьэ" }))), "utf8");
      assert.ok(bytes <= 6 * 1024, `${lang}: ${bytes} bytes`);
    }
  });
});
