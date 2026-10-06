import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { PERSIST_EVERY_MS } from "../../src/app/create-app.ts";
import { KpError } from "../../src/core/errors.ts";
import type { MsxMenuRoot } from "../../src/msx/types.ts";
import { msxInfoFrom } from "../../src/router/router.ts";
import { errorScreen, errorText } from "../../src/screens/error.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";

const AT_P = `@${TEST_P}`;

// Свой mock у каждого стенда: фоновые запросы одного теста (ready, act, экраны после этапов 17–31)
// не попадают в журнал mock другого.
let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(o: Omit<TestAppOptions, "mock"> = {}): Promise<TestApp> {
  const t = await createTestApp(o);
  apps.push(t);
  return t;
}

const logged = (t: TestApp, msg: string): { msg: string; data?: Record<string, unknown> }[] =>
  t.ctx.log.entries().filter((e) => e.tag === "router" && e.msg === msg);

function menuData(menu: MsxMenuRoot): string[] {
  return menu.menu.map((m) => m.data).filter((d): d is string => typeof d === "string");
}

describe("App.handleRequest: init (CNFR-03)", () => {
  it("answers the menu without network, fast, and counts init", async () => {
    const t = await make();
    const wall = performance.now();
    const t0 = t.ctx.clock.perf();
    const menu = (await t.request("init")) as MsxMenuRoot;
    assert.ok(t.ctx.clock.perf() - t0 <= 100);
    assert.ok(performance.now() - wall <= 100, "init must not wait for anything");
    assert.ok(Array.isArray(menu.menu) && menu.menu.length > 0);
    assert.equal(t.mock.calls().length, 0);
    assert.equal(t.ctx.state.initCount, 1);
    assert.equal(typeof t.ctx.state.initAnsweredAt, "number");
    assert.equal(t.ctx.metrics.summary().values["screen:init"]?.n, 1);
  });

  for (const loggedIn of [false, true]) {
    it(`every menu action addresses the plugin by its full URL (loggedIn: ${loggedIn})`, async () => {
      const t = await make({ loggedIn });
      const data = menuData((await t.request("init")) as MsxMenuRoot);
      assert.ok(data.length > 0);
      for (const d of data) assert.ok(d.endsWith(AT_P), d);
      assert.equal(t.mock.calls().length, 0);
    });
  }

  it("init does not change the current screen", async () => {
    const t = await make();
    await t.request("probe");
    await t.request("init");
    assert.equal(t.ctx.current.get(), "probe");
    assert.equal(t.ctx.state.initCount, 1);
  });
});

describe("App.handleRequest without login", () => {
  for (const dataId of ["home", "list:abc", "search", "item:1", "season:1:1", "settings", "bookmarks"]) {
    it(`${dataId} → login screen; current is login`, async () => {
      const t = await make();
      await t.request(dataId);
      assert.deepEqual(logged(t, "login required").map((e) => e.data), [{ route: dataId.split(":")[0] }]);
      assert.equal(t.ctx.current.get(), "login");
    });
  }

  it("a panel → login screen without changing the current screen", async () => {
    const t = await make();
    await t.request("probe");
    await t.request("panel:audio:1:2:c");
    assert.equal(logged(t, "login required").length, 1);
    assert.equal(t.ctx.current.get(), "probe");
  });

  it("resolve → { error } with the KP-AUTH text", async () => {
    const t = await make();
    for (const id of ["play:2001:continue", "play:2001:2001004:1:4", "play:probe:a1:2001:2001001:1:1"]) {
      assert.deepEqual(await t.request(id), { error: errorText(new KpError("KP-AUTH", "x")).text });
    }
  });

  for (const dataId of ["init", "login", "probe", "probe:report:1", "dev"]) {
    it(`${dataId} is public`, async () => {
      const t = await make();
      await t.request(dataId);
      assert.equal(logged(t, "login required").length, 0);
    });
  }

  it("unknown dataId → error screen", async () => {
    const t = await make();
    assert.deepEqual(await t.request("nope:1"), errorScreen(t.ctx, new KpError("KP-BAD", "unknown route")));
  });
});

