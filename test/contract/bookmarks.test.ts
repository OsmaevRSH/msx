import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { cacheKeys } from "../../src/cache/repo.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { encodeListKey, ids } from "../../src/router/ids.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";
import { actions, commit, follow, pick, until } from "./rig.ts";

// Закладки сквозным путём (QA-NAV-1): «Закладки» → папка, карточка → ☆ → строка панели, снова папка — только по действиям
// из ответов экранов, как это сделал бы MSX.

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

const A12 = FIX.MOVIE_AUDIO12;
const FOLDER = encodeListKey({ src: "folder", folder: 1 });
const tileIds = (s: MsxContentRoot): string[] => (s.items ?? []).map((i) => i.id ?? "").filter((id) => /^i\d+$/.test(id));

/** «Закладки» → плитка папки «Избранное» → её список. */
async function openFolder(t: TestApp): Promise<{ tile: MsxContentItem; list: MsxContentRoot }> {
  const bm = (await t.request(ids.bookmarks())) as MsxContentRoot;
  const tile = pick(bm.items, (i) => i.id === "f1", "the tile of «Избранное»");
  return { tile, list: (await t.request(follow(tile.action, "content"))) as MsxContentRoot };
}

/** Карточка → ☆ → строка панели закладок `label`; ждать, пока плагин ответит действием MSX. */
async function star(t: TestApp, id: number, label: string): Promise<void> {
  const card = (await t.request(ids.item(id))) as MsxContentRoot;
  const button = pick(card.pages?.[0]?.items, (i) => i.id === "b_bm", "☆ on the card");
  const panel = (await t.request(follow(button.action, "panel"))) as MsxContentRoot;
  const row = pick(panel.items, (i) => i.label === label, label);
  t.host.clearActions();
  commit(t, row.action);
  await t.run(until(() => actions(t).length > 0));
}

describe("bookmarks: ☆ on a card and the folder list (QA-NAV-1)", () => {
  it("the folder shows a title added by ☆ and drops a removed one, though its list was in memory and in the cache", async () => {
    const t = await createTestApp({ loggedIn: true });
    apps.push(t);
    const before = await openFolder(t);
    assert.equal(before.tile.text, "2 шт.");
    assert.equal(tileIds(before.list).length, 2);
    assert.ok(!tileIds(before.list).includes(`i${A12}`));
    assert.ok(t.ctx.state.lists.has(FOLDER), "the folder list is in memory");
    assert.ok(t.ctx.cache.peek(cacheKeys.list({ kind: "folder", folder: 1 }, 1)) !== undefined, "and in the cache");

    await star(t, A12, "☆ Избранное — добавить");
    assert.ok(t.mock.state.folders.get(1)?.items.includes(A12));
    const added = await openFolder(t);
    assert.equal(added.tile.text, "3 шт.");
    assert.ok(tileIds(added.list).includes(`i${A12}`), JSON.stringify(tileIds(added.list)));
    assert.equal(tileIds(added.list).length, 3);
    assert.match(added.list.extension ?? "", /3 шт\.$/);

    await star(t, A12, "{ico:check} Избранное — убрать");
    const removed = await openFolder(t);
    assert.equal(removed.tile.text, "2 шт.");
    assert.ok(!tileIds(removed.list).includes(`i${A12}`), JSON.stringify(tileIds(removed.list)));
    assert.equal(tileIds(removed.list).length, 2);
  });
});
