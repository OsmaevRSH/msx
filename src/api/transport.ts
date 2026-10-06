import { sleep } from "../core/clock.ts";
import type { Clock, TimerId } from "../core/clock.ts";
import { KpError, toKpError } from "../core/errors.ts";
import type { Logger } from "../core/log.ts";
import type { Metrics } from "../core/metrics.ts";
import type { FlagStore } from "../config/flags.ts";
import type { Breaker } from "./breaker.ts";
import type { Limiter } from "./limiter.ts";

export type ReqClass = "fg" | "bg";
export type RetryPolicy = "auto" | "none";          // спец. §5.3 (CM-01)

/**
 * Класс запроса, который можно поднять с фона на передний план. Single-flight кэша отдаёт один запрос всем, кто ждёт
 * ключ: если к фоновому префетчу присоединился экран, ждущий в очереди запрос идёт как передний план и не сбрасывается.
 */
export class Priority {
  private value: ReqClass;
  private listeners = new Set<() => void>();

  constructor(cls: ReqClass) {
    this.value = cls;
  }

  cls(): ReqClass {
    return this.value;
  }

  /** bg → fg; повторный вызов ничего не делает. */
  promote(): void {
    if (this.value === "fg") return;
    this.value = "fg";
    for (const fn of [...this.listeners]) fn();
  }

  /** Для лимитера: `fn` при повышении; возвращает отписку. */
  onPromote(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}

export interface ApiRequest {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | undefined>;
  form?: Record<string, string | number>;
  retry: RetryPolicy;
  timeoutMs: number;
  cls: ReqClass;
  /** Если задан — главнее `cls`: каждая попытка встаёт в очередь с текущим классом и повышается, пока ждёт. */
  prio?: Priority;
}

export interface ApiResponse { status: number; json: unknown; ms: number }

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface TransportDeps {
  fetch: FetchLike; clock: Clock; log: Logger; metrics: Metrics; flags: FlagStore; limiter: Limiter; breaker: Breaker;
}

const RETRY_PAUSES_MS = [3000, 6000];
const NO_CORS_PAUSE_MS = 6000;
const TYPE_ERRORS_BEFORE_PROBE = 3;
// CM-01: проба — всегда этот запрос без настоящего токена; не меняет состояние аккаунта и не трогает refresh.
const PROBE_PATH = "/v1/types?access_token=x";
const PROBE_TIMEOUT_MS = 8000;
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i;

/**
 * Этап 33b: столько ждёт ответа запрос на связи без признаков жизни, прежде чем экран получит «Нет связи» (`KP-NET`).
 * Висящее TLS-рукопожатие (блокировка по SNI, упавший VPN) fetch не отличает от медленного ответа, поэтому таймауты
 * §5.2 (8 и 15 с) с повторами давали «Нет связи» только через 33–54 с.
 */
export const NO_ANSWER_MS = 6000;

/** `quiet` — KinoPub не ответил ничем (таймаут): признак висящей связи, в отличие от `TypeError`. */
type Outcome =
  | { ok: true; res: ApiResponse }
  | { ok: false; err: KpError; retry: boolean; pauseMs?: number; quiet?: boolean };

/** Попытка `send`, которую можно закончить вердиктом «нет ответа», не дожидаясь её fetch. */
interface Wait {
  req: ApiRequest;
  /** Когда встала в очередь лимитера: ожидание в очереди тоже считается. */
  at: number;
  timer: TimerId | undefined;
  /** Вердикт вынесен: из очереди попытка не уходит в сеть, а ответ уже идущей никто не ждёт. */
  abandoned: boolean;
  end(o: Outcome): void;
}

/** Попытка, брошенная до отправки: лимитер даёт ей слот, она сразу его возвращает. */
const SKIPPED: Outcome = { ok: false, err: new KpError("KP-NET", "no-answer"), retry: false };

const pathOnly = (path: string): string => path.split("?")[0] as string;
const metricPath = (path: string): string => pathOnly(path).replace(/\/\d+(?=\/|$)/g, "/:id");

/**
 * Транспорт к API KinoPub (спец. §5.2, §5.3, §8.5). Только простые запросы: токен в query, никаких своих
 * заголовков, `credentials: "omit"`, POST-тело — `URLSearchParams`, поэтому браузер не делает preflight.
 */
export class Transport {
  private fetch: FetchLike;
  private clock: Clock;
  private log: Logger;
  private metrics: Metrics;
  private flags: FlagStore;
  private limiter: Limiter;
  private breaker: Breaker;
  private typeErrors = 0;
  private probing: Promise<boolean> | undefined;
  /** Сколько ответов KinoPub получено (любой HTTP-статус, проба `no-cors`) и когда последний (`perf`). */
  private heardN = 0;
  private heardAt = Number.NEGATIVE_INFINITY;
  /** `heardN` на момент последнего таймаута: связь жива, только если ответ был и после него. */
  private quietMark = 0;
  /** Ждущие попытки `retry: "auto"` — кандидаты на вердикт «нет ответа». */
  private waits = new Set<Wait>();

