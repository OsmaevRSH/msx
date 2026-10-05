import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import type { Flags } from "../../src/config/flags.ts";
import { commitMsg, contentAction, panelAction, resolveAction } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { encodeListKey, ids, msgs } from "../../src/router/ids.ts";
import { itemHash, itemRefreshSpec, itemScreen, onItemAct } from "../../src/screens/item.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { watchKey } from "../../tools/kpmock/state.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

const P = TEST_P;
const BIG = FIX.SERIAL_BIG;
const mid = (item: number, ordinal: number): number => item * 1000 + ordinal;
const LINKS_PATH = "/v1/items/media-links";
const ELEVEN_MIN = 11 * 60_000;

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(flags: Partial<Flags> = {}): Promise<TestApp> {
  const t = await createTestApp({ loggedIn: true, flags });
  apps.push(t);
  return t;
}

const open = async (t: TestApp, id: number): Promise<MsxContentRoot> => (await t.request(ids.item(id))) as MsxContentRoot;
const items = (s: MsxContentRoot): MsxContentItem[] => s.pages?.[0]?.items ?? [];
const el = (s: MsxContentRoot, id: string): MsxContentItem => {
  const found = items(s).find((i) => i.id === id);
  assert.ok(found, `no element ${id}`);
  return found;
};
const options = (s: MsxContentRoot): { label?: string; action?: string }[] =>
  (s.options?.items ?? []).map((i) => ({ label: i.label, action: i.action }));
const actions = (t: TestApp): string[] => t.host.actions.map((a) => a.action);
const logged = (t: TestApp, msg: string): number => t.ctx.log.entries().filter((e) => e.tag === "item" && e.msg === msg).length;
const linkCalls = (t: TestApp, m: number): number =>
  t.mock.calls().filter((c) => c.path === LINKS_PATH && new URLSearchParams(c.query).get("mid") === String(m)).length;
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");

/** Фоновая работа идёт в реальном времени; поддельные часы не двигаются. */
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await realSleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("itemScreen: serial SERIAL_BIG (S8)", () => {
  it("main button continues S1E4 by resolve, second opens the season of the target", async () => {
    const t = await make();
    const s = await open(t, BIG);
    assert.equal(s.type, "pages");
    assert.equal(s.flag, "item_2001");
    assert.equal(s.cache, false);
    const main = el(s, "b_main");
    assert.equal(main.type, "button");
    assert.equal(main.layout, "3,4,3,1");
    assert.equal(main.label, "▶ Продолжить S1E4");
    assert.equal(main.focus, true);
    assert.equal(main.action, `video:resolve:request:interaction:play:2001:continue@${P}`);
    assert.equal(main.properties, undefined);
    const second = el(s, "b_second");
    assert.equal(second.label, "Сезоны");
    assert.equal(second.layout, "6,4,3,1");
    assert.equal(second.action, contentAction(P, ids.season(BIG, 1)));
  });

  it("poster, description, bookmarks, similar and the audio/quality/subtitles row for the target unit", async () => {
    const t = await make();
    const s = await open(t, BIG);
    const poster = items(s).find((i) => i.layout === "0,0,3,5");
    assert.equal(poster?.type, "space");
    assert.equal(poster?.imageFiller, "fit");
    assert.match(poster?.image ?? "", /big/);
    const about = items(s).find((i) => i.layout === "3,0,9,4");
    assert.equal(about?.headline, "Тестовый сериал «Большой»");
    assert.match(about?.text ?? "", /^\d{4} · .+{br}КП \d,\d · IMDb \d,\d · \d+ мин{br}{br}Синтетическое описание тайтла 2001/);

    assert.equal(el(s, "b_bm").label, "★ В закладках");
    assert.equal(el(s, "b_bm").layout, "9,4,3,1");
    assert.equal(el(s, "b_bm").action, panelAction(P, ids.panel("bookmarks", BIG)));
    assert.equal(el(s, "b_similar").layout, "0,5,3,1");
    assert.equal(el(s, "b_similar").action, contentAction(P, ids.list(encodeListKey({ src: "similar", id: BIG }))));

    const unit = mid(BIG, 4);
    assert.equal(el(s, "b_audio").label, "Озвучка: Студия Бета");
    assert.equal(el(s, "b_audio").action, panelAction(P, ids.panel("audio", BIG, unit, "c")));
    assert.equal(el(s, "b_quality").label, "Качество: 1080p");
    assert.equal(el(s, "b_quality").action, panelAction(P, ids.panel("quality", BIG, unit, "c")));
    assert.equal(el(s, "b_subs").label, "Субтитры: выкл");
    assert.equal(el(s, "b_subs").action, panelAction(P, ids.panel("subs", BIG, unit, "c")));
  });

  it("subtitle and audio labels follow TV preferences", async () => {
    const t = await make();
    t.ctx.prefs.update({ subsLang: "rus", audioLang: "eng" });
    const s = await open(t, BIG);
    assert.equal(el(s, "b_subs").label, "Субтитры: RUS");
    assert.equal(el(s, "b_audio").label, "Озвучка: Оригинал");
  });

  it("options of a serial: stream mode and refresh, no watched toggle", async () => {
    const t = await make();
    const s = await open(t, BIG);
    assert.deepEqual(options(s), [
      { label: "Режим потока", action: panelAction(P, ids.panel("mode", BIG)) },
      { label: "Обновить", action: commitMsg(msgs.act("item", "refresh", BIG)) },
    ]);
  });

  it("prefetches media-links of the «Continue» unit in the background", async () => {
    const t = await make();
    await open(t, BIG);
    await until(() => linkCalls(t, mid(BIG, 4)) === 1, "background media-links of S1E4");
  });

  it("JSON of the card is at most 20 KB (CNFR-16)", async () => {
    const t = await make();
    assert.ok(bytes(await open(t, BIG)) <= 20 * 1024);
    assert.ok(bytes(await open(t, FIX.MOVIE_AUDIO12)) <= 20 * 1024);
  });

  it("the overlay newer than the card moves «Continue» at once", async () => {
    const t = await make();
    await t.run(t.ctx.repo.item(BIG));
    await t.clock.advance(1000);
    t.ctx.overlay.set(BIG, 1, 4, { time: 2440, status: 1 });
    assert.equal(el(await open(t, BIG), "b_main").label, "▶ S1E5");
  });
});

