import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickTestTitle } from "../../src/probe/checks-api.ts";
import type { CheckId, CheckResult } from "../../src/probe/runner.ts";
import { PROBE_KEYS, loadCold, loadPersist, loadSchema, loadTitle } from "../../src/probe/store.ts";
import type { CallRecord } from "../../tools/kpmock/server.ts";
import { watchKey } from "../../tools/kpmock/state.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";
import { FAKE_EPOCH, FakeClock } from "../helpers/fake-clock.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";

let apps: TestApp[] = [];

afterEach(async () => {
  // Сначала стенды без своего mock: они делят mock с первым стендом.
  for (const t of apps.reverse()) await t.close();
  apps = [];
});

async function make(o: TestAppOptions = {}): Promise<TestApp> {
  const t = await createTestApp(o);
  apps.push(t);
  return t;
}

const run = (t: TestApp, id: CheckId): Promise<CheckResult> => t.run(t.ctx.probe!.run(id));
const apiCalls = (t: TestApp): CallRecord[] => t.mock.calls().filter((c) => c.path.startsWith("/v1/") || c.path.startsWith("/oauth2/"));
const onlyTypesProbe = (calls: CallRecord[]): boolean =>
  calls.every((c) => c.method === "GET" && c.path === "/v1/types" && c.query === "access_token=x");

async function ready(t: TestApp): Promise<void> {
  t.app.ready();
  await t.run(Promise.resolve());
}

describe("CDG-01: CORS GET and the KP-CORS verdict (spec §5.3, §16.2, decision R-12)", () => {
  it("normal mock: the 401 body is readable → ✓ status 401", async () => {
    const t = await make();
    const r = await run(t, "CDG-01");
    assert.equal(r.ok, true);
    assert.equal(r.values.status, 401);
    assert.equal(r.values.readable, true);
    const calls = apiCalls(t);
    assert.equal(calls.length, 1);
    assert.ok(onlyTypesProbe(calls));
  });

  it("CORS off: plain fetch fails and no-cors passes 3 times with 5 s pauses → ✗ KP-CORS", async () => {
    const t = await make();
    t.mock.setScenario({ corsOff: true });
    const t0 = t.clock.now();
    const r = await run(t, "CDG-01");
    assert.equal(r.ok, false);
    assert.equal(r.values.code, "KP-CORS");
    assert.equal(r.values.attempts, 3);
    assert.ok(t.clock.now() - t0 >= 10_000, "two pauses of 5 s");
    const calls = apiCalls(t);
    assert.equal(calls.length, 6);
    assert.ok(onlyTypesProbe(calls));
    assert.equal(calls.filter((c) => c.origin !== undefined).length, 3, "3 cors requests carry Origin, 3 no-cors do not");
  });

  it("every connection dropped: no-cors fails too → ✗ KP-NET, not KP-CORS", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: ".*", drop: true }] });
    const r = await run(t, "CDG-01");
    assert.equal(r.ok, false);
    assert.equal(r.values.code, "KP-NET");
    assert.ok(onlyTypesProbe(apiCalls(t)));
  });
});

describe("CDG-02: CORS POST to /oauth2/device", () => {
  it("✓ with all 5 fields; the code itself is not kept", async () => {
    const t = await make();
    const r = await run(t, "CDG-02");
    assert.equal(r.ok, true, r.summary);
    assert.equal(r.values.status, 200);
    assert.equal(r.values.fields, 5);
    const calls = apiCalls(t);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "POST");
    assert.equal(calls[0]?.path, "/oauth2/device");
    assert.match(calls[0]?.query ?? "", /grant_type=device_code/);
    assert.equal(calls[0]?.contentType, undefined, "parameters in query, empty body");
    const text = JSON.stringify(r);
    assert.ok(!text.includes("mock-dc-"));
    for (const dc of t.mock.state.deviceCodes.values()) assert.ok(!text.includes(dc.userCode));
  });

  it("with CORS off it is ✗ KP-NET: KP-CORS comes only from CDG-01", async () => {
    const t = await make();
    t.mock.setScenario({ corsOff: true });
    const r = await run(t, "CDG-02");
    assert.equal(r.ok, false);
    assert.equal(r.values.code, "KP-NET");
    assert.ok(!JSON.stringify(r).includes("KP-CORS"));
  });
});

