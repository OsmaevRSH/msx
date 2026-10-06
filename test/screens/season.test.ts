import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import type { Flags } from "../../src/config/flags.ts";
import { fmtMinutes } from "../../src/core/format.ts";
import { commitMsg, panelAction, replaceContent, resolveAction } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { ids, msgs } from "../../src/router/ids.ts";
import { seasonHash, seasonLabel, seasonRefreshSpec } from "../../src/screens/season.ts";
import { FIX, findItem } from "../../tools/kpmock/fixtures.ts";
import { watchKey } from "../../tools/kpmock/state.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

const P = TEST_P;
const BIG = FIX.SERIAL_BIG;
const SMALL = FIX.SERIAL_SMALL;
const mid = (item: number, ordinal: number): number => item * 1000 + ordinal;
const LINKS_PATH = "/v1/items/media-links";
const ELEVEN_MIN = 11 * 60_000;
const NOP = "[]";

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

const open = async (t: TestApp, id: number, n: number): Promise<MsxContentRoot> =>
  (await t.request(ids.season(id, n))) as MsxContentRoot;
const eps = (s: MsxContentRoot): MsxContentItem[] => s.items ?? [];
const tabs = (s: MsxContentRoot): MsxContentItem[] => s.header?.items ?? [];
const ep = (s: MsxContentRoot, m: number): MsxContentItem => {
  const found = eps(s).find((i) => i.id === `e${m}`);
  assert.ok(found, `no episode e${m}`);
  return found;
};
const linkCalls = (t: TestApp, m: number): number =>
  t.mock.calls().filter((c) => c.path === LINKS_PATH && new URLSearchParams(c.query).get("mid") === String(m)).length;
const logged = (t: TestApp, msg: string): number => t.ctx.log.entries().filter((e) => e.tag === "item" && e.msg === msg).length;
const bytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v), "utf8");
const duration = (item: number, ordinal: number): number => {
  const unit = findItem(item)?.seasons?.flatMap((s) => s.episodes).find((e) => e.id === mid(item, ordinal));
  assert.ok(unit);
  return unit.duration;
};

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await realSleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("seasonScreen: SERIAL_BIG season 1 (S9)", () => {
  it("list 16×8 with the episode template and flag ep_2001_1", async () => {
    const t = await make();
    const s = await open(t, BIG, 1);
    assert.equal(s.type, "list");
    assert.equal(s.compress, true);
    assert.equal(s.flag, "ep_2001_1");
    assert.equal(s.cache, false);
    assert.equal(s.headline, "Тестовый сериал «Большой» · Сезон 1");
    assert.deepEqual(s.template, {
      type: "separate", layout: "0,0,4,3", color: "msx-glass", imageFiller: "cover", progress: -1, progressColor: "msx-blue",
      enumerate: false,
    });
    assert.equal(eps(s).length, 20);
  });

  it("E1–E3 watched with ✓, E4 with progress and focus, the rest without marks", async () => {
    const t = await make();
    const s = await open(t, BIG, 1);
    for (const e of [1, 2, 3]) {
      const it = ep(s, mid(BIG, e));
      assert.equal(it.badge, "✓");
      assert.equal(it.badgeColor, "msx-green");
      assert.equal(it.progress, undefined);
      assert.equal(it.focus, undefined);
    }
    const e4 = ep(s, mid(BIG, 4));
    assert.ok(Math.abs((e4.progress ?? -1) - 600 / duration(BIG, 4)) < 0.01, `progress ${e4.progress}`);
    assert.equal(e4.focus, true);
    assert.equal(e4.badge, undefined);
    const e5 = ep(s, mid(BIG, 5));
    assert.equal(e5.progress, undefined);
    assert.equal(e5.badge, undefined);
    assert.equal(eps(s).filter((i) => i.focus === true).length, 1);
  });

  it("episode element: title, duration, thumbnail, player label, resolve action and options", async () => {
    const t = await make();
    const s = await open(t, BIG, 1);
    const m4 = mid(BIG, 4);
    const e4 = ep(s, m4);
    assert.equal(e4.title, "4. Серия 4");
    assert.equal(e4.titleFooter, fmtMinutes(duration(BIG, 4)));
    assert.match(e4.image ?? "", /thumb/);
    assert.equal(e4.playerLabel, "Тестовый сериал «Большой» · 1 сезон, 4 серия");
    assert.equal(e4.action, resolveAction(P, ids.playEp(BIG, m4, 1, 4)));
    assert.equal(e4.properties, undefined);
    assert.deepEqual((e4.options?.items ?? []).map((i) => ({ label: i.label, action: i.action })), [
      { label: "Отметить просмотренной", action: commitMsg(msgs.act("item", "watched", BIG, 1, 4, 1)) },
      { label: "Смотреть с начала", action: resolveAction(P, ids.playEp(BIG, m4, 1, 4, { start: true })) },
    ]);
    assert.equal(ep(s, mid(BIG, 1)).options?.items?.[0]?.label, "Снять отметку");
    assert.equal(ep(s, mid(BIG, 1)).options?.items?.[0]?.action, commitMsg(msgs.act("item", "watched", BIG, 1, 1, 0)));
  });

  it("more than 8 seasons → one «Сезон N ▾» button opening the seasons panel", async () => {
    const t = await make();
    const s = await open(t, BIG, 1);
    assert.deepEqual(tabs(s).map((i) => ({ label: i.label, action: i.action, layout: i.layout })), [
      { label: "Сезон 1 ▾", action: panelAction(P, ids.panel("seasons", BIG, 1)), layout: "0,0,2,1" },
    ]);
  });

  it("season 2 continues in the next season: E1 has no marks and no focus", async () => {
    const t = await make();
    const s = await open(t, BIG, 2);
    assert.equal(s.flag, "ep_2001_2");
    assert.equal(ep(s, mid(BIG, 21)).title, "1. Серия 1");
    assert.equal(eps(s).filter((i) => i.focus === true).length, 0);
  });

  it("prefetches media-links of the first unwatched episode in the background", async () => {
    const t = await make();
    await open(t, BIG, 1);
    await until(() => linkCalls(t, mid(BIG, 4)) === 1, "background media-links of S1E4");
  });

  it("the overlay newer than the card marks E4 watched and moves the focus to E5", async () => {
    const t = await make();
    await t.run(t.ctx.repo.item(BIG));
    await t.clock.advance(1000);
    t.ctx.overlay.set(BIG, 1, 4, { time: 2440, status: 1 });
    const s = await open(t, BIG, 1);
    assert.equal(ep(s, mid(BIG, 4)).badge, "✓");
    assert.equal(ep(s, mid(BIG, 5)).focus, true);
  });

  it("JSON of a 20-episode season is at most 32 KB (CNFR-16)", async () => {
    const t = await make();
    assert.ok(bytes(await open(t, BIG, 1)) <= 32 * 1024);
  });
});

