import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ItemSummary, ItemType } from "../../src/api/models.ts";
import type { SearchState } from "../../src/app/context.ts";
import type { MsxContentItem, MsxContentPage } from "../../src/msx/types.ts";
import { DIGITS, KEY_CHARS, LAYOUTS, keyboardPage, recentShown } from "../../src/screens/keyboard.ts";
import type { SearchView } from "../../src/screens/keyboard.ts";
import { rememberQuery } from "../../src/screens/recent.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
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

const state = (over: Partial<SearchView> = {}): SearchView => ({
  query: "", lang: "ru", items: [], page: 0, totalPages: 0, done: false, seq: 0, status: "idle", ...over,
});

const title = (id: number, over: Partial<ItemSummary> = {}): ItemSummary => ({
  id, type: "movie", subtype: "", title: `Фильм ${id} / Movie ${id}`, year: 2000 + (id % 20), genres: [], countries: [], quality: 1080,
  posters: { small: "", medium: "", big: "", wide: "" }, ...over,
});

const input = (ch: string): string => `interaction:commit:message:search:input:${ch}`;
const control = (c: string): string => `interaction:commit:message:search:control:${c}`;
const isGuard = (i: MsxContentItem): boolean => /^focus:/.test(String(i.selection?.action ?? ""));
const ROWS = { ru: 11, en: 9 } as const;
const box = (i: MsxContentItem): number[] => (i.layout ?? "").split(",").map(Number);
/** Клавиши — кнопки из шаблона страницы: без своего `type`. */
const isKey = (i: MsxContentItem): boolean => i.type === undefined && !isGuard(i);
const isLetter = (i: MsxContentItem): boolean => isKey(i) && i.key === undefined && box(i)[2] === 1;
const letters = (p: MsxContentPage): MsxContentItem[] => p.items.filter(isLetter);
const digits = (p: MsxContentPage): MsxContentItem[] => p.items.filter((i) => i.key !== undefined && DIGITS.includes(i.key));
const controls = (p: MsxContentPage): MsxContentItem[] => p.items.filter((i) => i.id?.startsWith("k_") === true);
const column = (p: MsxContentPage): MsxContentItem[] => p.items.filter((i) => /^s\d$/.test(i.id ?? ""));
const at = (p: MsxContentPage, layout: string): MsxContentItem => {
  const it = p.items.find((i) => i.layout === layout && !isGuard(i));
  assert.ok(it !== undefined, layout);
  return it;
};
/** V-28: поле запроса над буквами и подсказка справа: «<поле> | <подсказка>». */
const inputRow = (p: MsxContentPage): string => `${at(p, "0,0,11,1").headline ?? ""} | ${at(p, "11,0,5,1").text ?? ""}`;
const guardsOf = (p: MsxContentPage): (string | undefined)[][] =>
  p.items.filter(isGuard).map((g) => [g.layout, g.offset, String(g.selection?.action)]);

describe("LAYOUTS (decision Р-13)", () => {
  it("RU: 33 letters in alphabetical order, EN: 26, digits 1…0, no duplicates", () => {
    assert.equal(LAYOUTS.ru, "абвгдеёжзийклмнопрстуфхцчшщъыьэюя");
    assert.equal(LAYOUTS.en, "abcdefghijklmnopqrstuvwxyz");
    assert.equal(DIGITS, "1234567890");
    assert.equal(new Set(KEY_CHARS).size, 33 + 26 + 10);
  });
});