describe("CDG-03: POST body accepted by /v1/device/notify", () => {
  const deviceTitle = (t: TestApp): string | undefined => [...t.mock.state.devices.values()][0]?.title;

  for (const postBody of ["form", "query"] as const) {
    it(`✓ and the original device title is restored (postBody: ${postBody})`, async () => {
      const t = await make({ loggedIn: true, flags: { postBody } });
      assert.equal(deviceTitle(t), "kpmock TV");
      const r = await run(t, "CDG-03");
      assert.equal(r.ok, true, r.summary);
      assert.equal(deviceTitle(t), "kpmock TV");
      const notify = apiCalls(t).filter((c) => c.path === "/v1/device/notify");
      assert.equal(notify.length, 2);
      for (const c of notify) {
        if (postBody === "form") {
          assert.match(c.contentType ?? "", /^application\/x-www-form-urlencoded/);
          assert.ok(!c.query.includes("title="));
        } else {
          assert.equal(c.contentType, undefined);
          assert.match(c.query, /title=/);
        }
      }
    });
  }

  it("without login → not run, ok null", async () => {
    const t = await make();
    const r = await run(t, "CDG-03");
    assert.equal(r.ok, null);
    assert.equal(apiCalls(t).length, 0);
  });
});

describe("CDG-04: login and API timings, schema fingerprint", () => {
  it("✓ with p50/p95, active subscription and a value-free fingerprint", async () => {
    const t = await make({ loggedIn: true });
    const r = await run(t, "CDG-04");
    assert.equal(r.ok, true, r.summary);
    assert.equal(r.values.subscription, true);
    for (const k of ["p50", "p95", "itemsP50", "itemsP95", "itemP50", "itemP95"]) assert.equal(typeof r.values[k], "number", k);
    const calls = apiCalls(t);
    assert.equal(calls.filter((c) => c.path === "/v1/items" && /perpage=48/.test(c.query)).length, 3);

    const schema = loadSchema(t.ctx.store);
    assert.ok(schema !== undefined);
    assert.equal(schema["/v1/items/:id"]?.["item.seasons[].episodes[].audios[].index"], "number");
    for (const ep of ["/v1/user", "/v1/items", "/v1/items/media-links", "/v1/watching", "/v1/history", "/v1/bookmarks", "/v1/watching/serials"]) {
      assert.ok(schema[ep] !== undefined && Object.keys(schema[ep]).length > 0, ep);
    }
    const text = JSON.stringify(schema);
    for (const v of ["Тестовый", "Тестер", "tester", "mock-at-", "Серия", "kp200"]) assert.ok(!text.includes(v), v);
  });
});

describe("CDG-08: marktime and toggle on the test title", () => {
  it("pickTestTitle: a serial with ≥ 2 seasons and ≥ 2 audios in S1E1, stored and reused", async () => {
    const t = await make({ loggedIn: true });
    const title = await t.run(pickTestTitle(t.ctx));
    assert.ok(title !== undefined);
    assert.ok(title.seasons >= 2);
    assert.ok(title.audios >= 2);
    assert.equal(title.s1e1.s, 1);
    assert.equal(title.s2e1.s, 2);
    assert.deepEqual(loadTitle(t.ctx.store), title);
    const n = apiCalls(t).length;
    assert.deepEqual(await t.run(pickTestTitle(t.ctx)), title);
    assert.equal(apiCalls(t).length, n, "second call answers from kp.cfg.probe.title");
  });

  for (const start of [undefined, { time: 600, status: 0 as const }, { time: 2500, status: 1 as const }]) {
    it(`✓ and S1E1 time/status end as they were (${start === undefined ? "never watched" : `status ${start.status}`})`, async () => {
      const t = await make({ loggedIn: true });
      const title = await t.run(pickTestTitle(t.ctx));
      assert.ok(title !== undefined);
      const key = watchKey(title.id, 1, title.s1e1.e);
      if (start !== undefined) t.mock.state.watching.set(key, { ...start, updated: 1 });
      const r = await run(t, "CDG-08");
      assert.equal(r.ok, true, r.summary);
      assert.equal(r.values.id, title.id);
      const rec = t.mock.state.watching.get(key);
      assert.equal(rec?.time ?? 0, start?.time ?? 0);
      assert.equal(rec?.status ?? -1, start?.status ?? -1);
    });
  }

  it("lost toggle response → ✗ «проверьте отметку на сайте», no automatic repeat (CM-01)", async () => {
    const t = await make({ loggedIn: true });
    await t.run(pickTestTitle(t.ctx));
    t.mock.setScenario({ toggleLostResponse: 1 });
    const r = await run(t, "CDG-08");
    assert.equal(r.ok, false);
    assert.match(r.summary, /проверьте отметку на сайте/);
    assert.equal(apiCalls(t).filter((c) => c.path === "/v1/watching/toggle").length, 1);
  });

  it("toggle answers the old state → ✗ and no toggle back that would flip the mark away from the original (CM-01)", async () => {
    const t = await make({ loggedIn: true });
    await t.run(pickTestTitle(t.ctx));
    let toggles = 0;
    t.ctx.api.toggle = async () => {
      toggles += 1;
      return { watched: 0 };
    };
    const r = await run(t, "CDG-08");
    assert.equal(r.ok, false);
    assert.equal(r.values.toggleOk, false);
    assert.equal(toggles, 1);
  });
});

