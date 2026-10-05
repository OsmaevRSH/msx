import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { replaceContent } from "../../src/msx/actions.ts";
import { REPORT_FLAG, buildReport, reportLine, reportPages, sanitize } from "../../src/probe/report.ts";
import type { Report } from "../../src/probe/report.ts";
import { CHECK_IDS } from "../../src/probe/runner.ts";
import { onProbeAct } from "../../src/probe/screens.ts";
import { ids } from "../../src/router/ids.ts";
import { scanText } from "../../tools/privacy.mjs";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps.reverse()) await t.close();
  apps = [];
});

async function make(o: TestAppOptions = {}): Promise<TestApp> {
  const t = await createTestApp(o);
  apps.push(t);
  return t;
}

const PREFIX = "KPREPORT ";
/** Адреса собираются в тесте: в исходниках репозитория IPv4 запрещены (tools/privacy.mjs). */
const ip = (...octets: number[]): string => octets.join(".");
const LAN = ip(192, 168, 1, 20);
const LAN2 = ip(10, 0, 0, 1);
/** Как в tools/privacy.mjs, но любой адрес: в отчёте не должно быть и документационных. */
const IPV4 = /(?<![\d.])\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?!\.?\d)/;

function parse(line: string): Report {
  assert.ok(line.startsWith(PREFIX), line.slice(0, 20));
  return JSON.parse(line.slice(PREFIX.length)) as Report;
}

function accessToken(t: TestApp): string {
  const raw = t.storage.getItem("kp.auth.pair");
  assert.ok(raw !== null);
  const pair = JSON.parse(raw) as { access: string; refresh: string };
  return pair.access;
}

describe("sanitize (CNFR-20, spec §13)", () => {
  it("removes IPv4, tokens in query and JSON, user_code and code=…; keeps KP-* codes and numbers", () => {
    const out = sanitize({
      a: `GET http://${LAN}/v1/types?access_token=mock-at-1&x=1`,
      b: '{"refresh_token":"mock-rt-1","user_code":"AB12CD"}',
      c: `code=XYZ123 from ${LAN2}`,
      nested: [{ user_code: "AB12CD", code: "KP-CORS" }, { code: "secret-code", refresh_token: "mock-rt-2" }],
      n: 5,
      ok: true,
      version: "0.1.165",
    });
    const text = JSON.stringify(out);
    for (const bad of [LAN, LAN2, "mock-at-", "mock-rt-", "user_code", "refresh_token", "AB12CD", "XYZ123", "secret-code"]) {
      assert.ok(!text.includes(bad), bad);
    }
    assert.equal(out.nested[0]?.code, "KP-CORS");
    assert.deepEqual(out.nested[1], {});
    assert.equal(out.n, 5);
    assert.equal(out.ok, true);
    assert.equal(out.version, "0.1.165");
  });

  it("removes the given secret values wherever they appear", () => {
    assert.deepEqual(sanitize({ m: "leaked abcdefghijk twice abcdefghijk" }, ["abcdefghijk"]), { m: "leaked *** twice ***" });
  });
});

describe("buildReport and reportLine (spec §13, CM-05)", () => {
  it("no tokens, login codes or IPv4 (privacy rules); JSON after the prefix parses", async () => {
    const t = await make({ loggedIn: true });
    const token = accessToken(t);
    t.ctx.state.msxInfo = { platform: "tizen", version: "0.1.165", player: "tizen", model: `QE55 at ${ip(192, 168, 1, 7)}` };
    t.ctx.log.warn("test", `token ${token} seen from ${ip(10, 20, 30, 40)}`, { url: `https://h/v1/user?access_token=${token}`, user_code: "AB12CD" });
    t.ctx.log.info("test", "device code=QWERTY user_code=AB12CD");
    t.ctx.probe.record({ id: "CDG-01", ok: true, summary: `ответ от ${ip(172, 16, 5, 4)}, токен ${token}`, values: { status: 401 }, at: 1 });

    const line = reportLine(buildReport(t.ctx));
    assert.deepEqual(scanText("report.txt", line), []);
    for (const re of [/mock-at-/, /mock-rt-/, /user_code/, /AB12CD/, /QWERTY/, IPV4]) assert.doesNotMatch(line, re);
    assert.ok(!line.includes(token));
    assert.ok(!line.includes("\n"), "one line");

    const r = parse(line);
    assert.equal(r.version, t.ctx.build.version);
    assert.equal(r.msxInfo?.platform, "tizen");
    assert.deepEqual(r.results.map((x) => x.id), ["CDG-01"]);
    assert.equal(r.results[0]?.values.status, 401);
    assert.ok(r.log.length > 0 && r.log.length <= 30);
    assert.equal(typeof r.metrics.counters, "object");
    assert.ok(Array.isArray(r.persist.runs));
    assert.ok(Array.isArray(r.cold.recent));
  });

  it("the last 30 log entries", async () => {
    const t = await make();
    for (let i = 0; i < 50; i++) t.ctx.log.info("test", `entry ${i}`);
    const r = buildReport(t.ctx);
    assert.equal(r.log.length, 30);
    assert.equal(r.log.at(-1)?.msg, "entry 49");
  });
});

