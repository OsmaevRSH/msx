import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { cdnProfile } from "../../tools/kpmock/scenario.ts";
import type { Scenario } from "../../tools/kpmock/scenario.ts";
import { startMock } from "../../tools/kpmock/server.ts";
import type { MockServer } from "../../tools/kpmock/server.ts";

// CDN mock для теста скорости (спец. §14.2, §16.7): TS-сегменты плейлиста hls v1, CORS у CDN по сценарию, локации
// `cdnLocs` — задержка до заголовков и скорость тела по `?loc=` запроса.

const ACAO = "access-control-allow-origin";
const S1E1 = FIX.SERIAL_BIG * 1000 + 1;

describe("kpmock CDN for the speed test", () => {
  let mock: MockServer;
  let token: string;

  /** hls v1 файла S1E1 с `loc`: мастер, плейлист серий и его сегменты. */
  async function chain(loc: string): Promise<{ master: string; index: string; segs: string[] }> {
    const r = await fetch(`${mock.url}/v1/items/media-links?mid=${S1E1}&access_token=${token}`);
    const files = ((await r.json()) as { files: { urls: { hls: string } }[] }).files;
    const master = files[0]!.urls.hls.replace("loc=nl", `loc=${loc}`);
    const m = await (await fetch(master)).text();
    const index = new URL(m.trim().split("\n").at(-1) ?? "", master).href;
    const i = await (await fetch(index)).text();
    const segs = i.split("\n").filter((l) => l.startsWith("seg-")).map((l) => new URL(l, index).href);
    return { master, index, segs };
  }

  before(async () => { mock = await startMock({ port: 0 }); });
  after(async () => { await mock.close(); });
  beforeEach(() => {
    mock.reset();
    token = mock.issueToken().access;
  });

  it("segments of hls v1: video/mp2t of `segBytes` with the TS sync byte every 188 bytes; `loc` is kept down the chain", async () => {
    mock.setScenario({ segBytes: 188 * 10 });
    const { index, segs } = await chain("de");
    assert.match(index, /index-v1a1\.m3u8\?loc=de$/);
    assert.equal(segs.length, 3);
    assert.ok(segs.every((s) => s.endsWith("?loc=de")));
    const r = await fetch(segs[0]!);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "video/mp2t");
    const body = new Uint8Array(await r.arrayBuffer());
    assert.equal(body.length, 1880);
    assert.ok([0, 188, 1692].every((i) => body[i] === 0x47));
    const foreign = segs[0]!.replace(/\/cdn\/hls\/[^/]+\//, "/cdn/hls/bm90LWEtdG9rZW4/");
    assert.equal((await fetch(foreign)).status, 403, "a token of another format");
  });

  it("CORS of the CDN: none by default (the live CDN is not verified), ACAO * with `cdnCors`", async () => {
    const { master, index, segs } = await chain("nl");
    for (const u of [master, index, segs[0]!]) assert.equal((await fetch(u)).headers.get(ACAO), null, u);
    mock.setScenario({ cdnCors: true });
    for (const u of [master, index, segs[0]!]) assert.equal((await fetch(u)).headers.get(ACAO), "*", u);
  });

  it("`cdnLocs`: latency before the headers and the body rate by `?loc=` (lower bounds only: CI speed does not matter)", async () => {
    mock.setScenario({ segBytes: 256 * 1024, cdnLocs: { ru: { latencyMs: 150, kbps: 8 * 1024 } } });
    const { segs } = await chain("ru");
    const t0 = performance.now();
    const r = await fetch(segs[0]!);
    const headers = performance.now() - t0;
    const n = (await r.arrayBuffer()).byteLength;
    const total = performance.now() - t0;
    assert.equal(n, 256 * 1024);
    assert.ok(headers >= 140, `headers after ${headers} ms`);
    // 256 КБ при 8 Мбит/с — 256 мс.
    assert.ok(total >= 140 + 230, `body after ${total} ms`);
    const scenario = (await (await fetch(`${mock.url}/__mock/scenario`)).json()) as Scenario;
    assert.deepEqual(cdnProfile(scenario, new URL(segs[0]!)), { latencyMs: 150, kbps: 8 * 1024 });
    assert.equal(cdnProfile(scenario, new URL(segs[0]!.replace("loc=ru", "loc=nl"))), undefined, "nl has no profile: at once");
  });
});