describe("keyboardPage (S7, spec §3.4)", () => {
  it("keys are buttons by the page template: no type of their own (the page is redrawn on every key)", async () => {
    const t = await make();
    const page = keyboardPage(t.ctx, state());
    assert.deepEqual(page.template, { type: "button" });
    assert.equal(letters(page).length + digits(page).length + controls(page).length, 33 + 10 + 4);
    assert.ok([...letters(page), ...digits(page), ...controls(page)].every((i) => i.type === undefined));
  });

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

  it("controls in a row under the digits: erase (Delete key), space, clear, layout with stable ids; the layout button names the current one (V-29)", async () => {
    const t = await make();
    for (const lang of ["ru", "en"] as const) {
      const cs = controls(keyboardPage(t.ctx, state({ lang })));
      assert.deepEqual(cs.map((i) => [i.id, i.layout, i.action]), [
        ["k_back", "0,5,3,1", control("back")],
        ["k_space", "3,5,2,1", control("space")],
        ["k_clear", "5,5,3,1", control("clear")],
        ["k_lang", "8,5,3,1", control("lang")],
      ]);
      assert.equal(cs[0].key, "delete");
      assert.ok(cs.every((i) => (i.label ?? "") !== ""));
      assert.equal(cs[3].label, `{ico:language} Раскладка: ${lang.toUpperCase()}`);
    }
  });

  it("all items stay inside the 16×8 grid and do not overlap (guards aside); the keyboard is 11 wide, the column 5", async () => {
    const t = await make();
    rememberQuery(t.ctx.store, "матрица");
    const hints = Array.from({ length: 6 }, (_, n) => title(1000 + n));
    const views: SearchView[] = [state(), state({ lang: "en" }), state({ query: "фи", status: "loading", hints }), state({ query: "фи", status: "ready", hints, items: hints })];
    for (const s of views) {
      const page = keyboardPage(t.ctx, s);
      const taken = new Set<string>();
      for (const i of page.items.filter((x) => !isGuard(x))) {
        const [x, y, w, h] = box(i);
        assert.ok(x >= 0 && y >= 0 && w > 0 && h > 0 && x + w <= 16 && y + h <= 8, `${s.lang} ${i.layout}`);
        if (isKey(i)) assert.ok(x + w <= 11, `key ${i.label} left of the column`);
        for (let cx = x; cx < x + w; cx++) {
          for (let cy = y; cy < y + h; cy++) {
            assert.ok(!taken.has(`${cx},${cy}`), `${s.lang}: ${i.layout} overlaps at ${cx},${cy}`);
            taken.add(`${cx},${cy}`);
          }
        }
      }
      for (const g of page.items.filter(isGuard)) assert.ok(box(g)[1] <= 7, `guard ${g.layout}: MSX rejects row 8 of 16×8`);
    }
  });

  it("guards above the top row and under the control row bring the focus back: no wrap-around (spec §11 S7)", async () => {
    const t = await make();
    for (const lang of ["ru", "en"] as const) {
      const page = keyboardPage(t.ctx, state({ lang }));
      const row = ROWS[lang];
      const top = Array.from({ length: row }, (_, x) => [`${x},0,1,1`, "0,1,0,-1", `focus:k${x}_1`]);
      const bottom = [["0,6,3,1", "k_back"], ["3,6,2,1", "k_space"], ["5,6,3,1", "k_clear"], ["8,6,3,1", "k_lang"]].map(([l, id]) => [l, "0,-1,0,-1", `focus:${id}`]);
      assert.deepEqual(guardsOf(page), [...top, ...bottom]);
      // После клавиш: номера клавиш не зависят от стражей, в ячейке 0,0 MSX регистрирует последний элемент.
      const first = page.items.findIndex(isGuard);
      assert.ok(first > 0 && page.items.slice(0, first).every((i) => !isGuard(i)) && page.items.slice(first).every(isGuard));
      assert.equal(page.items[2]?.label, LAYOUTS[lang][0], "the first letter right after the field: MSX focuses it on open");
      const keys = new Set(page.items.map((i) => i.id));
      for (const g of guardsOf(page)) assert.ok(keys.has(String(g[2]).slice("focus:".length)), String(g[2]));
    }
  });

  it("with results «down» from the control row and the column leads to them: no guards under them", async () => {
    const t = await make();
    const hints = [title(1), title(2)];
    const page = keyboardPage(t.ctx, state({ query: "фи", status: "ready", items: hints, hints }));
    assert.ok(page.items.filter(isGuard).every((g) => g.layout?.split(",")[1] === "0"));
    assert.deepEqual(page.items.at(-1), { type: "space", layout: "0,7,16,1", text: "{ico:arrow-downward} Результаты ниже" });
  });

  it("V-28: a glass field with the query and a cursor above the letters, the state hint above the column", async () => {
    const t = await make();
    const page = keyboardPage(t.ctx, state({ query: "мат", status: "loading" }));
    assert.deepEqual(at(page, "0,0,11,1"), { type: "space", layout: "0,0,11,1", color: "msx-glass", headline: "{ico:search} мат_" });
    assert.deepEqual(at(page, "11,0,5,1"), { type: "space", layout: "11,0,5,1", text: "Ищу…" });
    const row = (over: Partial<SearchView>): string => inputRow(keyboardPage(t.ctx, state(over)));
    assert.equal(row({}), "{ico:search} _ | Наберите название");
    assert.equal(row({ query: "м", status: "short" }), "{ico:search} м_ | Минимум 2 символа");
    assert.equal(row({ query: "", status: "short" }), "{ico:search} _ | Наберите название", "V-29: after «Очистить»");
    assert.equal(row({ query: " ", status: "short" }), "{ico:search}  _ | Наберите название");
    assert.equal(row({ query: "мат", status: "empty" }), "{ico:search} мат_ | Ничего не найдено");
    assert.equal(row({ query: "фи", status: "ready", items: [], totalPages: 6 }), "{ico:search} фи_ | Найдено: 0");
    assert.equal(row({ query: "фи", status: "error", error: "KP-NET" }), "{ico:search} фи_ | Нет связи с KinoPub. Проверьте VPN (KP-NET)");
  });

  it("«Найдено» takes the API total when the screen knows it", async () => {
    const t = await make();
    const s = state({ query: "фи", status: "ready", total: 263 });
    assert.equal(inputRow(keyboardPage(t.ctx, s)), "{ico:search} фи_ | Найдено: 263");
  });

  it("a cut result list: «Найдено» tells how many are shown and asks to refine the query", async () => {
    const t = await make();
    const s = state({ query: "фи", status: "ready", total: 263, shown: 96 });
    assert.equal(inputRow(keyboardPage(t.ctx, s)), "{ico:search} фи_ | Найдено: 263, показаны первые 96 — уточните запрос");
  });
});

