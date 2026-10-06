import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import type { Flags } from "../../src/config/flags.ts";
import { fmtMinutes } from "../../src/core/format.ts";
import { commitMsg, panelAction, replaceContent, resolveAction } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { ids, msgs } from "../../src/router/ids.ts";
import { seasonHash, seasonLabel, seasonRefreshSpec, seasonTabLabel } from "../../src/screens/season.ts";
import { contextIssues } from "../../tools/crawl-rules.ts";
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
const isGuard = (i: MsxContentItem): boolean => /^focus:/.test(String(i.selection?.action ?? ""));
/** Вкладки сезонов — элементы шапки без стражей над ними (`msx/edges.ts`). */
const tabs = (s: MsxContentRoot): MsxContentItem[] => (s.header?.items ?? []).filter((i) => !isGuard(i));
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
  it("list 16×8 with the episode template and flag ep_2001_1; two full rows of 4×4 per screen (V-25)", async () => {
    const t = await make();
    const s = await open(t, BIG, 1);
    assert.equal(s.type, "list");
    assert.equal(s.compress, true);
    assert.equal(s.flag, "ep_2001_1");
    assert.equal(s.cache, false);
    assert.equal(s.headline, "Тестовый сериал «Большой» · Сезон 1 из 10");
    assert.deepEqual(s.template, {
      type: "separate", layout: "0,0,4,4", color: "msx-glass", imageFiller: "cover", progress: -1, progressColor: "msx-blue",
      enumerate: false,
    });
    assert.equal(eps(s).length, 20);
  });

  it("the season switch is visible: red-button hint «Сезоны», the red button opens the seasons panel (V-23)", async () => {
    const t = await make();
    const s = await open(t, BIG, 1);
    assert.equal(s.extension, "{ico:msx-red:stop} Сезоны");
    // Option Shortcut: MSX ищет `key` в опциях элемента в фокусе — пункт и у корня (вкладки), и у каждой серии.
    const seasons = { label: "Сезоны…", action: panelAction(P, ids.panel("seasons", BIG, 1)), key: "red" };
    assert.equal(s.options?.headline, "Тестовый сериал «Большой»");
    assert.deepEqual(s.options?.items, [seasons]);
    for (const e of eps(s)) assert.deepEqual(e.options?.items?.[0], seasons);
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
    assert.equal(e4.title, "Серия 4", "the mock title «Серия 4» is not repeated after the number (V-26)");
    assert.equal(e4.titleFooter, fmtMinutes(duration(BIG, 4)));
    assert.match(e4.image ?? "", /thumb/);
    assert.equal(e4.playerLabel, "Тестовый сериал «Большой» · 1 сезон, 4 серия");
    assert.equal(e4.action, resolveAction(P, ids.playEp(BIG, m4, 1, 4)));
    assert.equal(e4.properties, undefined);
    assert.deepEqual((e4.options?.items ?? []).slice(1).map((i) => ({ label: i.label, action: i.action })), [
      { label: "Отметить просмотренной", action: commitMsg(msgs.act("item", "watched", BIG, 1, 4, 1)) },
      { label: "Смотреть с начала", action: resolveAction(P, ids.playEp(BIG, m4, 1, 4, { start: true })) },
    ]);
    assert.equal(ep(s, mid(BIG, 1)).options?.items?.[1]?.label, "Снять отметку");
    assert.equal(ep(s, mid(BIG, 1)).options?.items?.[1]?.action, commitMsg(msgs.act("item", "watched", BIG, 1, 1, 0)));
  });

  it("more than 5 seasons → one «Сезон N ▾» button opening the seasons panel", async () => {
    const t = await make();
    const s = await open(t, BIG, 1);
    assert.deepEqual(tabs(s).map((i) => ({ label: i.label, action: i.action, layout: i.layout })), [
      { label: "Сезон 1 ▾", action: panelAction(P, ids.panel("seasons", BIG, 1)), layout: "0,1,3,1" },
    ]);
  });

  it("guards over the tabs and under the last row of episodes: no wrap-around at the edges of the season", async () => {
    const t = await make();
    const s = await open(t, SMALL, 1);
    // Вкладки стоят рядом ниже стражей и поднимаются на ряд; шапка той же высоты, что раньше.
    assert.equal(s.header?.offset, "0,0,0,-1");
    assert.deepEqual(tabs(s).map((i) => [i.id, i.layout, i.offset]), [["t_1", "0,1,3,1", "0,-1,0,0"], ["t_2", "3,1,3,1", "0,-1,0,0"]]);
    assert.deepEqual((s.header?.items ?? []).filter(isGuard).map((g) => [g.layout, g.selection?.action]), [["0,0,3,1", "focus:t_1"], ["3,0,3,1", "focus:t_2"]]);
    // Под последним рядом серий — вставка со стражами; над первым — вкладки, свои стражи не нужны.
    assert.deepEqual(s.inserts?.map((p) => [p.position, p.items.map((g) => g.selection?.action)]), [
      ["context:end", eps(s).map((e) => `focus:${e.id}`)],
    ]);
  });

  it("season 2 continues in the next season: E1 has no marks and no focus", async () => {
    const t = await make();
    const s = await open(t, BIG, 2);
    assert.equal(s.flag, "ep_2001_2");
    assert.equal(ep(s, mid(BIG, 21)).title, "Серия 1");
    assert.equal(s.headline, "Тестовый сериал «Большой» · Сезон 2 из 10");
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
  it("SERIAL_SMALL: two tabs 3 wide replace the screen flagged with the current season; the open one is ✓ (V-24)", async () => {
    const t = await make();
    const s = await open(t, SMALL, 1);
    assert.deepEqual(tabs(s).map((i) => ({ type: i.type, label: i.label, layout: i.layout, action: i.action })), [
      { type: "button", label: "{ico:check} Сезон 1 · 1/3", layout: "0,1,3,1", action: replaceContent("ep_2002_1", P, ids.season(SMALL, 1)) },
      { type: "button", label: "Сезон 2 · 0/3", layout: "3,1,3,1", action: replaceContent("ep_2002_1", P, ids.season(SMALL, 2)) },
    ]);
    assert.equal(tabs(s)[1]?.action, `replace:content:ep_2002_1:request:interaction:season:2002:2@${P}`);
    assert.equal(s.headline, "Тестовый сериал «Короткий» · Сезон 1 из 2");
    assert.equal(s.extension, "{ico:msx-red:stop} Сезоны");
    const s2 = await open(t, SMALL, 2);
    assert.equal(tabs(s2)[0]?.action, replaceContent("ep_2002_2", P, ids.season(SMALL, 1)));
    assert.deepEqual(tabs(s2).map((i) => i.label), ["Сезон 1 · 1/3", "{ico:check} Сезон 2 · 0/3"]);
    assert.equal(eps(s2).length, 3);
  });

  it("seasonTabLabel: short label of a tab; seasonLabel of the seasons panel is unchanged", async () => {
    const t = await make();
    const got = await t.run(t.ctx.repo.item(SMALL));
    assert.equal(seasonTabLabel(t.ctx, got.value, got.fetchedAt, 2, false), "Сезон 2 · 0/3");
    assert.equal(seasonTabLabel(t.ctx, got.value, got.fetchedAt, 1, true), "{ico:check} Сезон 1 · 1/3");
    assert.equal(seasonLabel(t.ctx, got.value, got.fetchedAt, 1), "Сезон 1 · 1/3");
  });

  it("MOVIE_MULTI: parts as season 1 without tabs", async () => {
    const t = await make();
    const s = await open(t, FIX.MOVIE_MULTI, 1);
    assert.equal(s.flag, "ep_2003_1");
    assert.equal(s.headline, "Тестовый фильм «Из частей» · Части");
    assert.equal(s.header, undefined);
    assert.equal(s.extension, undefined, "no seasons to switch");
    assert.equal(s.options, undefined);
    assert.equal(eps(s).length, 3);
    const p1 = ep(s, mid(FIX.MOVIE_MULTI, 1));
    assert.equal(p1.title, "Часть 1");
    assert.equal(p1.options?.items?.length, 2, "no «Сезоны…» for parts");
    assert.equal(p1.playerLabel, "Тестовый фильм «Из частей» · Часть 1");
    assert.equal(p1.action, resolveAction(P, ids.playEp(FIX.MOVIE_MULTI, mid(FIX.MOVIE_MULTI, 1), 0, 1)));
    assert.equal(p1.focus, true);
    assert.equal(p1.options?.items?.[0]?.action, commitMsg(msgs.act("item", "watched", FIX.MOVIE_MULTI, 0, 1, 1)));
    // Без вкладок стражи и над рядом частей: одна вставка с обоими краями (msx/edges.ts).
    assert.deepEqual(s.inserts?.map((p) => [p.position, p.area, p.items.map((g) => [g.layout, g.selection?.action])]), [
      ["page:0", "0,1,16,4", eps(s).flatMap((e, k) => [[`${4 * k},0,4,1`, `focus:${e.id}`]]).concat(eps(s).map((e, k) => [`${4 * k},5,4,1`, `focus:${e.id}`]))],
    ]);
  });

  it("an episode with its own name: «1. Национальный гимн»; without one — «Серия N» (V-26)", async () => {
    const e1 = findItem(SMALL)?.seasons?.[0]?.episodes[0];
    assert.ok(e1);
    const was = e1.title;
    e1.title = "Национальный гимн";
    try {
      const t = await make();
      const s = await open(t, SMALL, 1);
      assert.equal(ep(s, mid(SMALL, 1)).title, "1. Национальный гимн");
      assert.equal(ep(s, mid(SMALL, 2)).title, "Серия 2");
    } finally {
      e1.title = was;
    }
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

describe("seasonScreen: long seasons in parts (CNFR-16)", () => {
  const LONG = FIX.SERIAL_LONG;
  /** Серия k сезона n у SERIAL_LONG: в сезоне 1 — 100 серий, в сезоне 2 — 200 (mid по сквозному номеру фикстуры). */
  const longMid = (n: number, k: number): number => mid(LONG, n === 1 ? k : 200 + k);
  const navs = (s: MsxContentRoot): MsxContentItem[] => eps(s).filter((i) => i.id?.startsWith("e_"));
  const episodes = (s: MsxContentRoot): MsxContentItem[] => eps(s).filter((i) => !i.id?.startsWith("e_"));
  const nextOf = (s: MsxContentRoot): string | undefined => {
    const a = navs(s).find((i) => i.id === "e_next")?.action;
    return a === undefined ? undefined : /request:interaction:([^@]+)@/.exec(a)?.[1];
  };

  /** Пройти части «… ›» от первой: каждая ≤ 32 КБ, серии сезона по порядку ровно один раз. */
  async function walk(t: TestApp, n: number, total: number): Promise<MsxContentRoot[]> {
    const parts: MsxContentRoot[] = [];
    for (let id: string | undefined = ids.season(LONG, n); id !== undefined; id = nextOf(parts.at(-1)!)) {
      parts.push((await t.request(id)) as MsxContentRoot);
      assert.ok(parts.length <= total, "the parts end");
    }
    for (const p of parts) assert.ok(bytes(p) <= 32 * 1024, `${p.extension}: ${bytes(p)} B`);
    assert.deepEqual(parts.flatMap((p) => episodes(p).map((i) => i.id)), Array.from({ length: total }, (_, k) => `e${longMid(n, k + 1)}`));
    return parts;
  }

  for (const [flags, name] of [[{}, "defaults"], [{ playerPropsIn: "item" }, "playerPropsIn: item"]] as const) {
    for (const [n, total] of [[1, 100], [2, 200]] as const) {
      it(`${total} episodes, ${name}: parts of whole rows ≤ 32 KB, «‹ Серии …» and «Серии … ›» between them`, async () => {
        const t = await make(flags);
        const parts = await walk(t, n, total);
        assert.ok(parts.length >= 3, `${parts.length} parts`);
        const size = episodes(parts[0]!).length;
        assert.equal(size % 4, 0, "whole rows of 4");
        parts.forEach((p, i) => {
          const from = i * size;
          const last = Math.min(total, from + size);
          assert.equal(p.flag, `ep_${LONG}_${n}`);
          assert.equal(p.headline, `Тестовый сериал «Длинный» · Сезон ${n} из 2`);
          assert.equal(p.extension, `Серии ${from + 1}–${last} · {ico:msx-red:stop} Сезоны`);
          assert.deepEqual(navs(p).map((x) => x.id), [...(i > 0 ? ["e_prev"] : []), ...(last < total ? ["e_next"] : [])]);
          if (i > 0) {
            const prev = navs(p)[0]!;
            assert.equal(prev.title, `‹ Серии ${from - size + 1}–${from}`);
            assert.equal(prev.action, replaceContent(`ep_${LONG}_${n}`, P, ids.season(LONG, n, from - size)));
            assert.equal(eps(p)[0], prev, "the way back is the first tile");
          }
          if (last < total) assert.equal(eps(p).at(-1)?.title, `Серии ${last + 1}–${Math.min(total, last + size)} ›`);
          assert.deepEqual(episodes(p).filter((e) => e.focus === true).map((e) => e.id), [`e${longMid(n, from + 1)}`]);
          assert.deepEqual(contextIssues(p), [], "context fields of every tile are strings, the way tiles too");
        });
      });
    }
  }

  it("without a part the season opens on the part with «Продолжить», focus on that episode", async () => {
    const t = await make();
    t.mock.state.watching.set(watchKey(LONG, 1, 50), { time: 600, status: 0, updated: 0 });
    const s = await open(t, LONG, 1);
    const size = episodes(s).length;
    const from = Math.floor(49 / size) * size;
    assert.ok(from > 0);
    assert.equal(s.extension, `Серии ${from + 1}–${from + size} · {ico:msx-red:stop} Сезоны`);
    assert.deepEqual(episodes(s).filter((e) => e.focus === true).map((e) => e.id), [`e${longMid(1, 50)}`]);
    assert.equal(navs(s)[0]?.action, replaceContent(`ep_${LONG}_1`, P, ids.season(LONG, 1, from - size)));
  });

  it("a part keeps its place on refresh: the spec targets season:<id>:<n>:<from>", async () => {
    const t = await make();
    await t.request(ids.season(LONG, 2, 72));
    assert.equal(seasonRefreshSpec(t.ctx, LONG, 2, "h", 72).dataId, "season:2007:2:72");
    assert.equal(t.ctx.current.get(), "season:2007:2:72");
  });

  it("a short season stays whole: SERIAL_BIG season 1 has no part tiles", async () => {
    const t = await make({ playerPropsIn: "item" });
    const s = await open(t, BIG, 1);
    assert.equal(navs(s).length, 0);
    assert.equal(eps(s).length, 20);
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
