import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { commitMsg } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { ids, msgs } from "../../src/router/ids.ts";
import { onItemAct } from "../../src/screens/item.ts";
import { FIX, findItem } from "../../tools/kpmock/fixtures.ts";
import { watchKey } from "../../tools/kpmock/state.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

// v1.16: «Отметить сезон просмотренным» и обратно (спец. §11 S9) — опция сезона и каждой серии; `toggle` сезона без
// `video` только после сверки (Р-20, CM-01), оверлей и «✓» на сериях сразу; что не сошлось — по сериям через outbox.

const BIG = FIX.SERIAL_BIG;
const SMALL = FIX.SERIAL_SMALL;
/** Коротко: подпись — в опциях каждой серии, длинный сезон делится на части ≤ 32 КБ по байтам серий (CNFR-16). */
const MARK = "Отметить сезон";
const UNMARK = "Снять отметки сезона";

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

const open = async (t: TestApp, id: number, n: number): Promise<MsxContentRoot> => (await t.request(ids.season(id, n))) as MsxContentRoot;
const episodes = (s: MsxContentRoot): MsxContentItem[] => (s.items ?? []).filter((i) => /^e\d+$/.test(i.id ?? ""));
const labels = (o: MsxContentRoot | undefined): (string | undefined)[] => (o?.items ?? []).map((i) => i.label);
const row = (o: MsxContentRoot | undefined, label: string): MsxContentItem | undefined => o?.items?.find((i) => i.label === label);
const statuses = (t: TestApp, id: number, n: number): number[] =>
  (findItem(id)?.seasons?.find((s) => s.number === n)?.episodes ?? []).map((e) => t.mock.state.watching.get(watchKey(id, n, e.number))?.status ?? -1);
/** Запросы просмотров (`watching*`) после `from`: у `toggle` — с `video` или только с сезоном. */
const paths = (t: TestApp, from: number): string[] => t.mock.calls().slice(from).filter((c) => c.path.startsWith("/v1/watching")).map((c) => `${c.path}${c.path.endsWith("toggle") ? `?${new URLSearchParams(c.query).has("video") ? "video" : "season"}` : ""}`);

describe("season options v1.16", () => {
  it("a part-watched season: «Отметить сезон» in the screen options and in every episode's options", async () => {
    const t = await make();
    const s = await open(t, BIG, 1);
    const act = commitMsg(msgs.act("item", "season", BIG, 1, 1));
    assert.deepEqual(labels(s.options), ["Сезоны…", MARK]);
    assert.equal(row(s.options, MARK)?.action, act);
    assert.equal(row(s.options, MARK)?.key, undefined, "red stays the «Сезоны…» shortcut (V-23)");
    for (const e of episodes(s)) assert.equal(row(e.options as MsxContentRoot, MARK)?.action, act, e.id);
    assert.deepEqual(labels(episodes(s)[0]?.options as MsxContentRoot), ["Сезоны…", MARK, "Снять отметку", "Смотреть с начала"]);
  });

  it("a fully watched season offers «Снять отметки сезона»; a one-season serial gets screen options too", async () => {
    const t = await make();
    for (const e of [1, 2, 3]) t.mock.state.watching.set(watchKey(SMALL, 2, e), { time: 60, status: 1, updated: 0 });
    const s = await open(t, SMALL, 2);
    assert.equal(row(s.options, UNMARK)?.action, commitMsg(msgs.act("item", "season", SMALL, 2, 0)));
    assert.equal(row(s.options, MARK), undefined);
  });

  it("the parts of a film have no season mark", async () => {
    const t = await make();
    const s = await open(t, FIX.MOVIE_MULTI, 1);
    assert.equal(row(s.options, MARK), undefined);
    assert.equal(row(episodes(s)[0]?.options as MsxContentRoot, MARK), undefined);
  });
});

