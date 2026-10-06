import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import type { MsxContentItem, MsxContentRoot, MsxMenuRoot } from "../../src/msx/types.ts";
import { ids, msgs } from "../../src/router/ids.ts";
import { menuPanel, menuSummary, onMenuAct } from "../../src/screens/menu-edit.ts";
import { SECTIONS, menuStore, refreshMenu } from "../../src/screens/menu.ts";
import { answerIssues, bytesOf } from "../../tools/crawl-rules.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

// «Пункты меню» (S12, v1.11): панель `panel:menu`, сообщения `act:menu:<op>:<id>`, `kp.cfg.menu` и перерисовка меню.

const P = TEST_P;
const DEFAULT = SECTIONS.map((x) => x.id);
const REDRAW = `[${refreshMenu(P)}|reload:panel]`;

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

const panel = async (t: TestApp): Promise<MsxContentRoot> => (await t.request(ids.panel("menu"))) as MsxContentRoot;
const all = (p: MsxContentRoot): MsxContentItem[] => (p.pages ?? []).flatMap((pg) => pg.items);
const byId = (p: MsxContentRoot, id: string): MsxContentItem | undefined => all(p).find((i) => i.id === id);
const focused = (p: MsxContentRoot): string | undefined => all(p).find((i) => i.focus === true)?.id;
const actions = (t: TestApp): string[] => t.host.actions.map((a) => a.action);
const msg = (op: string, id?: string): string => `interaction:commit:message:${id === undefined ? msgs.act("menu", op) : msgs.act("menu", op, id)}`;
const labels = async (t: TestApp): Promise<string[]> => ((await t.request(ids.init())) as MsxMenuRoot).menu.map((i) => i.label ?? "");