  constructor(deps: TransportDeps) {
    this.fetch = deps.fetch;
    this.clock = deps.clock;
    this.log = deps.log;
    this.metrics = deps.metrics;
    this.flags = deps.flags;
    this.limiter = deps.limiter;
    this.breaker = deps.breaker;
  }

  /**
   * 2xx и 4xx — ответ (кроме 401, 404, 429); остальное — KpError. Повторы 3 с и 6 с — только при `retry: "auto"`;
   * таймаут повторяется, только если KinoPub за это время отвечал на другие запросы. На связи без признаков жизни
   * запрос `retry: "auto"` без ответа за `NO_ANSWER_MS` — `KP-NET` (этап 33b).
   */
  async send(req: ApiRequest): Promise<ApiResponse> {
    const attempts = req.retry === "auto" ? RETRY_PAUSES_MS.length + 1 : 1;
    for (let i = 0; ; i++) {
      const out = await this.queue(req);
      if (out.ok) return out.res;
      if (!out.retry || i + 1 >= attempts) throw out.err;
      await sleep(this.clock, out.pauseMs ?? (RETRY_PAUSES_MS[i] as number));
    }
  }

  /** Сервер доступен, но мог ответить без CORS (спец. §5.3 п. 2): любой ответ на `no-cors` — да, исключение — нет. */
  probeNoCors(): Promise<boolean> {
    if (this.probing === undefined) {
      this.probing = this.runProbe().finally(() => {
        this.probing = undefined;
      });
    }
    return this.probing;
  }

  buildUrl(req: ApiRequest): string {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) q.append(k, String(v));
    if (req.form !== undefined && !this.formInBody(req)) for (const [k, v] of Object.entries(req.form)) q.append(k, String(v));
    const url = this.base() + req.path;
    const qs = q.toString();
    if (qs === "") return url;
    return url + (req.path.includes("?") ? "&" : "?") + qs;
  }

  private base(): string {
    return this.flags.get().apiBase.replace(/\/+$/, "");
  }

  private formInBody(req: ApiRequest): boolean {
    return req.method === "POST" && this.flags.get().postBody === "form";
  }

  /** Связь жива: KinoPub ответил хоть что-то после последнего таймаута (на старте — ещё не ответил). */
  private live(): boolean {
    return this.heardN > this.quietMark;
  }

  private heard(): void {
    this.heardN += 1;
    this.heardAt = this.clock.perf();
  }

