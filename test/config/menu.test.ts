import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KvStore } from "../../src/bridge/storage.ts";
import { MenuStore, OrderStore } from "../../src/config/menu.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";

const DEF = ["home", "watching", "search", "fresh", "movies", "settings", "probe"];

function setup(): { mem: MemoryStorage; kv: KvStore; m: MenuStore } {
  const mem = new MemoryStorage();
  const kv = new KvStore(mem);
  return { mem, kv, m: new MenuStore(kv, DEF, ["settings"]) };
}

describe("MenuStore (kp.cfg.menu)", () => {
  it("defaults: the default order, nothing hidden, nothing stored", () => {
    const { m, mem } = setup();
    assert.deepEqual(m.get(), { order: DEF, hidden: [] });
    m.set(m.get());
    assert.equal(mem.getItem("kp.cfg.menu"), null);
  });

  it("stores only the differences: order only when it differs, hidden only when not empty", () => {
    const { m, kv } = setup();
    m.set({ order: DEF, hidden: ["fresh"] });
    assert.deepEqual(kv.get("cfg", "menu"), { hidden: ["fresh"] });
    const order = ["search", ...DEF.filter((id) => id !== "search")];
    m.set({ order, hidden: [] });
    assert.deepEqual(kv.get("cfg", "menu"), { order });
    assert.deepEqual(m.get(), { order, hidden: [] });
  });

  it("«Настройки» cannot be hidden, «Главная» can", () => {
    const { m, kv } = setup();
    assert.equal(m.canHide("settings"), false);
    assert.equal(m.canHide("home"), true);
    m.set({ order: DEF, hidden: ["settings", "home"] });
    assert.deepEqual(kv.get("cfg", "menu"), { hidden: ["home"] });
    kv.set("cfg", "menu", { hidden: ["settings"] });
    assert.deepEqual(m.get().hidden, []);
  });

  it("garbage is dropped: unknown and repeated ids, non-strings, non-arrays, broken JSON", () => {
    const { m, kv, mem } = setup();
    kv.set("cfg", "menu", { order: ["probe", 7, "nope", "probe", null, "home"], hidden: ["x", "fresh", "fresh", 1] });
    // Недостающие пункты встают после своего соседа по умолчанию: watching после home, search после watching…
    assert.deepEqual(m.get(), { order: ["probe", "home", "watching", "search", "fresh", "movies", "settings"], hidden: ["fresh"] });
    kv.set("cfg", "menu", { order: "home", hidden: { a: 1 } });
    assert.deepEqual(m.get(), { order: DEF, hidden: [] });
    kv.set("cfg", "menu", [1, 2]);
    assert.deepEqual(m.get(), { order: DEF, hidden: [] });
    mem.setItem("kp.cfg.menu", "{not json");
    assert.deepEqual(m.get(), { order: DEF, hidden: [] });
  });

  it("a section added in a new version lands next to its default neighbour; first without one", () => {
    const { kv } = setup();
    kv.set("cfg", "menu", { order: ["movies", "home", "search", "settings", "probe"] });
    const m = new MenuStore(kv, DEF, ["settings"]);
    assert.deepEqual(m.get().order, ["movies", "home", "watching", "search", "fresh", "settings", "probe"]);
    kv.set("cfg", "menu", { order: ["search", "movies"] });
    assert.deepEqual(m.get().order, ["home", "watching", "search", "fresh", "movies", "settings", "probe"]);
  });

  it("hidden follow the order; reset forgets everything", () => {
    const { m, mem } = setup();
    m.set({ order: DEF, hidden: ["probe", "home"] });
    assert.deepEqual(m.get().hidden, ["home", "probe"]);
    m.reset();
    assert.equal(mem.getItem("kp.cfg.menu"), null);
    assert.deepEqual(m.get(), { order: DEF, hidden: [] });
  });
});

