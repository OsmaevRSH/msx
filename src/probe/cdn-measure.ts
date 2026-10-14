import type { FetchLike } from "../api/transport.ts";
import type { Clock } from "../core/clock.ts";
import { sleep } from "../core/clock.ts";

// Замер одной локации CDN KinoPub (спец. §16.7). Мастер-плейлист с `?loc=<код>` лежит на общем для всех локаций
// фронт-хосте, а плейлист серий и сегменты — на узле этой локации: отличие локаций видно только за мастером, поэтому
// мастер нужно прочитать. Ступени точности — по тому, что разрешает CORS:
// - `full` — CORS у фронта и узла: задержка до узла (до первого байта плейлиста серий) и скорость по сегментам видео;
// - `node` — узел без CORS (или сегменты): только задержка до узла — время до ответа `no-cors`;
// - `front` — фронт без CORS: только задержка до фронт-хоста; он общий, сравнивать по ней локации нельзя.
// Тело `no-cors` не читается и не дожидается: ответ непрозрачный, его размер скрыт, а Resource Timing без
// `Timing-Allow-Origin` не даёт размеров. Запросы — по одному, старты не чаще `gapMs`.

export type Accuracy = "full" | "node" | "front";
export type MeasureError = "net" | "timeout" | "csp" | "format" | `http-${number}`;

export interface Measure {
  ok: boolean;
  acc?: Accuracy;
  /** До первого байта ответа (с установкой соединения), мс: узел — плейлист серий или сам файл; `front` — мастер. */
  latencyMs?: number;
  /** Скорость загрузки сегментов, Мбит/с: байты за время от первого байта до последнего. */
  mbps?: number;
  /** Первый сегмент целиком, от запроса до последнего байта, мс; нет — не уложился в лимит байт или срок. */
  segMs?: number;
  /** Загружено байт (плейлисты и сегменты; тело `no-cors` не в счёт). */
  bytes: number;
  /** Хост узла без первой метки-uuid (`ams-static-01.cdntogo.net`). */
  host?: string;
  err?: MeasureError;
}

export interface MeterOptions {
  /** Байт сегментов на локацию, дальше чтение обрывается. */
  capBytes: number;
  /** Срок локации, мс. */
  deadlineMs: number;
  /** Пауза между стартами запросов, мс. */
  gapMs: number;
  /** Плейлист читается не дальше, байт. */
  textCap: number;
  maxSegments: number;
}

export interface MeterDeps { fetch: FetchLike; clock: Clock; allow: (url: string) => boolean }

export interface Variant { url: string; bw: number }

interface Hit { res: Response; t0: number; tH: number }
interface Drained { n: number; done: boolean; tEnd: number; text: string }

/** Самый ёмкий вариант не выше этого: 10-секундный сегмент 720p (≈ 2,2 Мбит/с, ≈ 2,8 МБ) целиком в лимит. */
const VARIANT_MAX_BW = 3_000_000;
const UUID_LABEL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./i;

class CspBlocked extends Error {
  override name = "CspBlocked";
}

const noop = (): void => undefined;
const errName = (e: unknown): unknown => (typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined);
const isAbort = (e: unknown): boolean => errName(e) === "AbortError" || errName(e) === "TimeoutError";

function absolute(line: string, base: string): string | undefined {
  try {
    return new URL(line, base).href;
  } catch {
    return undefined;
  }
}

/** Хост для отчёта и журнала: первая метка-uuid узла (`<uuid>.ams-static-01…`) может указывать на аккаунт. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(UUID_LABEL, "");
  } catch {
    return undefined;
  }
}

/** Варианты мастер-плейлиста: URI после `#EXT-X-STREAM-INF` с его `BANDWIDTH`. */
export function parseMaster(text: string, base: string): Variant[] {
  const out: Variant[] = [];
  let bw: number | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXT-X-STREAM-INF:")) bw = Number(/BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0);
    else if (bw !== undefined && line !== "" && !line.startsWith("#")) {
      const url = absolute(line, base);
      if (url !== undefined) out.push({ url, bw });
      bw = undefined;
    }
  }
  return out;
}