  /**
   * Одна попытка через лимитер. Запрос `retry: "auto"` на связи без признаков жизни, который за `NO_ANSWER_MS` (вместе
   * с очередью) ничего не услышал, заканчивается `KP-NET` «no-answer» без повторов, но его fetch не обрывается раньше
   * своего таймаута: медленная, но живая сеть ответит, ответ докажет связь (и прогреет соединение браузера) для
   * следующего запроса. Бросить так можно только идемпотентный запрос (спец. §5.3, CM-01): ответ refresh, опроса входа
   * или `toggle` терять нельзя — они ждут свой таймаут.
   */
  private queue(req: ApiRequest): Promise<Outcome> {
    return new Promise<Outcome>((resolve, reject) => {
      let done = false;
      const settle = (): boolean => {
        if (done) return false;
        done = true;
        this.waits.delete(w);
        if (w.timer !== undefined) this.clock.clearTimeout(w.timer);
        w.timer = undefined;
        return true;
      };
      const w: Wait = {
        req, at: this.clock.perf(), timer: undefined, abandoned: false,
        end: (o) => {
          if (settle()) resolve(o);
        },
      };
      if (req.retry === "auto") {
        this.waits.add(w);
        if (!this.live()) this.arm(w);
      }
      const run = async (): Promise<Outcome> => {
        if (w.abandoned) return SKIPPED;
        const o = await this.attempt(req);
        w.end(o);
        // После `end` (своя попытка закончилась таймаутом, а не вердиктом) и до того, как лимитер отдаст слот
        // следующей в очереди: ждущие получают вердикт раньше, чем уйдут в сеть.
        if (!o.ok && o.quiet === true) this.quiet();
        return o;
      };
      this.limiter.run(req.prio ?? req.cls, run).catch((e: unknown) => {
        if (settle()) reject(e);
      });
    });
  }

  /** Срок вердикта — `NO_ANSWER_MS` тишины: с постановки в очередь или с последнего ответа KinoPub, что позже. */
  private arm(w: Wait): void {
    const left = Math.max(w.at, this.heardAt) + NO_ANSWER_MS - this.clock.perf();
    if (left <= 0) {
      this.noAnswer(w);
      return;
    }
    w.timer = this.clock.setTimeout(() => {
      w.timer = undefined;
      if (w.abandoned || !this.waits.has(w) || this.live()) return;
      this.arm(w);
    }, left);
  }

  /** Таймаут: связь замолчала. Ждущие попытки, которые 6 с ничего не слышали, получают вердикт сразу. */
  private quiet(): void {
    this.quietMark = this.heardN;
    for (const w of [...this.waits]) {
      if (w.timer === undefined && !w.abandoned && this.waits.has(w)) this.arm(w);
    }
  }

  private noAnswer(w: Wait): void {
    w.abandoned = true;
    this.metrics.inc("api:no_answer");
    this.logCall("warn", w.req, "no-answer", this.clock.perf() - w.at);
    w.end({ ok: false, err: new KpError("KP-NET", "no-answer"), retry: false });
  }

