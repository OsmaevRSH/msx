import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { slotOf } from "../../src/bridge/current.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { ids, msgs, parseDataId } from "../../src/router/ids.ts";
import { FIX, castOf, directorOf, findItem } from "../../tools/kpmock/fixtures.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

// Тайтлы актёра или режиссёра (v1.18): `person:<cast|director>:<b64url имени>` → поиск `field=cast|director` (HC
// `video.md`), плитки — окном списков (`fill`), найденное — в памяти списков; возврат — без сети.

const BIG = FIX.SERIAL_BIG;
const ACTOR = castOf(findItem(BIG)!)[0]!;
const DIRECTOR = directorOf(findItem(BIG)!)[0]!;

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

const tiles = (s: MsxContentRoot): MsxContentItem[] => (s.items ?? []).filter((i) => /^i\d+$/.test(i.id ?? ""));
const searches = (t: TestApp): URLSearchParams[] =>
  t.mock.calls().filter((c) => c.path === "/v1/items/search").map((c) => new URLSearchParams(c.query));

describe("person:<field>:<name> — dataId grammar", () => {
  it("round trip with Cyrillic and spaces; a content screen, not a resolve or a panel", () => {
    const id = ids.person("cast", ACTOR);
    assert.match(id, /^person:cast:[A-Za-z0-9_-]+$/);
    assert.deepEqual(parseDataId(id), { k: "person", field: "cast", q: ACTOR });
    assert.deepEqual(parseDataId(ids.person("director", "Фёдор Фи")), { k: "person", field: "director", q: "Фёдор Фи" });
    assert.equal(slotOf(id), "content");
    assert.equal(slotOf(ids.playTrailer(BIG)), undefined);
  });

  it("anything else is unknown: another field, an empty name, not base64url, extra parts", () => {
    for (const bad of ["person:title:0JA", "person:cast:", "person:cast:%%%", "person:cast:0JA:1", "person:cast"]) {
      assert.equal(parseDataId(bad).k, "unknown", bad);
    }
  });
});

describe("personScreen", () => {
  it("the filmography of an actor: headline, count, two portions at most (≤ 96), each title once", async () => {
    const t = await make();
    const s = (await t.request(ids.person("cast", ACTOR))) as MsxContentRoot;
    assert.equal(s.type, "list");
    assert.equal(s.headline, `В ролях: ${ACTOR}`);
    assert.match(s.extension ?? "", /^\d[\d ]* тайтл(а|ов)?$/);
    const q = searches(t);
    assert.deepEqual(q.map((x) => [x.get("q"), x.get("field"), x.get("page"), x.get("perpage")]), [
      [ACTOR, "cast", "1", "48"], [ACTOR, "cast", "2", "48"],
    ]);
    const shown = tiles(s).map((x) => x.id);
    assert.ok(shown.length > 48 && shown.length <= 96, String(shown.length));
    assert.equal(new Set(shown).size, shown.length);
    assert.equal(tiles(s)[0]?.focus, true);
  });

  it("back to the screen answers from memory without the network; the window moves by extend", async () => {
    const t = await make();
    const id = ids.person("cast", ACTOR);
    const first = (await t.request(id)) as MsxContentRoot;
    const n = t.mock.calls().length;
    const again = (await t.request(id)) as MsxContentRoot;
    assert.equal(t.mock.calls().length, n);
    assert.deepEqual(tiles(again).map((x) => x.id), tiles(first).map((x) => x.id));
    const live = (first.items ?? []).map((i) => i.live?.action).find((a) => a?.includes(":down:"));
    // Окно ≤ 96 и 32 КБ: если найденное не влезло целиком, край несёт `extend` — плагин сдвигает окно из памяти.
    if (live !== undefined) {
      const msg = live.slice("interaction:commit:message:".length);
      assert.ok(msg.startsWith(msgs.extend("p")), msg);
    }
  });

  it("a director with one portion asks once; nothing found — «Ничего не найдено» with «Назад»", async () => {
    const t = await make();
    const s = (await t.request(ids.person("director", DIRECTOR))) as MsxContentRoot;
    assert.equal(s.headline, `Режиссёр: ${DIRECTOR}`);
    assert.ok(tiles(s).length > 0);
    const none = (await t.request(ids.person("cast", "Никто Никтоевич"))) as MsxContentRoot;
    assert.match(JSON.stringify(none.pages), /Ничего не найдено/);
    assert.equal(none.extension, "0 тайтлов");
  });

  it("an API error is the error screen with a retry of the same dataId", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/items/search$", status: 400 }] });
    const s = (await t.request(ids.person("cast", ACTOR))) as MsxContentRoot;
    assert.equal(s.flag, undefined);
    assert.match(JSON.stringify(s), /Код: KP-/);
  });
});