describe("keyboardPage: the suggestion column (S7)", () => {
  it("up to 6 suggestions right of the letters: type icon, grey year before the Russian title, OK opens the card", async () => {
    const t = await make();
    const types: ItemType[] = ["movie", "serial", "documovie", "docuserial", "tvshow", "concert", "3D"];
    const hints = types.map((type, n) => title(1000 + n, { type }));
    const col = column(keyboardPage(t.ctx, state({ query: "фи", status: "ready", hints, items: hints })));
    assert.deepEqual(col.map((i) => [i.id, i.type, i.layout, i.icon]), [
      ["s0", "control", "11,1,5,1", "movie"], ["s1", "control", "11,2,5,1", "tv"], ["s2", "control", "11,3,5,1", "public"],
      ["s3", "control", "11,4,5,1", "public"], ["s4", "control", "11,5,5,1", "live-tv"], ["s5", "control", "11,6,5,1", "music-note"],
    ]);
    assert.equal(col[0].label, "{txt:msx-white-soft:2000} Фильм 1000");
    assert.deepEqual(col.map((i) => i.action), hints.slice(0, 6).map((h) => `content:request:interaction:item:${h.id}@${TEST_P}`));
  });

  it("no year — the title alone; a long title is cut to 30 characters with «…»", async () => {
    const t = await make();
    const long = "Очень длинное русское название, которое не влезет";
    const hints = [title(1, { year: undefined }), title(2, { title: `${long} / Very Long`, type: "3D" })];
    const col = column(keyboardPage(t.ctx, state({ query: "фи", status: "loading", hints })));
    assert.equal(col[0].label, "Фильм 1");
    assert.equal(col[1].label, `{txt:msx-white-soft:2002} ${long.slice(0, 29).trimEnd()}…`);
    assert.equal(col[1].icon, "3d-rotation");
  });

  it("guards above the first and under the last row of the column while there are no results below", async () => {
    const t = await make();
    const hints = [title(1), title(2), title(3)];
    const g = guardsOf(keyboardPage(t.ctx, state({ query: "фи", status: "loading", hints })));
    assert.deepEqual(g.filter((x) => x[0]?.startsWith("11,")), [["11,0,5,1", "0,1,0,-1", "focus:s0"], ["11,4,5,1", "0,-1,0,-1", "focus:s2"]]);
  });

  it("an empty field: the recent queries with a clock, OK sends its row number (not the text); the red-button hint under them", async () => {
    const t = await make();
    for (const q of ["тест", "матрица", "во все тяжкие"]) rememberQuery(t.ctx.store, q);
    const page = keyboardPage(t.ctx, state());
    const col = column(page);
    assert.deepEqual(col.map((i) => [i.id, i.type, i.layout, i.icon, i.label, i.action]), [
      ["s0", "control", "11,1,5,1", "history", "во все тяжкие", "interaction:commit:message:search:recent:0"],
      ["s1", "control", "11,2,5,1", "history", "матрица", "interaction:commit:message:search:recent:1"],
      ["s2", "control", "11,3,5,1", "history", "тест", "interaction:commit:message:search:recent:2"],
    ]);
    assert.deepEqual(at(page, "11,4,5,1"), { type: "space", layout: "11,4,5,1", text: "{ico:msx-red:stop} Очистить историю" });
    assert.deepEqual(guardsOf(page).filter((x) => x[0]?.startsWith("11,")), [["11,0,5,1", "0,1,0,-1", "focus:s0"], ["11,4,5,1", "0,-1,0,-1", "focus:s2"]]);
  });

  it("recent queries only while the field is empty or a picked one is still searched; suggestions win", async () => {
    const t = await make();
    rememberQuery(t.ctx.store, "матрица");
    assert.deepEqual(recentShown(t.ctx, state()), ["матрица"]);
    assert.deepEqual(recentShown(t.ctx, state({ query: "м", status: "short" })), []);
    assert.deepEqual(recentShown(t.ctx, state({ query: "матрица", status: "loading", recent: true })), ["матрица"]);
    assert.deepEqual(recentShown(t.ctx, state({ query: "матрица", status: "ready", recent: true, hints: [title(1)] })), []);
    assert.deepEqual(column(keyboardPage(t.ctx, state({ query: "мат", status: "loading" }))), []);
  });

  it("no recent queries — no column, no hint, no column guards", async () => {
    const t = await make();
    const page = keyboardPage(t.ctx, state());
    assert.deepEqual(column(page), []);
    assert.ok(page.items.every((i) => !String(i.text ?? "").includes("Очистить историю")));
    assert.ok(guardsOf(page).every((x) => !x[0]?.startsWith("11,")));
  });

  it("the keyboard screen is light: ≤ 8 KB with 6 long suggestions, a 32-letter query and the edge guards (redrawn on every key)", async () => {
    const t = await make();
    const name = "Щ".repeat(40);
    const hints = Array.from({ length: 6 }, (_, n) => title(100_000 + n, { title: `${name} / ${"W".repeat(40)}` }));
    for (let n = 0; n < 6; n++) rememberQuery(t.ctx.store, `${n}${"щ".repeat(31)}`);
    for (const lang of ["ru", "en"] as const) {
      for (const s of [state({ lang, query: "щ".repeat(32), status: "loading", hints }), state({ lang })]) {
        const bytes = Buffer.byteLength(JSON.stringify(keyboardPage(t.ctx, s)), "utf8");
        assert.ok(bytes <= 8 * 1024 - 300, `${lang}: ${bytes} bytes (the root around it is < 300)`);
      }
    }
  });
});