describe("OrderStore with its own key (kp.cfg.home, «Секции главной»)", () => {
  const SHELVES = ["c", "fm", "fs", "b"];
  const home = (kv: KvStore): OrderStore => new OrderStore(kv, SHELVES, [], "home");

  it("stores only the differences under kp.cfg.home and leaves kp.cfg.menu alone; nothing is locked", () => {
    const { kv, mem } = setup();
    const h = home(kv);
    assert.deepEqual(h.get(), { order: SHELVES, hidden: [] });
    assert.deepEqual(h.shown(), SHELVES);
    assert.ok(SHELVES.every((id) => h.canHide(id)));
    h.set({ order: ["b", "c", "fm", "fs"], hidden: ["c", "fs"] });
    assert.deepEqual(kv.get("cfg", "home"), { order: ["b", "c", "fm", "fs"], hidden: ["c", "fs"] });
    assert.deepEqual(h.shown(), ["b", "fm"]);
    assert.equal(mem.getItem("kp.cfg.menu"), null);
    h.set({ order: SHELVES, hidden: [] });
    assert.equal(mem.getItem("kp.cfg.home"), null);
  });

  describe("migration of a stored config: `version` and `show`", () => {
    const H = { version: 2, show: ["c"] } as const;
    const migrated = (kv: KvStore): OrderStore => new OrderStore(kv, SHELVES, [], "home", H);

    it("a config without the version (v1.13–v1.20) shows «c» again once and is rewritten with `v`; order and other hidden stay", () => {
      const { kv } = setup();
      kv.set("cfg", "home", { order: ["b", "fm", "c", "fs"], hidden: ["c", "fs"] });
      const h = migrated(kv);
      assert.deepEqual(h.get(), { order: ["b", "fm", "c", "fs"], hidden: ["fs"] });
      assert.deepEqual(kv.get("cfg", "home"), { order: ["b", "fm", "c", "fs"], hidden: ["fs"], v: 2 });
      assert.deepEqual(h.shown(), ["b", "fm", "c"]);
    });

    it("only «c» hidden: after the migration the config equals the defaults and is removed", () => {
      const { kv, mem } = setup();
      kv.set("cfg", "home", { hidden: ["c"] });
      assert.deepEqual(migrated(kv).get(), { order: SHELVES, hidden: [] });
      assert.equal(mem.getItem("kp.cfg.home"), null);
    });

    it("hidden again after the migration — a choice: stored with `v`, stays hidden in a new app", () => {
      const { kv } = setup();
      kv.set("cfg", "home", { hidden: ["c"] });
      migrated(kv).get();
      migrated(kv).set({ order: SHELVES, hidden: ["c"] });
      assert.deepEqual(kv.get("cfg", "home"), { hidden: ["c"], v: 2 });
      assert.deepEqual(migrated(kv).get(), { order: SHELVES, hidden: ["c"] });
      assert.deepEqual(migrated(kv).shown(), ["fm", "fs", "b"]);
    });

    it("garbage of an old config is dropped by the same migration; nothing stored — nothing written", () => {
      const { kv, mem } = setup();
      assert.deepEqual(migrated(kv).get(), { order: SHELVES, hidden: [] });
      assert.equal(mem.getItem("kp.cfg.home"), null);
      kv.set("cfg", "home", { order: "b", hidden: ["c", "x", 1], v: 1 });
      assert.deepEqual(migrated(kv).get(), { order: SHELVES, hidden: [] });
      assert.equal(mem.getItem("kp.cfg.home"), null);
    });

    it("a store without a version (kp.cfg.menu) neither migrates nor writes `v`", () => {
      const { kv } = setup();
      kv.set("cfg", "home", { hidden: ["c"] });
      assert.deepEqual(home(kv).get().hidden, ["c"]);
      assert.deepEqual(kv.get("cfg", "home"), { hidden: ["c"] });
      home(kv).set({ order: SHELVES, hidden: ["fm"] });
      assert.deepEqual(kv.get("cfg", "home"), { hidden: ["fm"] });
    });
  });

  it("garbage in kp.cfg.home is dropped; reset forgets it; the defaults are public", () => {
    const { kv, mem } = setup();
    const h = home(kv);
    kv.set("cfg", "home", { order: ["b", "home", 3, "b"], hidden: ["settings", "fm", null] });
    // Недостающие встают после соседа по умолчанию, «c» без соседа выше — первой.
    assert.deepEqual(h.get(), { order: ["c", "fm", "fs", "b"], hidden: ["fm"] });
    h.reset();
    assert.equal(mem.getItem("kp.cfg.home"), null);
    assert.deepEqual(h.defaults, SHELVES);
    // Меню — прежнее имя того же класса.
    assert.ok(new MenuStore(kv, DEF, ["settings"]) instanceof OrderStore);
  });
});
