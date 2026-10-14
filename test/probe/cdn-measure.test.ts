import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FetchLike } from "../../src/api/transport.ts";
import { sleep } from "../../src/core/clock.ts";
import { cspAllows } from "../../src/probe/cdn-hosts.ts";
import { Meter, hostOf, parseMaster, parseMedia, pickVariant } from "../../src/probe/cdn-measure.ts";
import type { Measure, MeterOptions } from "../../src/probe/cdn-measure.ts";
import { FakeClock } from "../helpers/fake-clock.ts";

// Замер локации CDN (спец. §16.7): разбор плейлистов, ступени точности по CORS, лимит байт, срок и темп запросов.
// Сеть — сценарий в поддельном времени: ответ через `ttfb` мс, тело кусками по 64 КБ со скоростью `kbps`.

const FRONT = "https://cdn2site.com";
const NODE = "https://3ca02ace-9c82-11eb-9ce3-04d4c439219f.ams-static-01.cdntogo.net";
const MASTER = `${FRONT}/hls/TOKEN/a/b3/file.mp4/master-v1a1.m3u8?loc=nl`;
const INDEX = `${NODE}/hls/TOKEN/a/b3/file.mp4/index-v1a1.m3u8?loc=nl`;
const seg = (n: number): string => `${NODE}/hls/TOKEN/a/b3/file.mp4/seg-${n}-v1-a1.ts?loc=nl`;
const MB = 1024 * 1024;
const CHUNK = 64 * 1024;
const OPTS: MeterOptions = { capBytes: 3 * MB, deadlineMs: 10_000, gapMs: 200, textCap: 512 * 1024, maxSegments: 3 };

const masterText = (variant = INDEX): string =>
  ["#EXTM3U", "#EXT-X-VERSION:3", '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2215538,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"', variant, ""].join("\n");
const indexText = (n = 3): string => [
  "#EXTM3U", "#EXT-X-TARGETDURATION:10", "#EXT-X-PLAYLIST-TYPE:VOD",
  ...Array.from({ length: n }, (_, i) => [`#EXTINF:10.000,`, `seg-${i + 1}-v1-a1.ts?loc=nl`]).flat(), "#EXT-X-ENDLIST", "",
].join("\n");

interface Route {
  /** Тело: текст или размер в байтах. */
  body: string | number;
  status?: number;
  ttfb?: number;
  /** Скорость тела, кбит/с (бит в мс); без неё тело сразу. */
  kbps?: number;
  /** false — ответ без ACAO: `cors` падает TypeError, `no-cors` — непрозрачный ответ. */
  cors?: boolean;
  /** Сеть: и `cors`, и `no-cors` падают TypeError. */
  down?: boolean;
  type?: string;
}
interface Call { url: string; mode: RequestMode | undefined; at: number; end?: number }

const abortError = (): Error => Object.assign(new Error("aborted"), { name: "AbortError" });

