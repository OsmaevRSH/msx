import { readFileSync } from "node:fs";
import { findUnit } from "../fixtures.ts";
import type { FxFile, FxUnit } from "../fixtures.ts";
import type { HandlerCtx, MockResponse, Router } from "../router.ts";
import type { Scenario } from "../scenario.ts";
import type { MockState } from "../state.ts";

// CDN mock (спец. §14.2, Plan B §12.3): плейлисты hls v1/hls2, SRT, WebM для e2e, SVG-постеры.
// Без CORS: браузер грузит их как медиа и картинки, а не через fetch плагина.

export interface StreamUrls { http: string; hls: string; hls2: string; hls4: string }

const LOC = "nl";
const LINK_TTL_SEC = 86_400;
const M3U8 = "application/vnd.apple.mpegurl";
const AVC = 'CODECS="avc1.640028,mp4a.40.2"';

/** Размеры как у боевых постеров (research kinopub-api §6.2); `thumb` — кадр серии 480×270. */
export const POSTER_SIZES: Record<string, readonly [number, number]> = {
  small: [165, 250], medium: [250, 375], big: [500, 750], wide: [1280, 720], thumb: [480, 270], logo: [240, 180],
};

export const issuedNow = (): number => Math.floor(Date.now() / 1000);

/** Токен в пути ссылки, формат KinoPub (research kinopub-api §7.3): предпоследнее число — mid, `e` — выдача + 24 ч. */
export function linkToken(mid: number, issued: number): string {
  return Buffer.from(`id=1;0;0;${mid};${issued}&h=mock&e=${issued + LINK_TTL_SEC}`, "utf8").toString("base64url");
}

/** mid из токена ссылки или undefined, если токен не в формате mock. */
export function tokenMid(token: string): number | undefined {
  const m = /^id=\d+;\d+;\d+;(\d+);\d+&h=[^&]+&e=\d+$/.exec(Buffer.from(token, "base64url").toString("utf8"));
  return m ? Number(m[1]) : undefined;
}

export function streamUrls(base: string, media: Scenario["media"], mid: number, file: string, issued: number): StreamUrls {
  if (media === "webm") {
    const u = `${base}/cdn/media/sample.webm?mid=${mid}&loc=${LOC}`;
    return { http: u, hls: u, hls2: u, hls4: u };
  }
  const t = linkToken(mid, issued);
  return {
    http: `${base}/cdn/pd/${t}${file}?loc=${LOC}`,
    hls: `${base}/cdn/hls/${t}${file}/master-v1a1.m3u8?loc=${LOC}`,
    hls2: `${base}/cdn/hls2/${t}/${mid}.m3u8?loc=${LOC}`,
    hls4: `${base}/cdn/hls4/${t}/${mid}.m3u8?loc=${LOC}`,
  };
}

export function subtitleUrl(base: string, mid: number, file: string, issued: number): string {
  return `${base}/cdn/sub/${linkToken(mid, issued)}${file}`;
}

export function posterUrl(base: string, size: string, id: number): string {
  return `${base}/poster/${size}/${id}.svg`;
}

const text = (body: string, type: string): MockResponse => ({ status: 200, text: body, headers: { "content-type": type } });
const forbidden = (): MockResponse => ({ status: 403, text: "Forbidden" });
const notFound = (): MockResponse => ({ status: 404, text: "Not found" });

const bandwidth = (f: FxFile): number => Math.round(f.w * f.h * 1.07);

/** Файл единицы по токену и пути из URL; иначе готовый ответ 403 (чужой токен) или 404. */
function fileOf(token: string, path: string): { unit: FxUnit; file: FxFile } | MockResponse {
  const mid = tokenMid(token);
  if (mid === undefined) return forbidden();
  const unit = findUnit(mid)?.unit;
  const file = unit?.files.find((f) => f.file === path);
  return unit && file ? { unit, file } : notFound();
}

function masterV1(ctx: HandlerCtx): MockResponse {
  const hit = fileOf(ctx.params.token, ctx.params.file);
  if ("status" in hit) return hit;
  const { file } = hit;
  return text([
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=${bandwidth(file)},RESOLUTION=${file.w}x${file.h},${AVC}`,
    `index-v1a${ctx.params.a}.m3u8${ctx.url.search}`,
    "",
  ].join("\n"), M3U8);
}

function indexV1(ctx: HandlerCtx): MockResponse {
  const hit = fileOf(ctx.params.token, ctx.params.file);
  if ("status" in hit) return hit;
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:10", "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"];
  // TS-сегменты не отдаются (спец. §14.2): плейлист нужен для проверки URL, не для воспроизведения.
  for (let i = 1; i <= 3; i++) lines.push("#EXTINF:10.000,", `seg-${i}-v1-a${ctx.params.a}.ts${ctx.url.search}`);
  lines.push("#EXT-X-ENDLIST", "");
  return text(lines.join("\n"), M3U8);
}

/** ABR master hls2 (research kinopub-api §7.2): по варианту на качество h264, только первая озвучка (`a1`). */
function masterHls2(ctx: HandlerCtx): MockResponse {
  const mid = Number(ctx.params.mid);
  if (tokenMid(ctx.params.token) !== mid) return forbidden();
  const unit = findUnit(mid)?.unit;
  if (!unit) return notFound();
  const byQuality = new Map<number, FxFile>();
  for (const f of unit.files) if (f.codec === "h264" && !byQuality.has(f.quality_id)) byQuality.set(f.quality_id, f);
  const variants = [...byQuality.values()].sort((a, b) => b.h - a.h).slice(0, 3);
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const f of variants) {
    lines.push(`#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=${bandwidth(f)},RESOLUTION=${f.w}x${f.h},${AVC},FRAME-RATE=23.976`,
      `${ctx.base}/cdn/hls/${ctx.params.token}${f.file}/index-v1a1.m3u8${ctx.url.search}`);
  }
  lines.push("");
  return text(lines.join("\n"), M3U8);
}

