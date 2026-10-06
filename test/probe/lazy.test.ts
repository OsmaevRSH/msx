import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AppContext } from "../../src/app/context.ts";
import type { MsxContentRoot, MsxResolveResponse } from "../../src/msx/types.ts";
import { pickTestTitle } from "../../src/probe/checks-api.ts";
import * as probeEntry from "../../src/probe/entry.ts";
import { PROBE_LOAD_TIMEOUT_MS } from "../../src/probe/lazy.ts";
import type { ProbeLoad, ProbeModule } from "../../src/probe/lazy.ts";
import { loadCold, loadPersist } from "../../src/probe/store.ts";
import { ids, msgs } from "../../src/router/ids.ts";
import { RETRY_CONTENT, errorText } from "../../src/screens/error.ts";
import type { TestApp } from "../helpers/harness.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";
import { EP, kpProps, load, pass, player, useApps, waitFor } from "../progress/progress-rig.ts";

// Пробник в отдельном probe.js (этап 23b): в app.js — замеры каждого запуска (CDG-09, CDG-10) и загрузчик; остальное
// грузится по первому маршруту пробника. Отказ загрузки — экран S14 с KP-NET и «Повторить» (спец. §12).

const make = useApps();

/** Загрузчик с журналом вызовов; `next` — исход очередного вызова (по умолчанию — модуль пробника). */
function loader(): ProbeLoad & { calls: number; next: (() => Promise<ProbeModule>)[] } {
  const f = Object.assign(
    (): Promise<ProbeModule> => {
      f.calls += 1;
      return (f.next.shift() ?? (() => Promise.resolve(probeEntry)))();
    },
    { calls: 0, next: [] as (() => Promise<ProbeModule>)[] },
  );
  return f;
}

interface Deferred { promise: Promise<ProbeModule>; resolve: () => void; reject: (e: Error) => void }