describe("menu panel «Пункты меню»", () => {
  it("pages of 6 rows: a hint, a row per section (name 5, ▲ ▼ ⤒ 1 each) in the menu order, «Сбросить» last; focus on the first name", async () => {
    const t = await make();
    const p = await panel(t);
    assert.equal(p.headline, "Пункты меню");
    assert.equal(p.type, "list");
    // Шаблонным элементам MSX даёт `layout` шаблона — строкам из четырёх кнопок нужны страницы с явными `layout`.
    assert.equal(p.template, undefined);
    assert.equal(p.items, undefined);
    assert.deepEqual(answerIssues(ids.panel("menu"), p), []);
    const rows = (p.pages ?? []).flatMap((pg) => {
      const ys = [...new Set(pg.items.map((i) => Number(i.layout?.split(",")[1])))];
      assert.ok(ys.every((y) => y >= 0 && y < 6), "rows 0…5 of a page");
      return ys.map((y) => pg.items.filter((i) => Number(i.layout?.split(",")[1]) === y));
    });
    assert.equal(rows.length, 1 + DEFAULT.length + 1);
    assert.equal(rows[0]?.[0]?.type, "space");
    DEFAULT.forEach((id, i) => {
      const row = rows[i + 1] ?? [];
      const y = Number(row[0]?.layout?.split(",")[1]);
      assert.deepEqual(row.map((x) => x.id), [`m_${id}`, `u_${id}`, `d_${id}`, `t_${id}`]);
      assert.deepEqual(row.map((x) => x.layout), [`0,${y},5,1`, `5,${y},1,1`, `6,${y},1,1`, `7,${y},1,1`]);
      assert.ok(row.every((x) => x.type === "button"));
      assert.deepEqual(row.slice(1).map((x) => x.icon), ["arrow-upward", "arrow-downward", "vertical-align-top"]);
      assert.deepEqual(row.slice(1).map((x) => x.action), [msg("up", id), msg("down", id), msg("top", id)]);
    });
    assert.equal(rows.at(-1)?.[0]?.id, "m_reset");
    assert.equal(rows.at(-1)?.[0]?.action, msg("reset"));
    assert.equal(focused(p), "m_home");
    assert.equal(all(p).filter((i) => i.focus === true).length, 1);
    assert.equal(byId(p, "m_watching")?.label, "{ico:check-box} Я смотрю");
    assert.equal(byId(p, "m_watching")?.action, msg("hide", "watching"));
    // Панель ≤ 16 КБ (CNFR-16).
    assert.ok(bytesOf(p) <= 16 * 1024, String(bytesOf(p)));
  });

  it("«Просмотр и аккаунт» has a lock and only explains; hiding it via a message changes nothing", async () => {
    const t = await make();
    const p = await panel(t);
    assert.equal(byId(p, "m_settings")?.label, "{ico:lock} Просмотр и аккаунт");
    assert.match(byId(p, "m_settings")?.action ?? "", /^info:/);
    onMenuAct(t.ctx, "hide", ["settings"]);
    assert.deepEqual(actions(t), []);
    assert.equal(t.ctx.store.get("cfg", "menu"), undefined);
  });

  it("OK on a name hides the item: stored, menu and panel redrawn, focus stays on that name; again — shown", async () => {
    const t = await make();
    await panel(t);
    t.app.handleData({ message: msgs.act("menu", "hide", "watching") });
    await realSleep(10);
    assert.deepEqual(actions(t), [REDRAW]);
    assert.deepEqual(t.ctx.store.get("cfg", "menu"), { hidden: ["watching"] });
    assert.ok(!(await labels(t)).includes("Я смотрю"));
    const p = await panel(t);
    assert.equal(byId(p, "m_watching")?.label, "{ico:check-box-outline-blank} Я смотрю");
    assert.equal(focused(p), "m_watching");
    assert.equal(menuSummary(t.ctx), `${DEFAULT.length - 1} из ${DEFAULT.length}`);

    onMenuAct(t.ctx, "hide", ["watching"]);
    assert.equal(t.ctx.store.get("cfg", "menu"), undefined, "back to defaults — nothing stored");
    assert.ok((await labels(t)).includes("Я смотрю"));
    assert.equal(menuSummary(t.ctx), "По умолчанию");
  });

  it("▲ repeatedly: each press moves one row up and keeps the focus on ▲ of the same section; at the top — no change", async () => {
    const t = await make();
    for (let n = 0; n < 3; n++) onMenuAct(t.ctx, "up", ["fresh"]);
    assert.deepEqual(menuStore(t.ctx).get().order.slice(0, 4), ["fresh", "home", "watching", "search"]);
    assert.equal(focused(await panel(t)), "u_fresh");
    onMenuAct(t.ctx, "up", ["fresh"]);
    assert.deepEqual(menuStore(t.ctx).get().order.slice(0, 2), ["fresh", "home"]);
    assert.equal(actions(t).length, 4);
    assert.ok(actions(t).every((a) => a === REDRAW));
    assert.deepEqual((await labels(t)).slice(0, 2), ["Новинки", "Главная"]);
  });

  it("▼ moves down (not past the end); ⤒ moves to the top; the order is stored", async () => {
    const t = await make();
    onMenuAct(t.ctx, "down", ["home"]);
    assert.deepEqual(menuStore(t.ctx).get().order.slice(0, 2), ["watching", "home"]);
    assert.equal(focused(await panel(t)), "d_home");
    onMenuAct(t.ctx, "down", ["probe"]);
    assert.equal(menuStore(t.ctx).get().order.at(-1), "probe");
    onMenuAct(t.ctx, "top", ["sport"]);
    const order = menuStore(t.ctx).get().order;
    assert.deepEqual(order.slice(0, 3), ["sport", "watching", "home"]);
    assert.deepEqual((t.ctx.store.get("cfg", "menu") as { order: string[] }).order, order);
    assert.equal(focused(await panel(t)), "t_sport");
    assert.equal((await labels(t))[0], "Спорт");
  });

  it("«Сбросить по умолчанию» forgets the order and the hidden items; focus on it", async () => {
    const t = await make();
    onMenuAct(t.ctx, "top", ["sport"]);
    onMenuAct(t.ctx, "hide", ["home"]);
    onMenuAct(t.ctx, "reset", []);
    assert.equal(t.ctx.store.get("cfg", "menu"), undefined);
    assert.deepEqual(menuStore(t.ctx).get(), { order: DEFAULT, hidden: [] });
    assert.equal(focused(await panel(t)), "m_reset");
    assert.equal(actions(t).at(-1), REDRAW);
  });

  it("unknown section or operation: a warning, nothing stored, no redraw", async () => {
    const t = await make();
    onMenuAct(t.ctx, "hide", ["nope"]);
    onMenuAct(t.ctx, "swap", ["home"]);
    onMenuAct(t.ctx, "up", []);
    assert.deepEqual(actions(t), []);
    assert.equal(t.ctx.store.get("cfg", "menu"), undefined);
    assert.equal(t.ctx.log.entries().filter((e) => e.tag === "menu" && e.msg === "bad_act").length, 3);
  });

  it("garbage in kp.cfg.menu: the panel and the menu still show every section", async () => {
    const t = await make();
    t.ctx.store.set("cfg", "menu", { order: [1, "zzz", "probe", "home"], hidden: "home" });
    const p = await panel(t);
    assert.equal(all(p).filter((i) => i.id?.startsWith("m_") && i.id !== "m_reset").length, DEFAULT.length);
    assert.equal(all(p)[1]?.id, "m_probe", "the stored order is kept for known ids");
    assert.equal(focused(p), "m_probe");
    assert.equal((await labels(t)).filter((l) => l === "Главная").length, 1);
  });

  it("settings: the «Пункты меню» row opens panel:menu and shows the summary", async () => {
    const t = await make();
    onMenuAct(t.ctx, "hide", ["probe"]);
    const s = (await t.request(ids.settings())) as MsxContentRoot;
    const row = s.items?.find((i) => i.id === "s_menu");
    assert.equal(row?.label, "Пункты меню");
    assert.equal(row?.extensionLabel, `${DEFAULT.length - 1} из ${DEFAULT.length}`);
    assert.equal(row?.action, `panel:request:interaction:${ids.panel("menu")}@${P}`);
  });
});
