import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MsxContentItem, MsxContentRoot, MsxResolveResponse } from "../../src/msx/types.ts";
import { sessionFromProps } from "../../src/progress/session.ts";
import { encodeListKey, ids } from "../../src/router/ids.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

// Сквозной путь Phase 1 «список → карточка → сезон → resolve» только по действиям из ответов экранов:
// каждое следующее dataId берётся из `action` предыдущего экрана, как это сделал бы MSX.

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

const SERIALS = encodeListKey({ src: "catalog", type: "serial", sort: "-updated" });

/** `content:…`/`video:resolve:…` с полным адресом плагина → dataId запроса. */
function follow(action: string | undefined, kind: "content" | "video:resolve"): string {
  const head = `${kind}:request:interaction:`;
  const tail = `@${TEST_P}`;
  const ok = action !== undefined && action.startsWith(head) && action.endsWith(tail);
  assert.ok(ok, `not a ${kind} action of the plugin: ${action}`);
  return action.slice(head.length, -tail.length);
}

const pick = (list: MsxContentItem[] | undefined, pred: (i: MsxContentItem) => boolean, what: string): MsxContentItem => {
  const found = list?.find(pred);
  assert.ok(found, `no ${what}`);
  return found;
};

describe("browse path: list → card → season → resolve", () => {
  it("a tile of «Сериалы» leads to a playable «Продолжить» with kp:* properties", async () => {
    const t = await createTestApp({ loggedIn: true });
    apps.push(t);

    const list = (await t.request(ids.list(SERIALS))) as MsxContentRoot;
    assert.equal(list.items?.length, 48);
    const tile = list.items[0];
    const itemId = follow(tile.action, "content");
    assert.equal(itemId, ids.item(Number(tile.kid)));

    const card = (await t.request(itemId)) as MsxContentRoot;
    assert.equal(card.flag, `item_${tile.kid}`);
    assert.equal(t.ctx.current.get(), itemId);
    const cardItems = card.pages?.[0]?.items;
    const main = pick(cardItems, (i) => i.id === "b_main", "main button");
    assert.equal(main.focus, true);
    const seasons = pick(cardItems, (i) => i.id === "b_second", "second button");
    assert.equal(seasons.label, "Сезоны");

    const seasonId = follow(seasons.action, "content");
    const season = (await t.request(seasonId)) as MsxContentRoot;
    assert.match(season.flag ?? "", new RegExp(`^ep_${tile.kid}_\\d+$`));
    const focused = pick(season.items, (i) => i.focus === true, "focused episode");

    const res = (await t.request(follow(main.action, "video:resolve"))) as MsxResolveResponse;
    assert.equal(res.error, undefined);
    assert.match(res.url ?? "", /^https?:\/\/.+\.m3u8/);
    const props = res.properties ?? {};
    const session = sessionFromProps(props, t.clock.now());
    assert.ok(session, `kp:* do not make a session: ${JSON.stringify(props)}`);
    assert.equal(session.itemId, Number(tile.kid));
    assert.equal(`e${session.mid}`, focused.id, "«Продолжить» plays the episode focused on the season screen");
    assert.equal(props["kp:s"], String(session.season));
    assert.ok(session.duration > 0);

    // Плитка серии в фокусе запускает ту же единицу; resolve не меняет текущий экран (CD-16).
    const same = (await t.request(follow(focused.action, "video:resolve"))) as MsxResolveResponse;
    assert.equal(same.properties?.["kp:m"], props["kp:m"]);
    assert.equal(t.ctx.current.get(), seasonId);
    assert.equal(t.fetch.preflights, 0);
  });
});