describe("itemScreen: films", () => {
  it("MOVIE_SIMPLE: continue from the resume position, «С начала» by resolve, watched toggle in options", async () => {
    const t = await make();
    const s = await open(t, FIX.MOVIE_SIMPLE);
    assert.equal(el(s, "b_main").label, "▶ Продолжить 19:57");
    assert.equal(el(s, "b_second").label, "С начала");
    assert.equal(el(s, "b_second").action, resolveAction(P, ids.playStart(FIX.MOVIE_SIMPLE)));
    assert.deepEqual(options(s)[0], {
      label: "Отметить просмотренным", action: commitMsg(msgs.act("item", "watched", FIX.MOVIE_SIMPLE, 0, 1, 1)),
    });
    assert.equal(options(s).length, 3);
  });

  it("MOVIE_MULTI: «Части» opens the parts as season 1; not in bookmarks", async () => {
    const t = await make();
    const s = await open(t, FIX.MOVIE_MULTI);
    assert.equal(el(s, "b_main").label, "▶ Смотреть");
    assert.equal(el(s, "b_second").label, "Части");
    assert.equal(el(s, "b_second").action, contentAction(P, ids.season(FIX.MOVIE_MULTI, 1)));
    assert.equal(el(s, "b_bm").label, "☆ В закладки");
  });

  it("MOVIE_DELETED → error screen KP-404", async () => {
    const t = await make();
    const s = await open(t, FIX.MOVIE_DELETED);
    assert.equal(s.flag, undefined);
    assert.match(items(s)[0]?.text ?? "", /Код: KP-404$/);
  });

  it("card backgrounds: posters.wide when enabled", async () => {
    const t = await make();
    assert.equal((await open(t, FIX.MOVIE_SIMPLE)).background, undefined);
    t.ctx.prefs.update({ cardBackgrounds: true });
    assert.match(String((await open(t, FIX.MOVIE_SIMPLE)).background), /wide/);
  });
});

describe("itemScreen: player properties in the item (playerPropsIn: item, Р-18)", () => {
  it("main and «С начала» carry explicit properties of their units", async () => {
    const t = await make({ playerPropsIn: "item" });
    const s = await open(t, BIG);
    const p = el(s, "b_main").properties ?? {};
    assert.equal(p["kp:m"], String(mid(BIG, 4)));
    assert.equal(p["kp:e"], "4");
    assert.equal(p["button:next:action"], resolveAction(P, ids.playEp(BIG, mid(BIG, 5), 1, 5)));
    assert.equal(el(s, "b_second").properties, undefined);

    const film = await open(t, FIX.MOVIE_MULTI);
    assert.equal(el(film, "b_main").properties?.["kp:m"], String(mid(FIX.MOVIE_MULTI, 1)));
    const simple = await open(t, FIX.MOVIE_SIMPLE);
    assert.equal(el(simple, "b_second").properties?.["kp:m"], String(mid(FIX.MOVIE_SIMPLE, 1)));
    assert.equal(el(simple, "b_second").properties?.["trigger:complete"], "player:eject");
  });
});