describe("App.handleRequest with login", () => {
  it("home → home screen, not the login screen; time is recorded", async () => {
    const t = await make({ loggedIn: true });
    const res = await t.request("home");
    assert.equal(typeof res, "object");
    assert.equal(logged(t, "login required").length, 0);
    assert.equal(t.ctx.current.get(), "home");
    assert.equal(t.ctx.metrics.summary().values["screen:home"]?.n, 1);
  });

  it("a screen that throws KpError(KP-NET) → errorScreen with retry dataId", async () => {
    const err = new KpError("KP-NET", "offline");
    const t = await make({
      loggedIn: true,
      routes: {
        home: () => {
          throw err;
        },
      },
    });
    assert.deepEqual(await t.request("home"), errorScreen(t.ctx, err, "home"));
    assert.equal(logged(t, "request_failed")[0]?.data?.err, "KP-NET");
  });

  it("a rejected screen promise → errorScreen", async () => {
    const err = new KpError("KP-5XX", "down", 502);
    const t = await make({ loggedIn: true, routes: { item: async () => Promise.reject(err) } });
    assert.deepEqual(await t.request("item:5"), errorScreen(t.ctx, err, "item:5"));
  });

  it("resolve that throws → { error }", async () => {
    const err = new KpError("KP-404", "gone", 404);
    const t = await make({
      loggedIn: true,
      routes: {
        play: () => {
          throw err;
        },
        playEp: async () => Promise.reject(err),
      },
    });
    assert.deepEqual(await t.request("play:2005:continue"), { error: errorText(err).text });
    assert.deepEqual(await t.request("play:2005:2005001:0:1:start"), { error: errorText(err).text });
  });

  it("dispatches every route kind to its handler", async () => {
    const seen: string[] = [];
    const rec = (name: string) => (_ctx: unknown, r: unknown) => {
      seen.push(`${name} ${JSON.stringify(r)}`);
      return {};
    };
    const t = await make({
      loggedIn: true,
      routes: {
        list: rec("list"), item: rec("item"), season: rec("season"), panel: rec("panel"), probe: rec("probe"),
        play: rec("play"), playEp: rec("playEp"), probePlay: rec("probePlay"),
      },
    });
    for (const id of ["list:k", "item:3", "season:3:2", "panel:sort:k", "probe:report:1", "play:3:start", "play:3:30:2:1:at5", "play:probe:hls2:3:30:1:1"]) {
      await t.request(id);
    }
    assert.deepEqual(seen, [
      'list {"k":"list","key":"k"}',
      'item {"k":"item","id":3}',
      'season {"k":"season","id":3,"n":2}',
      'panel {"k":"panel","type":"sort","args":["k"]}',
      'probe {"k":"probe","page":"report:1"}',
      'play {"k":"play","id":3,"what":"start"}',
      'playEp {"k":"playEp","id":3,"mid":30,"s":2,"e":1,"start":false,"at":5}',
      'probePlay {"k":"probePlay","variant":"hls2","id":3,"mid":30,"s":1,"e":1}',
    ]);
  });

  it("panels and resolve do not change the current screen", async () => {
    const t = await make({ loggedIn: true });
    await t.request("item:1");
    await t.request("panel:audio:1:10:c");
    await t.request("play:1:continue");
    assert.equal(t.ctx.current.get(), "item:1");
  });
});