describe("seasonScreen: tabs, parts, errors", () => {
  it("SERIAL_SMALL: two tabs replace the screen flagged with the current season", async () => {
    const t = await make();
    const s = await open(t, SMALL, 1);
    assert.deepEqual(tabs(s).map((i) => ({ type: i.type, label: i.label, layout: i.layout, action: i.action })), [
      { type: "button", label: "Сезон 1 · 1/3", layout: "0,0,2,1", action: replaceContent("ep_2002_1", P, ids.season(SMALL, 1)) },
      { type: "button", label: "Сезон 2 · 0/3", layout: "2,0,2,1", action: replaceContent("ep_2002_1", P, ids.season(SMALL, 2)) },
    ]);
    assert.equal(tabs(s)[1]?.action, `replace:content:ep_2002_1:request:interaction:season:2002:2@${P}`);
    const s2 = await open(t, SMALL, 2);
    assert.equal(tabs(s2)[0]?.action, replaceContent("ep_2002_2", P, ids.season(SMALL, 1)));
    assert.equal(eps(s2).length, 3);
  });

  it("MOVIE_MULTI: parts as season 1 without tabs", async () => {
    const t = await make();
    const s = await open(t, FIX.MOVIE_MULTI, 1);
    assert.equal(s.flag, "ep_2003_1");
    assert.equal(s.headline, "Тестовый фильм «Из частей» · Части");
    assert.equal(s.header, undefined);
    assert.equal(eps(s).length, 3);
    const p1 = ep(s, mid(FIX.MOVIE_MULTI, 1));
    assert.equal(p1.title, "1. Часть 1");
    assert.equal(p1.playerLabel, "Тестовый фильм «Из частей» · Часть 1");
    assert.equal(p1.action, resolveAction(P, ids.playEp(FIX.MOVIE_MULTI, mid(FIX.MOVIE_MULTI, 1), 0, 1)));
    assert.equal(p1.focus, true);
    assert.equal(p1.options?.items?.[0]?.action, commitMsg(msgs.act("item", "watched", FIX.MOVIE_MULTI, 0, 1, 1)));
  });

  it("an unknown season or a deleted title → error screen KP-404", async () => {
    const t = await make();
    for (const s of [await open(t, BIG, 11), await open(t, FIX.MOVIE_MULTI, 2), await open(t, FIX.MOVIE_DELETED, 1)]) {
      assert.equal(s.flag, undefined);
      assert.match(s.pages?.[0]?.items[0]?.text ?? "", /Код: KP-404$/);
    }
  });

  it("seasonLabel counts watched episodes with the overlay", async () => {
    const t = await make();
    const got = await t.run(t.ctx.repo.item(SMALL));
    assert.equal(seasonLabel(t.ctx, got.value, got.fetchedAt, 1), "Сезон 1 · 1/3");
    await t.clock.advance(1000);
    t.ctx.overlay.set(SMALL, 1, 2, { time: 60, status: 1 });
    assert.equal(seasonLabel(t.ctx, got.value, got.fetchedAt, 1), "Сезон 1 · 2/3");
  });
});