describe("act:item:season — the whole season (CM-01, Р-20)", () => {
  it("reconcile → one season toggle without video → reconcile; ✓ on every episode at once, the season screen is redrawn", async () => {
    const t = await make();
    await open(t, BIG, 1);
    await t.clock.advance(1000);
    const n0 = t.mock.calls().length;
    await t.run(onItemAct(t.ctx, "season", [String(BIG), "1", "1"]));
    assert.deepEqual(paths(t, n0), ["/v1/watching", "/v1/watching/toggle?season", "/v1/watching"]);
    assert.ok(statuses(t, BIG, 1).every((x) => x === 1));
    assert.ok(statuses(t, BIG, 2).every((x) => x === -1), "other seasons untouched");
    assert.deepEqual(t.host.actions.map((a) => a.action), ["reload:content"]);
    const s = await open(t, BIG, 1);
    assert.ok(episodes(s).every((e) => e.badge === "✓"), "overlay: ✓ on every episode");
    assert.equal(row(s.options, UNMARK)?.action, commitMsg(msgs.act("item", "season", BIG, 1, 0)));
    assert.equal(t.ctx.outbox.size(), 0);
  });

  it("unmarking a part-watched season: the server completes it first, the second toggle clears it — two toggles at most", async () => {
    const t = await make();
    await open(t, BIG, 1);
    await t.clock.advance(1000);
    const n0 = t.mock.calls().length;
    await t.run(onItemAct(t.ctx, "season", [String(BIG), "1", "0"]));
    assert.deepEqual(paths(t, n0), [
      "/v1/watching", "/v1/watching/toggle?season", "/v1/watching", "/v1/watching/toggle?season", "/v1/watching",
    ]);
    assert.ok(statuses(t, BIG, 1).every((x) => x === -1));
    assert.ok(episodes(await open(t, BIG, 1)).every((e) => e.badge === undefined));
  });

  it("already as wanted (another TV): no toggle at all", async () => {
    const t = await make();
    await open(t, SMALL, 1);
    for (const e of [1, 2, 3]) t.mock.state.watching.set(watchKey(SMALL, 1, e), { time: 60, status: 1, updated: 0 });
    const n0 = t.mock.calls().length;
    await t.run(onItemAct(t.ctx, "season", [String(SMALL), "1", "1"]));
    assert.deepEqual(paths(t, n0), ["/v1/watching"]);
  });

  it("a lost toggle response is not repeated blindly: the rest goes episode by episode through the outbox reconcile", async () => {
    const t = await make();
    await open(t, SMALL, 2);
    t.mock.setScenario({ toggleLostResponse: 1 });
    const n0 = t.mock.calls().length;
    await t.run(onItemAct(t.ctx, "season", [String(SMALL), "2", "1"]));
    // Сезон переключился, ответ потерян; каждая серия сверяется в outbox и уже просмотрена — второго toggle нет.
    assert.equal(paths(t, n0).filter((p) => p.startsWith("/v1/watching/toggle")).length, 1);
    assert.ok(statuses(t, SMALL, 2).every((x) => x === 1));
    assert.equal(t.ctx.outbox.size(), 0);
  });

  it("an API that rejects the season form (400): episode by episode through the outbox", async () => {
    const t = await make();
    await open(t, SMALL, 2);
    t.mock.setScenario({ rules: [{ path: "^/v1/watching/toggle$", status: 400, times: 1 }] });
    await t.run(onItemAct(t.ctx, "season", [String(SMALL), "2", "1"]));
    assert.ok(statuses(t, SMALL, 2).every((x) => x === 1));
    assert.ok(t.mock.calls().filter((c) => c.path === "/v1/watching/toggle" && new URLSearchParams(c.query).has("video")).length === 3);
  });

  it("another screen is not redrawn; malformed arguments send nothing", async () => {
    const t = await make();
    await open(t, BIG, 1);
    await t.request(ids.item(FIX.MOVIE_SIMPLE));
    t.host.clearActions();
    await t.run(onItemAct(t.ctx, "season", [String(BIG), "2", "1"]));
    assert.deepEqual(t.host.actions, []);
    const n0 = t.mock.calls().length;
    for (const args of [["x", "1", "1"], [String(BIG), "0", "1"], [String(BIG), "1", "3"]]) await t.run(onItemAct(t.ctx, "season", args));
    assert.equal(t.mock.calls().length, n0);
  });
});