/** Пауза поддельного времени, которую обрывает `signal`. */
function wait(clock: FakeClock, ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    sleep(clock, ms).then(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

function net(clock: FakeClock, routes: Record<string, Route>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, mode: init.mode, at: clock.perf() };
    calls.push(call);
    const r = routes[url];
    await wait(clock, r?.ttfb ?? 0, init.signal);
    if (r === undefined) return new Response("Not found", { status: 404 });
    if (r.down === true || (init.mode !== "no-cors" && r.cors === false)) throw new TypeError("Failed to fetch");
    if (init.mode === "no-cors") return new Response(null, { status: 200 });
    const bytes = typeof r.body === "string" ? new TextEncoder().encode(r.body) : new Uint8Array(r.body);
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (at >= bytes.length) {
          call.end = clock.perf();
          ctrl.close();
          return;
        }
        const part = bytes.subarray(at, at + CHUNK);
        try {
          if (r.kbps !== undefined) await wait(clock, (part.length * 8) / r.kbps, init.signal);
        } catch (e) {
          ctrl.error(e);
          return;
        }
        at += part.length;
        ctrl.enqueue(part);
      },
    }, { highWaterMark: 0 });
    return new Response(body, { status: r.status ?? 200, headers: { "content-type": r.type ?? (url.includes(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t") } });
  };
  return { fetch, calls };
}

async function measure(routes: Record<string, Route>, o: Partial<MeterOptions> = {}, url = MASTER, allow = (_: string): boolean => true) {
  const clock = new FakeClock();
  const { fetch, calls } = net(clock, routes);
  const meter = new Meter({ fetch, clock, allow }, { ...OPTS, ...o });
  const m: Measure = await clock.runUntilSettled(meter.measure(url));
  return { m, calls, clock };
}

const FULL: Record<string, Route> = {
  [MASTER]: { body: masterText(), ttfb: 30 },
  [INDEX]: { body: indexText(), ttfb: 40 },
  // 1 МБ за 1000 мс: 8 Мбит/с ≈ 8389 кбит/с.
  [seg(1)]: { body: MB, ttfb: 40, kbps: 8 * MB / 1000 },
  [seg(2)]: { body: MB, ttfb: 40, kbps: 8 * MB / 1000 },
  [seg(3)]: { body: MB, ttfb: 40, kbps: 8 * MB / 1000 },
};

describe("playlists: master variants, the variant to measure, segments", () => {
  it("parseMaster: URI after #EXT-X-STREAM-INF with its BANDWIDTH; relative and absolute URIs against the master", () => {
    const text = [
      "#EXTM3U",
      "#EXT-X-STREAM-INF:BANDWIDTH=5346327,RESOLUTION=1920x1080", `${NODE}/hls/T/x.mp4/index-v1a1.m3u8?loc=nl`,
      "#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2215538,RESOLUTION=1280x720", "", "index-v1a1.m3u8?loc=nl",
      "#EXT-X-MEDIA:TYPE=AUDIO,URI=\"a.m3u8\"",
    ].join("\r\n");
    assert.deepEqual(parseMaster(text, `${FRONT}/hls/T/y.mp4/master-v1a1.m3u8?loc=nl`), [
      { url: `${NODE}/hls/T/x.mp4/index-v1a1.m3u8?loc=nl`, bw: 5346327 },
      { url: `${FRONT}/hls/T/y.mp4/index-v1a1.m3u8?loc=nl`, bw: 2215538 },
    ]);
    assert.deepEqual(parseMaster(indexText(), MASTER), [], "a media playlist has no variants");
  });

  it("pickVariant: the richest variant ≤ 3 Mbit/s (720p, a 10-s segment fits the cap), else the lightest", () => {
    const v = (bw: number) => ({ url: `u${bw}`, bw });
    assert.equal(pickVariant([v(20_000_000), v(5_346_327), v(2_215_538), v(406_000)])?.bw, 2_215_538);
    assert.equal(pickVariant([v(20_000_000), v(5_346_327)])?.bw, 5_346_327);
    assert.equal(pickVariant([]), undefined);
  });

  it("parseMedia: URIs after #EXTINF in order; tags, comments and blank lines skipped", () => {
    const text = ["#EXTM3U", "#EXT-X-MAP:URI=\"init.mp4\"", "#EXTINF:10.0,", "", "seg-1-v1-a1.ts?loc=nl", "# comment", "#EXTINF:9.5,title", `${NODE}/s2.ts`].join("\n");
    assert.deepEqual(parseMedia(text, INDEX), [seg(1), `${NODE}/s2.ts`]);
  });

  it("hostOf drops the uuid label of a node: it may point to the account", () => {
    assert.equal(hostOf(seg(1)), "ams-static-01.cdntogo.net");
    assert.equal(hostOf(MASTER), "cdn2site.com");
    assert.equal(hostOf("not a url"), undefined);
  });
});

describe("Meter.measure: accuracy by CORS (spec §16.7)", () => {
  it("CORS everywhere: latency to the node, speed over segments up to the cap, the first segment whole", async () => {
    const { m, calls } = await measure(FULL);
    assert.equal(m.ok, true);
    assert.equal(m.acc, "full");
    assert.equal(m.latencyMs, 40, "time to the first byte of the node's media playlist");
    assert.equal(m.host, "ams-static-01.cdntogo.net");
    // 2 МБ сегментов за 2000 мс, плюс 3-й сегмент до лимита 3 МБ (вместе с плейлистами).
    assert.ok(m.mbps !== undefined && Math.abs(m.mbps - 8.389) < 0.05, `mbps ${m.mbps}`);
    assert.equal(m.segMs, 1040, "request → last byte of segment 1");
    assert.ok(m.bytes >= 3 * MB - CHUNK && m.bytes <= 3 * MB + CHUNK, `bytes ${m.bytes}`);
    assert.deepEqual(calls.map((c) => c.url), [MASTER, INDEX, seg(1), seg(2), seg(3)]);
    assert.ok(calls.every((c) => c.mode === "cors"));
  });

  it("the cap: 2 MB segments — the first whole, the second until 3 MB, the third is never asked", async () => {
    const big = { ...FULL, [seg(1)]: { ...FULL[seg(1)]!, body: 2 * MB }, [seg(2)]: { ...FULL[seg(2)]!, body: 2 * MB } };
    const { m, calls } = await measure(big);
    assert.equal(m.acc, "full");
    assert.ok(m.bytes <= 3 * MB + CHUNK, `bytes ${m.bytes}`);
    assert.ok(m.segMs !== undefined && m.segMs > 2000);
    assert.deepEqual(calls.map((c) => c.url), [MASTER, INDEX, seg(1), seg(2)]);
  });

  it("requests one at a time, starts ≥ gapMs apart (≤ 5 per second at 200 ms)", async () => {
    const fast = Object.fromEntries(Object.entries(FULL).map(([u, r]) => [u, { ...r, ttfb: 0, kbps: undefined }]));
    const { calls } = await measure(fast);
    for (let i = 1; i < calls.length; i++) {
      assert.ok(calls[i]!.at - calls[i - 1]!.at >= 200, `start ${i}: ${calls[i]!.at - calls[i - 1]!.at} ms after the previous`);
      assert.ok(calls[i]!.at >= (calls[i - 1]!.end ?? calls[i - 1]!.at), "the previous body was read before the next start");
    }
  });

  it("node without CORS: only the latency to the node — the time to the no-cors answer", async () => {
    const { m, calls } = await measure({ ...FULL, [INDEX]: { body: indexText(), ttfb: 25, cors: false } });
    assert.equal(m.ok, true);
    assert.equal(m.acc, "node");
    assert.equal(m.latencyMs, 25);
    assert.equal(m.mbps, undefined);
    assert.equal(m.host, "ams-static-01.cdntogo.net");
    assert.deepEqual(calls.map((c) => [c.url, c.mode]), [[MASTER, "cors"], [INDEX, "cors"], [INDEX, "no-cors"]]);
  });

  it("segments without CORS: the latency stays, no speed", async () => {
    const { m } = await measure({ ...FULL, [seg(1)]: { ...FULL[seg(1)]!, cors: false } });
    assert.equal(m.acc, "node");
    assert.equal(m.latencyMs, 40);
    assert.equal(m.mbps, undefined);
  });

  it("front host without CORS: only the latency to the playlist server — it is common to all locations", async () => {
    const { m, calls } = await measure({ [MASTER]: { body: masterText(), ttfb: 70, cors: false } });
    assert.equal(m.ok, true);
    assert.equal(m.acc, "front");
    assert.equal(m.latencyMs, 70);
    assert.equal(m.host, "cdn2site.com");
    assert.equal(m.bytes, 0, "an opaque body is not read");
    assert.deepEqual(calls.map((c) => c.mode), ["cors", "no-cors"]);
  });

  it("no network: both fetches fail → not ok, «net»", async () => {
    const { m } = await measure({ [MASTER]: { body: "", down: true } });
    assert.deepEqual([m.ok, m.err], [false, "net"]);
  });

  it("HTTP error and a non-playlist body are reported as such", async () => {
    assert.equal((await measure({ [MASTER]: { body: "Forbidden", status: 403 } })).m.err, "http-403");
    assert.equal((await measure({ [MASTER]: { body: "<html>", type: "text/html" } }, {}, MASTER)).m.err, "format");
    assert.equal((await measure({ ...FULL, [INDEX]: { body: "#EXTM3U\n#EXT-X-ENDLIST\n" } })).m.err, "format", "no segments");
  });

  it("deadline: a node that does not answer → «timeout»; a slow segment → speed over what was read", async () => {
    const dead = await measure({ ...FULL, [INDEX]: { body: indexText(), ttfb: 60_000 } }, { deadlineMs: 5000 });
    assert.deepEqual([dead.m.ok, dead.m.err], [false, "timeout"]);
    assert.ok(dead.clock.perf() - 1000 < 6000, "the deadline cuts the wait");
    // 1 МБ за 10 с — к сроку 5 с прочитана половина.
    const slow = await measure({ ...FULL, [seg(1)]: { ...FULL[seg(1)]!, kbps: 8 * MB / 10_000 } }, { deadlineMs: 5000 });
    assert.equal(slow.m.ok, true);
    assert.equal(slow.m.acc, "full");
    assert.equal(slow.m.segMs, undefined, "the first segment was not read whole");
    assert.ok(slow.m.mbps !== undefined && Math.abs(slow.m.mbps - 0.839) < 0.05, `mbps ${slow.m.mbps}`);
  });

  it("CSP: a host outside connect-src is not asked — «csp» with the host", async () => {
    const allow = (u: string): boolean => cspAllows(u, ["https://api.service-kp.com"]);
    const ok = await measure(FULL, {}, MASTER, allow);
    assert.equal(ok.m.acc, "full", "cdn2site.com and *.cdntogo.net are in CSP");
    const other = "https://cdn-new.example/hls/T/x.mp4/master-v1a1.m3u8?loc=nl";
    const blocked = await measure({ [other]: { body: masterText() } }, {}, other, allow);
    assert.deepEqual([blocked.m.ok, blocked.m.err, blocked.m.host, blocked.calls.length], [false, "csp", "cdn-new.example", 0]);
    const node = await measure({ [MASTER]: { body: masterText("https://node.example/i.m3u8") } }, {}, MASTER, allow);
    assert.deepEqual([node.m.err, node.m.host, node.calls.length], ["csp", "node.example", 1]);
  });

  it("a file without a playlist (progressive mp4, WebM of the mock): latency, speed and the whole file time", async () => {
    const url = `${NODE}/pd/TOKEN/file.mp4?loc=de`;
    const { m, calls } = await measure({ [url]: { body: MB, ttfb: 15, kbps: 8 * MB / 500, type: "video/mp4" } }, {}, url);
    assert.equal(m.acc, "full");
    assert.equal(m.latencyMs, 15);
    assert.equal(m.segMs, 515);
    assert.ok(m.mbps !== undefined && Math.abs(m.mbps - 16.777) < 0.1, `mbps ${m.mbps}`);
    assert.equal(calls.length, 1);
  });
});

describe("cspAllows: connect-src of the plugin (spec §15.4)", () => {
  const api = ["https://api.service-kp.com", "https://api.srvkp.com/"];
  it("API origins, *.cdntogo.net at any depth, the rotating master hosts; nothing else, no http", () => {
    for (const u of [
      "https://api.service-kp.com/manifest/x.m3u8", "https://api.srvkp.com/v1/x", seg(1), "https://msk-static-02.cdntogo.net/a.ts",
      "https://cdn2cdn.com/hls2/T/1.m3u8?loc=ru", "https://cdn2site.com/hls/T/x", "https://digital-cdn.net/hls4/T/1.m3u8",
    ]) assert.equal(cspAllows(u, api), true, u);
    for (const u of [
      "http://ams-static-01.cdntogo.net/a.ts", "https://cdntogo.net.evil.com/a", "https://evil-cdntogo.net/a", "https://x.cdn2cdn.com/a",
      "https://cdntogo.net:8443/a", "not a url",
    ]) assert.equal(cspAllows(u, api), false, u);
    assert.equal(cspAllows("http://127.0.0.1:8787/cdn/hls/x", ["http://127.0.0.1:8787"]), true, "mock: CDN on the API origin");
  });
});