/** Загрузка, которую тест завершает сам: модулем `mod` (по умолчанию — пробник) или отказом. */
function deferred(mod: ProbeModule = probeEntry): Deferred {
  let resolve = (): void => {};
  let reject = (_: Error): void => {};
  const promise = new Promise<ProbeModule>((ok, fail) => {
    resolve = () => ok(mod);
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Модуль пробника со счётчиком регистраций (`install`). */
function counted(): ProbeModule & { installs: number } {
  const m = Object.assign({}, probeEntry, { installs: 0 });
  m.install = (ctx) => {
    m.installs += 1;
    probeEntry.install(ctx);
  };
  return m;
}

const offline = (): Promise<ProbeModule> => Promise.reject(new TypeError("Failed to fetch"));

function assertNetError(root: MsxContentRoot): void {
  const items = root.pages?.[0]?.items ?? [];
  assert.match(String(items[0]?.text), /KP-NET/);
  assert.equal(items[1]?.label, "Повторить");
  assert.equal(items[1]?.action, RETRY_CONTENT);
}

const probeLoaded = (t: TestApp): boolean => t.ctx.probe !== undefined;

describe("probe.js: loaded on first use (stage 23b)", () => {
  it("ctx.probe is optional in AppContext: there is no ProbeRunner until probe.js is loaded", async () => {
    const optional: undefined extends AppContext["probe"] ? true : false = true;
    assert.equal(optional, true);
    const t = await make({ probe: "lazy" });
    assert.equal(t.ctx.probe, undefined);
    await t.request(ids.probe());
    assert.ok(t.ctx.probe !== undefined);
  });

  it("init, home, ready and an ordinary playback do not load it; ready() still records the cold start and the storage run", async () => {
    const l = loader();
    const t = await make({ probe: l });
    await t.request("init");
    t.app.ready();
    await t.request("home");
    load(t);
    player(t, "play", { position: 0, duration: EP.duration });
    player(t, "stop", { position: 30 });
    await pass(t, 1000);
    assert.equal(l.calls, 0);
    assert.equal(probeLoaded(t), false);
    assert.equal(loadCold(t.ctx.store).recent.length, 1, "CDG-10 measured on every start");
    assert.equal(loadPersist(t.ctx.store).runs.length, 1, "CDG-09 run recorded on every start");
  });

  it("concurrent probe routes share one load and answer after it", async () => {
    const l = loader();
    const d = deferred();
    l.next.push(() => d.promise);
    const t = await make({ probe: l });
    const screen = t.app.handleRequest(ids.probe(), {});
    const dev = t.app.handleRequest(ids.dev(), {});
    await pass(t, 100);
    assert.equal(l.calls, 1);
    d.resolve();
    const [s, v] = (await t.run(Promise.all([screen, dev]))) as MsxContentRoot[];
    assert.equal(s?.headline, "Диагностика");
    assert.equal(v?.headline, "Для разработчика");
    assert.ok(probeLoaded(t));
    await t.request(ids.probe("report:1"));
    assert.equal(l.calls, 1, "loaded once per page");
  });

  it("act:probe:* before the screen loads the probe and runs the action", async () => {
    const l = loader();
    const t = await make({ probe: l });
    t.app.handleData({ message: msgs.act("probe", "persistWrite") });
    await waitFor(t, () => t.storage.getItem("kp.auth.probeMarker") !== null, "persist marker");
    assert.equal(l.calls, 1);
  });

  it("a probe tile resolve loads the probe; its player events then reach the TV checks (CDG-05)", async () => {
    const l = loader();
    const t = await make({ probe: l });
    const title = await t.run(pickTestTitle(t.ctx));
    assert.ok(title !== undefined);
    const u = title.s1e1;
    const res = (await t.request(ids.probePlay("a1", title.id, u.mid, u.s, u.e))) as MsxResolveResponse;
    assert.equal(res.error, undefined, res.error ?? "");
    assert.equal(res.properties?.["kp:p"], "a1");
    assert.equal(l.calls, 1);

    const unit = { item: title.id, mid: u.mid, season: u.s, video: u.e, duration: u.duration };
    load(t, kpProps(unit, { "kp:p": "a1" }), 0, u.duration);
    player(t, "play", { position: 0, duration: u.duration });
    await pass(t, 100);
    const r = t.ctx.probe!.results().find((x) => x.id === "CDG-05");
    assert.equal(typeof r?.values.a1, "number", "TTFF of the a1 tile");
  });

  it("a failed load → S14 with KP-NET and «Повторить»; the retry loads again", async () => {
    const l = loader();
    l.next.push(offline);
    const t = await make({ probe: l });
    assertNetError((await t.request(ids.probe())) as MsxContentRoot);
    assert.equal(probeLoaded(t), false);
    const again = (await t.request(ids.probe())) as MsxContentRoot;
    assert.equal(again.headline, "Диагностика");
    assert.equal(l.calls, 2);
  });

  it("a failed load answers a probe tile resolve with { error } of KP-NET", async () => {
    const l = loader();
    l.next.push(offline);
    const t = await make({ probe: l });
    const res = (await t.request(ids.probePlay("a1", EP.item, EP.mid, EP.season, EP.video))) as MsxResolveResponse;
    assert.equal(res.error, errorText(new TypeError("x")).text);
  });

  it(`a hanging load: KP-NET after ${PROBE_LOAD_TIMEOUT_MS / 1000} s; a retry meanwhile inserts no second probe.js`, async () => {
    const l = loader();
    const mod = counted();
    const d = deferred(mod);
    l.next.push(() => d.promise);
    const t = await make({ probe: l });
    const t0 = t.clock.now();
    assertNetError((await t.request(ids.probe())) as MsxContentRoot);
    assert.ok(t.clock.now() - t0 >= PROBE_LOAD_TIMEOUT_MS);
    const again = t.app.handleRequest(ids.probe(), {});
    await pass(t, 100);
    assert.equal(l.calls, 1, "the retry waits for the first probe.js, which may still arrive");
    d.resolve();
    assert.equal(((await t.run(again)) as MsxContentRoot).headline, "Диагностика");
    assert.deepEqual([l.calls, mod.installs], [1, 1]);
  });

  it("probe.js that arrives after the timeout is installed once; the next probe route does not load it again", async () => {
    const l = loader();
    const mod = counted();
    const d = deferred(mod);
    l.next.push(() => d.promise);
    const t = await make({ probe: l });
    assertNetError((await t.request(ids.probe())) as MsxContentRoot);
    d.resolve();
    await pass(t, 100);
    assert.ok(probeLoaded(t));
    assert.equal(((await t.request(ids.probe())) as MsxContentRoot).headline, "Диагностика");
    assert.equal(((await t.request(ids.dev())) as MsxContentRoot).headline, "Для разработчика");
    assert.deepEqual([l.calls, mod.installs], [1, 1]);
  });

  it("a late probe.js of another version is refused, not installed; the retry loads again", async () => {
    const l = loader();
    const d = deferred();
    l.next.push(() => d.promise);
    const t = await make({ probe: l });
    assertNetError((await t.request(ids.probe())) as MsxContentRoot);
    // Так отвечает загрузчик src/main.ts, когда `kpProbe.v` не совпал с версией app.js.
    d.reject(new Error("probe.js version 0123456789, expected abcdefabcd"));
    await pass(t, 100);
    assert.equal(probeLoaded(t), false);
    assert.equal(((await t.request(ids.probe())) as MsxContentRoot).headline, "Диагностика");
    assert.equal(l.calls, 2);
  });

  it("CDG-09: probe.c* blocks evicted by the L2 budget are noted without the probe loaded", async () => {
    const storage = new MemoryStorage();
    const t = await make({ storage });
    t.ctx.probe!.persistWrite();
    const l = loader();
    const t2 = await make({ storage, mock: t.mock, probe: l });
    t2.ctx.l2.put("item:1:", "x".repeat(300_000));
    t2.ctx.l2.flush();
    await t2.clock.advance(0);
    const left = t2.ctx.store.keys("l2").filter((k) => k.startsWith("probe.c")).length;
    assert.ok(left > 0 && left < 10, String(left));
    const t3 = await make({ storage, mock: t.mock, probe: "lazy" });
    t3.app.ready();
    await t3.run(Promise.resolve());
    assert.deepEqual(loadPersist(t3.ctx.store).runs.map((r) => [r.authOk, r.l2Ok, r.l2Blocks]), [[true, true, left]]);
    assert.equal(l.calls, 0);
  });
});