describe("CDG-09: storage survives restarts, quota, purge of kp.l2.* only", () => {
  it("quota ≈ 3 MB, kp.auth.* intact; next start records authOk/l2Ok", async () => {
    const storage = new MemoryStorage({ quotaBytes: 3_000_000 });
    const t = await make({ storage, loggedIn: true });
    await ready(t);
    t.ctx.probe!.persistWrite();
    const pair = storage.getItem("kp.auth.pair");
    assert.ok(pair !== null);
    const r = await run(t, "CDG-09");
    assert.equal(r.ok, true, r.summary);
    const quota = r.values.quotaBytes;
    assert.equal(typeof quota, "number");
    assert.ok((quota as number) > 2_950_000 && (quota as number) <= 3_000_000, String(quota));
    assert.equal(r.values.authKept, true);
    assert.equal(storage.getItem("kp.auth.pair"), pair);
    assert.notEqual(storage.getItem("kp.auth.probeMarker"), null);
    assert.equal(storage.getItem("kp.auth.probeMarker2"), null);
    assert.ok(!t.ctx.store.keys("l2").some((k) => k.startsWith("probeq.")));

    const t2 = await make({ storage, mock: t.mock });
    await ready(t2);
    const runs = loadPersist(t2.ctx.store).runs;
    assert.equal(runs.length, 2);
    assert.equal(runs[0]?.authOk, false, "the first start was before «Записать»");
    assert.equal(runs[1]?.authOk, true);
    assert.equal(runs[1]?.l2Ok, true);
    assert.equal(runs[1]?.l2Blocks, 10);
    const again = await run(t2, "CDG-09");
    assert.equal(again.values.restarts, 1);
    assert.equal(again.values.survived, 1);
  });

  it("a lost L2 block or a lost marker shows up in the next start's record", async () => {
    const storage = new MemoryStorage();
    const t = await make({ storage });
    t.ctx.probe!.persistWrite();
    storage.removeItem("kp.l2.probe.c3");
    const t2 = await make({ storage, mock: t.mock });
    await ready(t2);
    assert.deepEqual(loadPersist(t2.ctx.store).runs.map((r) => [r.authOk, r.l2Ok, r.l2Blocks]), [[true, false, 9]]);

    storage.removeItem("kp.auth.probeMarker");
    const t3 = await make({ storage, mock: t.mock });
    await ready(t3);
    assert.deepEqual(loadPersist(t3.ctx.store).runs.at(-1)?.authOk, false);
  });

  it("blocks evicted by the L2 budget or purged on quota are not a loss; losing a remaining block still is", async () => {
    const storage = new MemoryStorage();
    const t = await make({ storage });
    t.ctx.probe!.persistWrite();
    await t.clock.advance(1000);
    t.ctx.l2.put("item:1:", "x".repeat(300_000));
    t.ctx.l2.flush();
    await t.clock.advance(0);
    const left = t.ctx.store.keys("l2").filter((k) => k.startsWith("probe.c"));
    assert.ok(left.length > 0 && left.length < 10, String(left.length));
    const t2 = await make({ storage, mock: t.mock });
    await ready(t2);
    assert.deepEqual(loadPersist(t2.ctx.store).runs.map((r) => [r.authOk, r.l2Ok, r.l2Blocks]), [[true, true, left.length]]);

    storage.removeItem(`kp.l2.${left[0]}`);
    const t3 = await make({ storage, mock: t.mock });
    await ready(t3);
    assert.deepEqual(loadPersist(t3.ctx.store).runs.at(-1)?.l2Ok, false);

    t3.ctx.store.removeNs("l2");
    await t3.clock.advance(0);
    const t4 = await make({ storage, mock: t.mock });
    await ready(t4);
    assert.deepEqual(loadPersist(t4.ctx.store).runs.at(-1)?.l2Ok, true);
  });

  it("no quota within 8 MB → capped, still ✓", async () => {
    const t = await make();
    const r = await run(t, "CDG-09");
    assert.equal(r.ok, true, r.summary);
    assert.equal(r.values.capped, true);
    assert.ok((r.values.quotaBytes as number) >= 8_000_000);
    assert.ok(!t.ctx.store.keys("l2").some((k) => k.startsWith("probeq.")));
  });

  it("quota below 1.5 MB → ✗", async () => {
    const t = await make({ storage: new MemoryStorage({ quotaBytes: 1_000_000 }) });
    const r = await run(t, "CDG-09");
    assert.equal(r.ok, false);
  });
});