describe("App.handleData and handleEvent", () => {
  it("act:item:watched:1:0:1:1 reaches onItemAct (router log line)", async () => {
    const t = await make({ loggedIn: true });
    t.app.handleData({ message: "act:item:watched:1:0:1:1" });
    assert.deepEqual(logged(t, "act item watched").map((e) => e.data), [{ args: ["1", "0", "1", "1"] }]);
    assert.deepEqual(t.app.messages.items(), ["act:item:watched:1:0:1:1"]);
  });

  it("every act module is logged", async () => {
    const t = await make({ loggedIn: true });
    for (const mod of ["login", "item", "panel", "set", "probe"]) t.app.handleData({ message: `act:${mod}:noop:1` });
    for (const mod of ["login", "item", "panel", "set", "probe"]) assert.equal(logged(t, `act ${mod} noop`).length, 1, mod);
  });

  it("messages are counted by kind; an unexpanded {context:kid} counts as pf_raw", async () => {
    const t = await make({ loggedIn: true });
    for (const m of ["pf:1001", "pf:1002", "pf:{context:kid}", "extend:abc", "extend:search", "search:input:м", "search:control:back", "garbage"]) {
      assert.doesNotThrow(() => t.app.handleData({ message: m }));
    }
    const c = t.ctx.metrics.summary().counters;
    assert.equal(c["msg:pf"], 2);
    assert.equal(c["msg:pf_raw"], 1);
    assert.equal(c["msg:extend"], 2);
    assert.equal(c["msg:searchInput"], 1);
    assert.equal(c["msg:searchControl"], 1);
    assert.equal(c["msg:unknown"], 2);
  });

  it("video snapshots and video events do not throw", async () => {
    const t = await make({ loggedIn: true });
    assert.doesNotThrow(() => t.app.handleData({ video: { info: { properties: { "kp:i": "1" } }, data: { position: 61 } } }));
    assert.doesNotThrow(() => t.app.handleData({ data: { video: { data: { position: 62 } } } }));
    assert.doesNotThrow(() => t.app.handleEvent({ event: "video:play", data: { position: 1 } }));
    assert.doesNotThrow(() => t.app.handleData(null));
    assert.doesNotThrow(() => t.app.handleEvent(undefined));
    assert.deepEqual(t.app.messages.items(), ["video", "video"]);
  });

  it("snapshots go to tracker.onSnapshot, video events to tracker.onEvent; their exceptions are logged", async () => {
    const t = await make({ loggedIn: true });
    const got: string[] = [];
    t.ctx.tracker.onSnapshot = (p: any) => {
      got.push(`snap ${p.video.data.position}`);
      throw new Error("snap");
    };
    t.ctx.tracker.onEvent = (e: any) => {
      got.push(`ev ${e.event}`);
      throw new Error("ev");
    };
    t.app.handleData({ video: { data: { position: 5 } } });
    t.app.handleEvent({ event: "video:stop" });
    t.app.handleEvent({ event: "app:resume" });
    assert.deepEqual(got, ["snap 5", "ev video:stop"]);
    assert.equal(logged(t, "handler_failed").length, 2);
  });

  it("app:suspend writes the log to kp.l2.log and the overlay to kp.out.overlay at once", async () => {
    const t = await make({ loggedIn: true });
    t.ctx.overlay.set(2001, 1, 4, { time: 597, status: 0 });
    t.app.handleEvent({ event: "app:suspend" });
    const rec = JSON.parse(t.storage.getItem("kp.l2.log") ?? "null") as { v: { msg: string }[] };
    assert.ok(Array.isArray(rec.v) && rec.v.some((e) => e.msg === "event"));
    assert.equal(typeof JSON.parse(t.storage.getItem("kp.out.overlay") ?? "null"), "string");
  });

  it("onLoggedOut → home, then replace:menu after the animations (X-3)", async () => {
    const t = await make({ loggedIn: true });
    await t.run(t.ctx.auth.logout());
    assert.ok(t.host.actions.some((a) => a.action.startsWith(`[home|lazy:replace:menu:menu:request:interaction:init@${TEST_P}|`)));
    assert.equal(t.ctx.auth.isLoggedIn(), false);
  });
});