/** Самый ёмкий вариант не выше `maxBw`, а если таких нет — самый лёгкий. */
export function pickVariant(vs: readonly Variant[], maxBw = VARIANT_MAX_BW): Variant | undefined {
  const fit = vs.filter((v) => v.bw <= maxBw);
  if (fit.length > 0) return fit.reduce((a, b) => (b.bw > a.bw ? b : a));
  return vs.length > 0 ? vs.reduce((a, b) => (b.bw < a.bw ? b : a)) : undefined;
}

/** Сегменты плейлиста серий по порядку: URI после `#EXTINF`. */
export function parseMedia(text: string, base: string): string[] {
  const out: string[] = [];
  let inf = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF")) inf = true;
    else if (inf && line !== "" && !line.startsWith("#")) {
      const url = absolute(line, base);
      if (url !== undefined) out.push(url);
      inf = false;
    }
  }
  return out;
}

function isPlaylist(url: string, res: Response): boolean {
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    // не URL — решает тип ответа
  }
  return /\.m3u8?$/i.test(path) || /mpegurl/i.test(res.headers.get("content-type") ?? "");
}

function decode(parts: Uint8Array[]): string {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Замеры локаций одного запуска теста: общий темп запросов на все локации. */
export class Meter {
  private d: MeterDeps;
  private o: MeterOptions;
  private last = Number.NEGATIVE_INFINITY;

  constructor(d: MeterDeps, o: MeterOptions) {
    this.d = d;
    this.o = o;
  }

  /** Замер по ссылке на поток с нужным `loc`; не бросает. По сроку `deadlineMs` всё, что ещё идёт, обрывается. */
  async measure(url: string): Promise<Measure> {
    const m: Measure = { ok: false, bytes: 0 };
    const ac = new AbortController();
    const timer = this.d.clock.setTimeout(() => ac.abort(), this.o.deadlineMs);
    try {
      await this.steps(url, ac.signal, m);
    } catch (e) {
      if (!m.ok) {
        m.err = e instanceof CspBlocked ? "csp" : isAbort(e) || ac.signal.aborted ? "timeout" : "net";
        if (e instanceof CspBlocked) m.host = e.message;
      }
    } finally {
      this.d.clock.clearTimeout(timer);
      // Непрочитанные тела (`no-cors`, лишний хвост сегмента) не докачиваются.
      ac.abort();
    }
    if (m.latencyMs !== undefined) m.latencyMs = Math.round(m.latencyMs);
    return m;
  }

  private async steps(url: string, signal: AbortSignal, m: Measure): Promise<void> {
    const first = await this.cors(url, signal);
    if (first === undefined) return this.opaque(url, signal, m, "front");
    if (!first.res.ok) return this.httpFail(first, m);
    if (!isPlaylist(url, first.res)) {
      // Файл без плейлиста (прогрессивный mp4, WebM mock): его и качаем.
      this.reached(m, url, first);
      return this.download([first], signal, m);
    }
    let media = first;
    let mediaUrl = url;
    let text = await this.text(first.res, signal, m);
    if (!text.trimStart().startsWith("#EXTM3U")) {
      m.err = "format";
      return;
    }
    const variant = pickVariant(parseMaster(text, url));
    if (variant !== undefined) {
      const v = await this.cors(variant.url, signal);
      if (v === undefined) return this.opaque(variant.url, signal, m, "node");
      if (!v.res.ok) return this.httpFail(v, m);
      media = v;
      mediaUrl = variant.url;
      text = await this.text(v.res, signal, m);
    }
    const segs = parseMedia(text, mediaUrl).slice(0, this.o.maxSegments);
    if (segs.length === 0) {
      m.err = "format";
      return;
    }
    this.reached(m, mediaUrl, media);
    await this.download(segs, signal, m);
  }

  /** Узел ответил и прочитан: задержка есть, скорость — если сегменты прочитаются. */
  private reached(m: Measure, url: string, h: Hit): void {
    m.ok = true;
    m.acc = "node";
    m.latencyMs = h.tH - h.t0;
    const host = hostOf(url);
    if (host !== undefined) m.host = host;
  }

  /**
   * Сегменты по порядку, пока вместе с плейлистами не наберётся `capBytes`: обрыв по сроку, сети или CORS оставляет то,
   * что успели прочитать.
   */
  private async download(queue: (string | Hit)[], signal: AbortSignal, m: Measure): Promise<void> {
    const budget = this.o.capBytes - m.bytes;
    let got = 0;
    let busy = 0;
    for (let i = 0; i < queue.length && got < budget; i++) {
      const q = queue[i] as string | Hit;
      let h: Hit | undefined;
      try {
        h = typeof q === "string" ? await this.cors(q, signal) : q;
      } catch {
        break;
      }
      if (h === undefined) break;
      if (!h.res.ok) {
        h.res.body?.cancel().catch(noop);
        break;
      }
      const r = await this.drain(h.res, budget - got, false, m);
      got += r.n;
      busy += r.tEnd - h.tH;
      if (i === 0 && r.done) m.segMs = Math.round(r.tEnd - h.t0);
      if (!r.done) break;
    }
    if (got > 0) {
      m.acc = "full";
      m.mbps = (got * 8) / Math.max(busy, 1) / 1000;
    }
  }

  /** Плейлист целиком (до `textCap`); оборванный сроком не разбирается — это `timeout`, а не `format`. */
  private async text(res: Response, signal: AbortSignal, m: Measure): Promise<string> {
    const { text } = await this.drain(res, this.o.textCap, true, m);
    if (signal.aborted) throw Object.assign(new Error("deadline"), { name: "AbortError" });
    return text;
  }

  private httpFail(h: Hit, m: Measure): void {
    m.err = `http-${h.res.status}`;
    h.res.body?.cancel().catch(noop);
  }

  /** `undefined` — запрос упал без ответа (нет CORS, CSP или сети: что именно — решит `no-cors`). */
  private async cors(url: string, signal: AbortSignal): Promise<Hit | undefined> {
    if (!this.d.allow(url)) throw new CspBlocked(hostOf(url) ?? "");
    await this.pace();
    const t0 = this.d.clock.perf();
    try {
      const res = await this.d.fetch(url, { mode: "cors", credentials: "omit", signal });
      return { res, t0, tH: this.d.clock.perf() };
    } catch (e) {
      if (signal.aborted || isAbort(e)) throw e;
      return undefined;
    }
  }

  /** Ответ без CORS: только время до него — тело непрозрачно; сбой — сеть, его бросает `fetch`. */
  private async opaque(url: string, signal: AbortSignal, m: Measure, acc: Accuracy): Promise<void> {
    await this.pace();
    const t0 = this.d.clock.perf();
    await this.d.fetch(url, { mode: "no-cors", credentials: "omit", signal });
    m.ok = true;
    m.acc = acc;
    m.latencyMs = this.d.clock.perf() - t0;
    const host = hostOf(url);
    if (host !== undefined) m.host = host;
  }

  /** Тело до `cap` байт (`keep` — с текстом); срок или обрыв посреди тела — прочитанное идёт в замер. */
  private async drain(res: Response, cap: number, keep: boolean, m: Measure): Promise<Drained> {
    const parts: Uint8Array[] = [];
    let n = 0;
    let done = false;
    const reader = res.body?.getReader();
    try {
      if (reader === undefined) {
        const all = new Uint8Array(await res.arrayBuffer());
        n = Math.min(all.byteLength, cap);
        done = all.byteLength <= cap;
        if (keep) parts.push(all.subarray(0, n));
      } else {
        while (n < cap) {
          const r = await reader.read();
          if (r.done) {
            done = true;
            break;
          }
          n += r.value.byteLength;
          if (keep) parts.push(r.value);
        }
      }
    } catch {
      // срок или обрыв: что прочитано — в замер
    }
    if (!done) reader?.cancel().catch(noop);
    m.bytes += n;
    return { n, done, tEnd: this.d.clock.perf(), text: keep ? decode(parts) : "" };
  }

  /** Не больше одного старта за `gapMs`: при 200 мс — не больше 5 запросов в секунду. */
  private async pace(): Promise<void> {
    const wait = this.last + this.o.gapMs - this.d.clock.perf();
    if (wait > 0) await sleep(this.d.clock, wait);
    this.last = this.d.clock.perf();
  }
}