describe("CDG-10: cold start against CNFR-01/02", () => {
  it("after ready and init — a record with eval, ready and init times", async () => {
    const t = await make();
    await ready(t);
    await t.request("init");
    const r = await run(t, "CDG-10");
    const cold = loadCold(t.ctx.store);
    assert.equal(cold.recent.length, 1);
    const rec = cold.recent[0];
    for (const k of ["evalMs", "readyMs", "initMs"] as const) assert.equal(typeof rec?.[k], "number", k);
    assert.equal(rec?.readyMs, t.ctx.state.readyAt);
    assert.equal(cold.first?.initMs, rec?.initMs);
    assert.equal(r.ok, true, r.summary);
  });

  it("a second ready in the same boot adds no record", async () => {
    const t = await make();
    await ready(t);
    await ready(t);
    assert.equal(loadCold(t.ctx.store).recent.length, 1);
  });

  it("p95 of cached starts is judged against 800 ms, the first start against 2500 ms; last 10 kept", async () => {
    const storage = new MemoryStorage();
    const first = await make({ storage, clock: new FakeClock(FAKE_EPOCH, 2000) });
    await ready(first);
    let last: TestApp = first;
    for (let i = 0; i < 11; i++) {
      last = await make({ storage, mock: first.mock, clock: new FakeClock(FAKE_EPOCH, 300 + i) });
      await ready(last);
    }
    const ok = await run(last, "CDG-10");
    assert.equal(ok.ok, true, ok.summary);
    assert.equal(ok.values.firstReadyMs, 2000);
    assert.equal(loadCold(last.ctx.store).recent.length, 10);

    const slow = await make({ storage, mock: first.mock, clock: new FakeClock(FAKE_EPOCH, 900) });
    await ready(slow);
    const bad = await run(slow, "CDG-10");
    assert.equal(bad.ok, false, bad.summary);
  });
});

describe("ProbeRunner", () => {
  const API: CheckId[] = ["CDG-01", "CDG-02", "CDG-03", "CDG-04", "CDG-08", "CDG-09", "CDG-10"];

  it("runApi without login: 01, 02, 09, 10 run; 03, 04, 08 wait for login", async () => {
    const t = await make();
    await ready(t);
    const rs = await t.run(t.ctx.probe!.runApi());
    assert.deepEqual(rs.map((r) => r.id), API);
    for (const r of rs) {
      if (["CDG-03", "CDG-04", "CDG-08"].includes(r.id)) assert.equal(r.ok, null, r.id);
      else assert.equal(r.ok, true, `${r.id}: ${r.summary}`);
    }
  });

  it("runApi with login: all ✓; results survive a restart in kp.cfg.probe.results", async () => {
    const storage = new MemoryStorage();
    const t = await make({ storage, loggedIn: true });
    await ready(t);
    const rs = await t.run(t.ctx.probe!.runApi());
    for (const r of rs) assert.equal(r.ok, true, `${r.id}: ${r.summary}`);
    assert.ok(storage.getItem(`kp.cfg.${PROBE_KEYS.results}`) !== null);

    const t2 = await make({ storage, mock: t.mock });
    assert.deepEqual(t2.ctx.probe!.results().map((r) => r.id), API);
  });

  it("a «needs login» result does not overwrite an earlier one", async () => {
    const t = await make();
    const earlier: CheckResult = { id: "CDG-04", ok: true, summary: "раньше", values: {}, at: 1 };
    t.ctx.probe!.record(earlier);
    const r = await run(t, "CDG-04");
    assert.equal(r.ok, null);
    assert.deepEqual(t.ctx.probe!.results().find((x) => x.id === "CDG-04"), earlier);
  });

  it("TV checks return the recorded result (stage 23 records them)", async () => {
    const t = await make();
    assert.equal((await run(t, "CDG-05")).ok, null);
    const rec: CheckResult = { id: "CDG-05", ok: true, summary: "TTFF", values: { ttff: 1900 }, at: 5 };
    t.ctx.probe!.record(rec);
    assert.deepEqual(await run(t, "CDG-05"), rec);
  });

  it("concurrent runs of one check share a single pass", async () => {
    const t = await make();
    const [a, b] = await t.run(Promise.all([t.ctx.probe!.run("CDG-01"), t.ctx.probe!.run("CDG-01")]));
    assert.equal(a, b);
    assert.equal(apiCalls(t).length, 1);
  });
});