describe("seasonScreen: player properties in the item (playerPropsIn: item, CDG-06, Р-18)", () => {
  it("template.properties via {context:…}, episode fields, last episode goes to the next season", async () => {
    const t = await make({ playerPropsIn: "item" });
    const s = await open(t, BIG, 1);
    const props = s.template?.properties ?? {};
    assert.equal(props["kp:m"], "{context:kmid}");
    assert.equal(props["button:next:action"], "{context:knextAction}");
    assert.equal(props["trigger:complete"], "{context:kcomplete}");
    const first = ep(s, mid(BIG, 1));
    assert.equal(first.kid, String(BIG));
    assert.equal(first.kmid, String(mid(BIG, 1)));
    assert.equal(first.ks, "1");
    assert.equal(first.ke, "1");
    assert.equal(first.kprevAction, NOP);
    const last = ep(s, mid(BIG, 20));
    assert.equal(last.knextAction, resolveAction(P, ids.playEp(BIG, mid(BIG, 21), 2, 1)));
    assert.equal(last.kn, "1");
    assert.ok(bytes(s) <= 32 * 1024, `season JSON ${bytes(s)} B`);

    const lastSeason = await open(t, BIG, 10);
    const end = ep(lastSeason, mid(BIG, 200));
    assert.equal(end.knextAction, NOP);
    assert.equal(end.kcomplete, "player:eject");
  });

  it("without the flag the template has no properties and episodes no context fields", async () => {
    const t = await make();
    const s = await open(t, BIG, 1);
    assert.equal(s.template?.properties, undefined);
    assert.equal(ep(s, mid(BIG, 1)).kmid, undefined);
  });
});

describe("seasonScreen: conditional refresh (спец. §6.3)", () => {
  it("a stale card schedules the refresh of ep_2001_1", async () => {
    const t = await make();
    await open(t, BIG, 1);
    assert.equal(logged(t, "refresh scheduled ep_2001_1"), 0);
    await t.clock.advance(ELEVEN_MIN);
    await open(t, BIG, 1);
    assert.equal(logged(t, "refresh scheduled ep_2001_1"), 1);
  });

  it("recompute changes the hash when an episode of the season changed in KinoPub", async () => {
    const t = await make();
    await t.run(t.ctx.repo.item(BIG));
    const hashNow = (n: number): string => {
      const got = t.ctx.repo.peekItem(BIG);
      assert.ok(got);
      return seasonHash(t.ctx, got.value, got.fetchedAt, n);
    };
    const s1 = hashNow(1);
    const s3 = hashNow(3);
    t.mock.state.watching.set(watchKey(BIG, 1, 5), { time: 900, status: 0, updated: 0 });
    await t.clock.advance(ELEVEN_MIN);
    const spec = seasonRefreshSpec(t.ctx, BIG, 1, s1);
    assert.equal(spec.flag, "ep_2001_1");
    assert.equal(spec.dataId, ids.season(BIG, 1));
    assert.notEqual(await t.run(spec.recompute()), s1);
    assert.equal(hashNow(3), s3);
  });
});
