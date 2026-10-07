import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import type { MsxContentItem, MsxContentRoot, MsxMenuRoot } from "../../src/msx/types.ts";
import { ids, msgs } from "../../src/router/ids.ts";
import { replaceContent } from "../../src/msx/actions.ts";
import { onOrderAct, orderSummary } from "../../src/screens/order-edit.ts";
import { SECTIONS, menuStore, refreshMenu } from "../../src/screens/menu.ts";
import { answerIssues, bytesOf } from "../../tools/crawl-rules.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

// Список с порядком и видимостью (S12): «Пункты меню» — `panel:menu`, `act:menu:<op>:<id>`, `kp.cfg.menu`, перерисовка
// меню (v1.12); «Секции главной» — `panel:home`, `act:home:<op>:<id>`, `kp.cfg.home`, замена главной, если она текущая.

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
    onOrderAct(t.ctx, "menu", "hide", ["settings"]);
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
    assert.equal(orderSummary(t.ctx, "menu"), `${DEFAULT.length - 1} из ${DEFAULT.length}`);

    onOrderAct(t.ctx, "menu", "hide", ["watching"]);
    assert.equal(t.ctx.store.get("cfg", "menu"), undefined, "back to defaults — nothing stored");
    assert.ok((await labels(t)).includes("Я смотрю"));
    assert.equal(orderSummary(t.ctx, "menu"), "По умолчанию");
  });

  it("▲ repeatedly: each press moves one row up and keeps the focus on ▲ of the same section; at the top — no change", async () => {
    const t = await make();
    for (let n = 0; n < 3; n++) onOrderAct(t.ctx, "menu", "up", ["fresh"]);
    assert.deepEqual(menuStore(t.ctx).get().order.slice(0, 4), ["fresh", "home", "watching", "search"]);
    assert.equal(focused(await panel(t)), "u_fresh");
    onOrderAct(t.ctx, "menu", "up", ["fresh"]);
    assert.deepEqual(menuStore(t.ctx).get().order.slice(0, 2), ["fresh", "home"]);
    assert.equal(actions(t).length, 4);
    assert.ok(actions(t).every((a) => a === REDRAW));
    assert.deepEqual((await labels(t)).slice(0, 2), ["Новинки", "Главная"]);
  });

  it("▼ moves down (not past the end); ⤒ moves to the top; the order is stored", async () => {
    const t = await make();
    onOrderAct(t.ctx, "menu", "down", ["home"]);
    assert.deepEqual(menuStore(t.ctx).get().order.slice(0, 2), ["watching", "home"]);
    assert.equal(focused(await panel(t)), "d_home");
    onOrderAct(t.ctx, "menu", "down", ["probe"]);
    assert.equal(menuStore(t.ctx).get().order.at(-1), "probe");
    onOrderAct(t.ctx, "menu", "top", ["sport"]);
    const order = menuStore(t.ctx).get().order;
    assert.deepEqual(order.slice(0, 3), ["sport", "watching", "home"]);
    assert.deepEqual((t.ctx.store.get("cfg", "menu") as { order: string[] }).order, order);
    assert.equal(focused(await panel(t)), "t_sport");
    assert.equal((await labels(t))[0], "Спорт");
  });

  it("«Сбросить по умолчанию» forgets the order and the hidden items; focus on it", async () => {
    const t = await make();
    onOrderAct(t.ctx, "menu", "top", ["sport"]);
    onOrderAct(t.ctx, "menu", "hide", ["home"]);
    onOrderAct(t.ctx, "menu", "reset", []);
    assert.equal(t.ctx.store.get("cfg", "menu"), undefined);
    assert.deepEqual(menuStore(t.ctx).get(), { order: DEFAULT, hidden: [] });
    assert.equal(focused(await panel(t)), "m_reset");
    assert.equal(actions(t).at(-1), REDRAW);
  });

  it("unknown section or operation: a warning, nothing stored, no redraw", async () => {
    const t = await make();
    onOrderAct(t.ctx, "menu", "hide", ["nope"]);
    onOrderAct(t.ctx, "menu", "swap", ["home"]);
    onOrderAct(t.ctx, "menu", "up", []);
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

  it("settings: the first row «Порядок и видимость пунктов меню» opens panel:menu and shows the summary", async () => {
    const t = await make();
    onOrderAct(t.ctx, "menu", "hide", ["probe"]);
    const s = (await t.request(ids.settings())) as MsxContentRoot;
    const row = s.items?.find((i) => i.id === "s_menu");
    assert.equal(row, s.items?.find((i) => i.type !== "space"), "the first row of the settings");
    assert.equal(row?.focus, true);
    assert.equal(row?.label, "Порядок и видимость пунктов меню");
    assert.equal(row?.extensionLabel, `${DEFAULT.length - 1} из ${DEFAULT.length}`);
    assert.equal(row?.action, `panel:request:interaction:${ids.panel("menu")}@${P}`);
  });
});