describe("itemScreen: conditional refresh of a stale card (спец. §6.3)", () => {
  it("a fresh card schedules nothing, a stale one schedules item_2001", async () => {
    const t = await make();
    await open(t, BIG);
    assert.equal(logged(t, "refresh scheduled item_2001"), 0);
    await t.clock.advance(ELEVEN_MIN);
    await open(t, BIG);
    assert.equal(logged(t, "refresh scheduled item_2001"), 1);
  });

  it("recompute reloads the card and changes the hash only when the personal part changed", async () => {
    const t = await make();
    await t.run(t.ctx.repo.item(BIG));
    const hashNow = (): string => {
      const got = t.ctx.repo.peekItem(BIG);
      assert.ok(got);
      return itemHash(t.ctx, got.value, got.fetchedAt);
    };
    const before = hashNow();
    await t.clock.advance(ELEVEN_MIN);
    assert.equal(await t.run(itemRefreshSpec(t.ctx, BIG, before).recompute()), before);

    t.mock.state.watching.set(watchKey(BIG, 1, 4), { time: 2440, status: 1, updated: 0 });
    await t.clock.advance(ELEVEN_MIN);
    const spec = itemRefreshSpec(t.ctx, BIG, before);
    assert.equal(spec.flag, "item_2001");
    assert.equal(spec.dataId, ids.item(BIG));
    const after = await t.run(spec.recompute());
    assert.notEqual(after, before);
    assert.equal(after, hashNow());
  });
});

describe("onItemAct", () => {
  it("watched: reconciles and toggles in KinoPub, overlay at once, reload of the current card", async () => {
    const t = await make();
    await open(t, FIX.MOVIE_SIMPLE);
    await t.clock.advance(5000);
    await t.run(onItemAct(t.ctx, "watched", [String(FIX.MOVIE_SIMPLE), "0", "1", "1"]));
    assert.equal(t.mock.state.watching.get(watchKey(FIX.MOVIE_SIMPLE, 0, 1))?.status, 1);
    assert.deepEqual(actions(t), ["reload:content"]);
    const s = await open(t, FIX.MOVIE_SIMPLE);
    assert.equal(options(s)[0]?.label, "Снять отметку");
    assert.equal(options(s)[0]?.action, commitMsg(msgs.act("item", "watched", FIX.MOVIE_SIMPLE, 0, 1, 0)));
    assert.equal(el(s, "b_main").label, "▶ Смотреть снова");
  });

  it("watched from the season screen of the same title reloads it; another screen is not touched", async () => {
    const t = await make();
    await t.request(ids.season(BIG, 1));
    await t.run(onItemAct(t.ctx, "watched", [String(BIG), "1", "5", "1"]));
    assert.deepEqual(actions(t), ["reload:content"]);

    t.host.clearActions();
    await t.request(ids.item(FIX.MOVIE_SIMPLE));
    await t.run(onItemAct(t.ctx, "watched", [String(BIG), "1", "6", "1"]));
    assert.equal(t.mock.state.watching.get(watchKey(BIG, 1, 6))?.status, 1);
    assert.deepEqual(actions(t), []);
  });

  it("watched with malformed arguments sends nothing", async () => {
    const t = await make();
    await t.run(onItemAct(t.ctx, "watched", [String(BIG), "1", "x", "1"]));
    assert.equal(t.mock.calls().length, 0);
  });

  it("refresh reloads the card from KinoPub and redraws it", async () => {
    const t = await make();
    const s = await open(t, BIG);
    assert.equal(el(s, "b_main").label, "▶ Продолжить S1E4");
    t.mock.state.watching.set(watchKey(BIG, 1, 4), { time: 2440, status: 1, updated: 0 });
    await t.run(onItemAct(t.ctx, "refresh", [String(BIG)]));
    assert.deepEqual(actions(t), ["reload:content"]);
    assert.equal(el(await open(t, BIG), "b_main").label, "▶ S1E5");
  });

  it("itemScreen is the router target of item:<id>", async () => {
    const t = await make();
    const direct = await t.run(itemScreen(t.ctx, BIG));
    assert.equal(direct.flag, "item_2001");
  });
});