/** Эфир канала (`/v1/tv`): живой плейлист без `#EXT-X-ENDLIST`, окно из 3 сегментов по 6 с идёт по часам. */
function livePlaylist(ctx: HandlerCtx): MockResponse {
  const seq = Math.floor(Date.now() / 6000);
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:6", `#EXT-X-MEDIA-SEQUENCE:${seq}`];
  for (let i = 0; i < 3; i++) lines.push("#EXTINF:6.000,", `${ctx.params.name}-${seq + i}.ts`);
  return text([...lines, ""].join("\n"), M3U8);
}

function srt(ctx: HandlerCtx): MockResponse {
  const mid = tokenMid(ctx.params.token);
  if (mid === undefined) return forbidden();
  const sub = findUnit(mid)?.unit.subsFull.find((s) => s.file === ctx.params.file);
  if (!sub) return notFound();
  const tag = `${sub.lang}${sub.forced ? ", forced" : ""}`;
  const cues = [1, 2, 3].map((n) => `${n}\n00:00:0${n * 2 - 1},000 --> 00:00:0${n * 2},500\nСубтитр ${n} (${tag}) / Subtitle ${n}\n`);
  return text(cues.join("\n"), "application/x-subrip; charset=utf-8");
}

let sample: Buffer | undefined;

function sampleWebm(): Buffer | undefined {
  if (!sample) {
    try {
      sample = readFileSync(new URL("../media/sample.webm", import.meta.url));
    } catch {
      return undefined;
    }
  }
  return sample;
}

/** Один диапазон `bytes=a-b`, `bytes=a-`, `bytes=-n`; иное — весь файл (RFC 9110 разрешает игнорировать Range). */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | undefined {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return undefined;
  if (m[1] === "") {
    const n = Number(m[2]);
    return n === 0 || size === 0 ? "unsatisfiable" : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start >= size || start > end ? "unsatisfiable" : { start, end };
}

function media(ctx: HandlerCtx): MockResponse {
  const file = sampleWebm();
  if (!file) return { status: 404, text: "sample.webm is missing: run npm run gen:media" };
  const headers = { "content-type": "video/webm", "accept-ranges": "bytes" };
  const range = byteRange(ctx.req.headers.range, file.length);
  if (range === "unsatisfiable") return { status: 416, headers: { ...headers, "content-range": `bytes */${file.length}` } };
  if (!range) return { status: 200, body: file, headers: { ...headers, "content-length": String(file.length) } };
  const body = file.subarray(range.start, range.end + 1);
  return {
    status: 206, body,
    headers: { ...headers, "content-length": String(body.length), "content-range": `bytes ${range.start}-${range.end}/${file.length}` },
  };
}

function poster(ctx: HandlerCtx): MockResponse {
  if (!Object.hasOwn(POSTER_SIZES, ctx.params.size)) return notFound();
  const [w, h] = POSTER_SIZES[ctx.params.size];
  const id = Number(ctx.params.id);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="${w}" height="${h}" fill="hsl(${(id * 47) % 360},45%,35%)"/>` +
    `<text x="${w / 2}" y="${h / 2}" fill="#fff" font-family="sans-serif" font-size="${Math.round(Math.min(w, h) / 6)}" ` +
    `text-anchor="middle" dominant-baseline="middle">${id}</text></svg>`;
  return text(svg, "image/svg+xml");
}

export function register(r: Router, s: MockState, base: () => string): void {
  r.add("GET", /^\/cdn\/hls\/(?<token>[^/]+)(?<file>\/.+)\/master-v1a(?<a>\d+)\.m3u8$/, masterV1);
  r.add("GET", /^\/cdn\/hls\/(?<token>[^/]+)(?<file>\/.+)\/index-v1a(?<a>\d+)\.m3u8$/, indexV1);
  r.add("GET", /^\/cdn\/hls2\/(?<token>[^/]+)\/(?<mid>\d+)\.m3u8$/, masterHls2);
  r.add("GET", /^\/cdn\/sub\/(?<token>[^/]+)(?<file>\/.+\.srt)$/, srt);
  r.add("GET", "/cdn/media/sample.webm", media);
  r.add("GET", /^\/cdn\/tv\/(?<name>[a-z0-9]+)\/playlist\.m3u8$/, livePlaylist);
  r.add("GET", /^\/poster\/(?<size>[a-z]+)\/(?<id>\d+)\.svg$/, poster);
}