  private async attempt(req: ApiRequest): Promise<Outcome> {
    if (!this.breaker.allow()) {
      this.logCall("warn", req, "breaker-open", 0);
      return { ok: false, err: new KpError("KP-NET", "breaker-open"), retry: false };
    }
    const url = this.buildUrl(req);
    const body = req.form !== undefined && this.formInBody(req) ? toForm(req.form) : undefined;
    const ac = new AbortController();
    let timedOut = false;
    const timer = this.clock.setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, req.timeoutMs);
    const t0 = this.clock.perf();
    const heard = this.heardN;
    let status = 0;
    let contentType = "";
    let text = "";
    try {
      // Без своих заголовков: иначе запрос перестанет быть простым (спец. §5.2, CD-02).
      const res = await this.fetch(url, { method: req.method, body, mode: "cors", credentials: "omit", signal: ac.signal });
      status = res.status;
      contentType = res.headers.get("content-type") ?? "";
      text = await res.text();
    } catch (e) {
      const ms = this.clock.perf() - t0;
      return timedOut ? this.onTimeout(req, ms, heard) : this.onFetchError(req, e, ms);
    } finally {
      this.clock.clearTimeout(timer);
    }
    return this.onResponse(req, status, contentType, text, this.clock.perf() - t0);
  }

  /**
   * Повтор таймаута (спец. §5.3) — только если KinoPub за это время отвечал на другие запросы (потерян один ответ).
   * Не ответил ничего — связь висит: повторы через 3 и 6 с лишь отложили бы «Нет связи» ещё на 25 с (этап 33b).
   */
  private onTimeout(req: ApiRequest, ms: number, heardBefore: number): Outcome {
    this.breaker.failure();
    this.metrics.inc("api:timeout");
    this.logCall("warn", req, "timeout", ms);
    return { ok: false, err: new KpError("KP-NET", "timeout"), retry: this.heardN > heardBefore, quiet: true };
  }

  // Спец. §5.3: TypeError — отказ CORS, DNS, TCP/TLS или VPN, причины неразличимы; в работе это временная сеть.
  private async onFetchError(req: ApiRequest, e: unknown, ms: number): Promise<Outcome> {
    if (!(e instanceof TypeError)) {
      this.logCall("warn", req, "error", ms);
      return { ok: false, err: toKpError(e), retry: false };
    }
    this.metrics.inc("api:net");
    this.logCall("warn", req, "net", ms);
    this.typeErrors += 1;
    if (this.typeErrors >= TYPE_ERRORS_BEFORE_PROBE) {
      this.typeErrors = 0;
      if (await this.probeNoCors()) {
        // Сервер доступен, но ответ без CORS (типично 429/5xx от nginx): обрабатываем как 429 (спец. §12) — и для
        // circuit breaker тоже: сервер ответил, это не сетевой сбой, иначе следующий экран получил бы `KP-NET`.
        this.breaker.success();
        this.limiter.on429();
        this.metrics.inc("api:429");
        this.log.warn("api", "api_no_cors", { path: pathOnly(req.path) });
        return { ok: false, err: new KpError("KP-429", "no-cors", undefined, "api_no_cors"), retry: true, pauseMs: NO_CORS_PAUSE_MS };
      }
    }
    this.breaker.failure();
    return { ok: false, err: new KpError("KP-NET", "network", undefined, e.message), retry: true };
  }

  private onResponse(req: ApiRequest, status: number, contentType: string, text: string, ms: number): Outcome {
    this.heard();
    this.typeErrors = 0;
    this.metrics.record(`api:${metricPath(req.path)}`, ms);
    this.logCall(status >= 500 || status === 429 ? "warn" : "info", req, String(status), ms);
    if (status >= 500) {
      this.breaker.failure();
      return { ok: false, err: new KpError("KP-5XX", "server-error", status), retry: true };
    }
    this.breaker.success();
    if (status === 429) {
      this.limiter.on429();
      this.metrics.inc("api:429");
      return { ok: false, err: new KpError("KP-429", "rate-limited", status), retry: true };
    }
    if (status === 401) return { ok: false, err: new KpError("KP-AUTH", "unauthorized", status), retry: false };
    if (status === 404) return { ok: false, err: new KpError("KP-404", "not-found", status), retry: false };
    if (!JSON_TYPE.test(contentType)) {
      return { ok: false, err: new KpError("KP-BAD", "not-json", status, contentType.split(";")[0]), retry: false };
    }
    try {
      return { ok: true, res: { status, json: JSON.parse(text) as unknown, ms } };
    } catch {
      return { ok: false, err: new KpError("KP-BAD", "bad-json", status), retry: false };
    }
  }

  private async runProbe(): Promise<boolean> {
    const ac = new AbortController();
    const timer = this.clock.setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
    const t0 = this.clock.perf();
    try {
      await this.fetch(this.base() + PROBE_PATH, { method: "GET", mode: "no-cors", credentials: "omit", signal: ac.signal });
      this.heard();
      this.log.info("api", `probe no-cors reachable ${Math.round(this.clock.perf() - t0)}ms`);
      return true;
    } catch {
      this.log.warn("api", `probe no-cors failed ${Math.round(this.clock.perf() - t0)}ms`);
      return false;
    } finally {
      this.clock.clearTimeout(timer);
    }
  }

  /** Журнал спец. §13: путь без query (токен не попадает), статус, время, класс. */
  private logCall(level: "info" | "warn", req: ApiRequest, status: string, ms: number): void {
    this.log[level]("api", `${req.method} ${pathOnly(req.path)} ${status} ${Math.round(ms)}ms ${req.prio?.cls() ?? req.cls}`);
  }
}

function toForm(form: Record<string, string | number>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) body.append(k, String(v));
  return body;
}