describe("App.ready", () => {
  it("counts ready, stamps readyAt and reads MSX info in the background", async () => {
    const t = await make();
    t.host.responses.set("info", {
      info: { platform: "tizen", player: "tizen", application: { version: "0.1.165" }, system: { modelName: "QE55Q80", ipAddress: "192.0.2.7", deviceId: "x" } },
    });
    t.app.ready();
    assert.equal(t.ctx.state.readyCount, 1);
    assert.equal(t.ctx.state.readyAt, t.ctx.clock.perf());
    await t.run(Promise.resolve());
    assert.deepEqual(t.host.requests, ["info"]);
    assert.deepEqual(t.ctx.state.msxInfo, { platform: "tizen", version: "0.1.165", player: "tizen", model: "QE55Q80" });
  });

  it("does not fail when MSX gives no info", async () => {
    const t = await make();
    t.app.ready();
    await t.run(Promise.resolve());
    assert.equal(t.ctx.state.msxInfo, undefined);
    assert.equal(logged(t, "handler_failed").length, 0);
  });

  it("with login: a queued marktime goes out before the home warm-up, and the warm-up is bg (one bg slot, спец. §8.5)", async () => {
    const t = await make({ loggedIn: true });
    t.ctx.outbox.putMarktime(2001, 1, 5, 700);
    t.app.ready();
    const paths = (): string[] => t.mock.calls().map((c) => c.path);
    t.clock.ioGraceMs = 2000;
    await t.run((async () => {
      while (!paths().includes("/v1/history")) await new Promise((r) => setTimeout(r, 5));
    })());
    assert.ok(paths().indexOf("/v1/watching/marktime") >= 0);
    assert.ok(paths().indexOf("/v1/watching/marktime") < paths().indexOf("/v1/history"), paths().join());
    const warm = t.ctx.log.entries().find((e) => e.tag === "api" && e.msg.startsWith("GET /v1/history "));
    assert.match(warm?.msg ?? "", / bg$/);
  });

  it("with login starts background work without waiting for it", async () => {
    const t = await make({ loggedIn: true });
    t.app.ready();
    assert.equal(t.ctx.state.readyCount, 1);
    await t.run(Promise.resolve());
    assert.equal(logged(t, "handler_failed").length, 0);
  });
});

describe("msxInfoFrom", () => {
  it("takes model from system.model when modelName is absent and ignores junk", () => {
    assert.deepEqual(msxInfoFrom({ info: { platform: "lg", system: { model: "OLED" } } }), { platform: "lg", model: "OLED" });
    assert.deepEqual(msxInfoFrom({ platform: "default" }), { platform: "default" });
    assert.equal(msxInfoFrom(undefined), undefined);
    assert.deepEqual(msxInfoFrom({ info: { platform: 5, application: "x" } }), {});
  });
});

describe("createApp: persistence", () => {
  it(`every ${PERSIST_EVERY_MS / 1000} s the log tail goes to kp.l2.log`, async () => {
    const t = await make();
    t.ctx.log.info("test", "marker");
    await t.clock.advance(PERSIST_EVERY_MS + 1000);
    const rec = JSON.parse(t.storage.getItem("kp.l2.log") ?? "null") as { v: { msg: string }[] };
    assert.ok(rec.v.some((e) => e.msg === "marker"));
    assert.ok(rec.v.length <= 100);
  });

  it("the overlay survives a restart through kp.out.overlay", async () => {
    const storage = new MemoryStorage();
    const a = await make({ storage });
    a.ctx.overlay.set(2001, 1, 4, { time: 597, status: 0 });
    a.app.handleEvent({ event: "app:suspend" });
    const b = await make({ storage });
    assert.equal(b.ctx.overlay.get(2001, 1, 4)?.time, 597);
    assert.notEqual(a.ctx.state.bootId, b.ctx.state.bootId);
    assert.match(b.ctx.state.bootId, /^[0-9a-f]{8}$/);
  });

  it("uses the mock as the API base and P from options", async () => {
    const t = await make();
    assert.equal(t.ctx.P, TEST_P);
    assert.equal(t.ctx.flags.get().apiBase, t.mock.url);
    assert.equal(t.ctx.build.apiBase, t.mock.url);
  });
});