describe("«Секции главной» panel (panel:home, kp.cfg.home)", () => {
  const SHELVES = ["c", "fm", "fs", "b", "pm", "ps", "hm", "hs"];
  const TITLES = [
    "Продолжить просмотр", "Новые фильмы", "Новые сериалы", "Закладки",
    "Популярные фильмы", "Популярные сериалы", "Горячее: фильмы", "Горячее: сериалы",
  ];
  const home = async (t: TestApp): Promise<MsxContentRoot> => (await t.request(ids.panel("home"))) as MsxContentRoot;
  const hmsg = (op: string, id?: string): string =>
    `interaction:commit:message:${id === undefined ? msgs.act("home", op) : msgs.act("home", op, id)}`;
  const REPLACE_HOME = `[${replaceContent("home", P, ids.home())}|reload:panel]`;

  it("the same list as «Пункты меню»: a hint, ☑ title ▲ ▼ ⤒ per shelf in the home order, «Сбросить» last; no lock", async () => {
    const t = await make();
    const p = await home(t);
    assert.equal(p.headline, "Секции главной");
    assert.deepEqual(answerIssues(ids.panel("home"), p), []);
    assert.equal(all(p)[0]?.type, "space");
    assert.match(String(all(p)[0]?.text), /^OK — показать или скрыть/);
    SHELVES.forEach((id, i) => {
      const row = all(p).filter((x) => x.id?.endsWith(`_${id}`));
      assert.deepEqual(row.map((x) => x.id), [`m_${id}`, `u_${id}`, `d_${id}`, `t_${id}`]);
      assert.equal(row[0]?.label, `{ico:check-box} ${TITLES[i]}`);
      assert.deepEqual(row.map((x) => x.action), [hmsg("hide", id), hmsg("up", id), hmsg("down", id), hmsg("top", id)]);
    });
    assert.equal(all(p).at(-1)?.id, "m_reset");
    assert.equal(all(p).at(-1)?.action, hmsg("reset"));
    assert.equal(focused(p), "m_c");
    assert.ok(!JSON.stringify(p).includes("{ico:lock}"));
    assert.ok(bytesOf(p) <= 16 * 1024, String(bytesOf(p)));
    assert.equal(orderSummary(t.ctx, "home"), "По умолчанию");
  });

  it("from the settings: OK hides a shelf — kp.cfg.home; the settings under the panel and the panel are redrawn (the home — when shown)", async () => {
    const t = await make();
    await t.request(ids.settings());
    await home(t);
    t.app.handleData({ message: msgs.act("home", "hide", "fm") });
    await realSleep(10);
    assert.deepEqual(actions(t), ["[reload:content|reload:panel]"]);
    assert.deepEqual(t.ctx.store.get("cfg", "home"), { hidden: ["fm"] });
    assert.equal(t.ctx.store.get("cfg", "menu"), undefined);
    const p = await home(t);
    assert.equal(byId(p, "m_fm")?.label, "{ico:check-box-outline-blank} Новые фильмы");
    assert.equal(focused(p), "m_fm");
    assert.equal(orderSummary(t.ctx, "home"), "7 из 8");
  });

  it("over the home (red button): the home is replaced at once under the panel; ⤒ moves «Закладки» first", async () => {
    const t = await make();
    await t.request(ids.home());
    onOrderAct(t.ctx, "home", "top", ["b"]);
    assert.deepEqual(actions(t), [REPLACE_HOME]);
    assert.deepEqual((t.ctx.store.get("cfg", "home") as { order: string[] }).order, ["b", "c", "fm", "fs", "pm", "ps", "hm", "hs"]);
    assert.equal(focused(await home(t)), "t_b");
    assert.equal(orderSummary(t.ctx, "home"), "Свой порядок", "nothing hidden, the order changed");
    onOrderAct(t.ctx, "home", "reset", []);
    assert.equal(t.ctx.store.get("cfg", "home"), undefined);
    assert.equal(actions(t).at(-1), REPLACE_HOME);
    assert.equal(focused(await home(t)), "m_reset");
  });

  it("unknown shelf or operation: a «home» warning, nothing stored, no redraw", async () => {
    const t = await make();
    onOrderAct(t.ctx, "home", "hide", ["home"]);
    onOrderAct(t.ctx, "home", "swap", ["c"]);
    assert.deepEqual(actions(t), []);
    assert.equal(t.ctx.store.get("cfg", "home"), undefined);
    assert.equal(t.ctx.log.entries().filter((e) => e.tag === "home" && e.msg === "bad_act").length, 2);
  });

  it("settings: «Порядок и видимость секций главной» right under the menu row opens panel:home with the summary", async () => {
    const t = await make();
    onOrderAct(t.ctx, "home", "hide", ["hs"]);
    const s = (await t.request(ids.settings())) as MsxContentRoot;
    const rows = (s.items ?? []).filter((i) => i.type !== "space");
    assert.deepEqual(rows.slice(0, 2).map((i) => i.id), ["s_menu", "s_home"]);
    assert.equal(rows[1]?.label, "Порядок и видимость секций главной");
    assert.equal(rows[1]?.extensionLabel, "7 из 8");
    assert.equal(rows[1]?.action, `panel:request:interaction:${ids.panel("home")}@${P}`);
  });
});