describe("reportPages: text pages for a photo (spec §13)", () => {
  it("2–4 pages of ≤ 12 lines; one row per CDG with ✓/✗/—", async () => {
    const t = await make();
    t.ctx.probe.record({ id: "CDG-05", ok: true, summary: "TTFF p50 1,9 с p95 2,4 с", values: { a1: 1900 }, at: 1 });
    t.ctx.probe.record({ id: "CDG-09", ok: false, summary: "квота 900 КБ", values: {}, at: 1 });
    t.ctx.log.error("test", "boom");
    const pages = reportPages(buildReport(t.ctx));
    assert.ok(pages.length >= 2 && pages.length <= 4, String(pages.length));
    for (const p of pages) assert.ok(p.length > 0 && p.length <= 12, String(p.length));
    const all = pages.flat();
    for (const id of CHECK_IDS) assert.equal(all.filter((l) => l.startsWith(`${id} `)).length, 1, id);
    assert.ok(all.includes("CDG-05 ✓ TTFF p50 1,9 с p95 2,4 с"));
    assert.ok(all.includes("CDG-09 ✗ квота 900 КБ"));
    assert.ok(all.some((l) => l.startsWith("CDG-07 — ")));
    assert.ok(all.some((l) => /a2.*на слух/.test(l)), "the user checks the second audio by ear");
    assert.ok(all.some((l) => /рывк/.test(l)), "the user judges the grid smoothness");
    assert.ok(all.some((l) => l.includes("boom")), "warnings and errors page");
  });

  it("a dev flag streamMode=hls2 is stored and shown in the report", async () => {
    const storage = new MemoryStorage();
    const t = await make({ storage });
    await t.run(onProbeAct(t.ctx, "flag", ["streamMode", "hls2"]));
    const t2 = await make({ storage, mock: t.mock });
    const r = buildReport(t2.ctx);
    assert.deepEqual(r.flags, { streamMode: "hls2" });
    assert.ok(reportPages(r)[0]?.some((l) => l.includes("streamMode=hls2")));
    assert.match(reportLine(r), /"flags":\{"streamMode":"hls2"\}/);
  });
});

describe("probe:report:<n> screen", () => {
  const items = (root: MsxContentRoot): MsxContentItem[] => root.pages?.[0]?.items ?? [];
  const button = (root: MsxContentRoot, label: string): MsxContentItem | undefined => items(root).find((i) => i.label === label);

  it("large text with {br}; «Назад»/«Дальше» replace the page in place; the last page has no «Дальше»", async () => {
    const t = await make();
    t.ctx.log.error("test", "boom");
    const n = reportPages(buildReport(t.ctx)).length;
    const first = (await t.request(ids.probe("report:1"))) as MsxContentRoot;
    assert.equal(first.type, "pages");
    assert.equal(first.flag, REPORT_FLAG);
    assert.equal(first.cache, false);
    const text = items(first)[0];
    assert.equal(text?.type, "space");
    assert.match(String(text?.text), /\{br\}/);
    assert.match(String(text?.text), /CDG-01/);
    assert.equal(button(first, "Назад")?.action, "back");
    assert.equal(button(first, "Дальше")?.action, replaceContent(REPORT_FLAG, TEST_P, ids.probe("report:2")));

    const last = (await t.request(ids.probe(`report:${n}`))) as MsxContentRoot;
    assert.equal(button(last, "Дальше"), undefined);
    assert.equal(button(last, "Назад")?.action, replaceContent(REPORT_FLAG, TEST_P, ids.probe(`report:${n - 1}`)));
    assert.match(String(last.headline), new RegExp(`${n} из ${n}`));

    const beyond = (await t.request(ids.probe("report:99"))) as MsxContentRoot;
    assert.deepEqual(beyond.headline, last.headline);
  });
});
