import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import { Breaker } from "../../src/api/breaker.ts";
import { Limiter } from "../../src/api/limiter.ts";
import { Priority, Transport } from "../../src/api/transport.ts";
import type { ApiRequest, FetchLike } from "../../src/api/transport.ts";
import { KvStore } from "../../src/bridge/storage.ts";
import { DEFAULT_FLAGS, FlagStore } from "../../src/config/flags.ts";
import { KpError } from "../../src/core/errors.ts";
import { Logger } from "../../src/core/log.ts";
import { Metrics } from "../../src/core/metrics.ts";
import { startMock } from "../../tools/kpmock/server.ts";
import type { MockServer } from "../../tools/kpmock/server.ts";
import { createCorsFetch } from "../helpers/cors-fetch.ts";
import type { CorsFetch } from "../helpers/cors-fetch.ts";
import { FakeClock } from "../helpers/fake-clock.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";

const ORIGIN = "https://example.github.io";
const PROBE = "GET /v1/types?access_token=x";

interface Rig {
  t: Transport; clock: FakeClock; log: Logger; metrics: Metrics; flags: FlagStore; limiter: Limiter; breaker: Breaker;
  cors: CorsFetch; inits: { url: string; init: RequestInit }[];
}

const get = (path: string, over: Partial<ApiRequest> = {}): ApiRequest =>
  ({ method: "GET", path, retry: "auto", timeoutMs: 8000, cls: "fg", ...over });

/** KpError с нужным кодом; для assert.rejects. */
const kp = (code: string, message?: string) => (e: unknown): boolean => {
  assert.ok(e instanceof KpError, `expected KpError, got ${String(e)}`);
  assert.equal(e.code, code);
  if (message !== undefined) assert.equal(e.message, message);
  return true;
};

describe("Transport", () => {
  let mock: MockServer;
  let token = "";

  /** `script` — подмена сети для отдельных URL; `next` — настоящий путь через эмулятор CORS к mock. */
  const rig = (script?: (url: string, init: RequestInit, next: FetchLike) => Promise<Response>): Rig => {
    const clock = new FakeClock();
    const log = new Logger(clock);
    const metrics = new Metrics();
    const flags = new FlagStore(new KvStore(new MemoryStorage()), { ...DEFAULT_FLAGS, apiBase: mock.url, apiFallbackBase: mock.url });
    const limiter = new Limiter(clock);
    const breaker = new Breaker(clock);
    const cors = createCorsFetch({ origin: ORIGIN });
    const inits: { url: string; init: RequestInit }[] = [];
    const fetch: FetchLike = (url, init) => {
      inits.push({ url, init });
      return script === undefined ? cors(url, init) : script(url, init, cors);
    };
    return { t: new Transport({ fetch, clock, log, metrics, flags, limiter, breaker }), clock, log, metrics, flags, limiter, breaker, cors, inits };
  };

  const calls = (): string[] => mock.calls().map((c) => `${c.method} ${c.path}${c.query ? `?${c.query}` : ""}`);

  /** CC-01, CNFR-19: ни одного preflight и ни одного заголовка с токеном. */
  const assertSimple = (r: Rig): void => {
    assert.equal(r.cors.preflights, 0);
    assert.ok(mock.calls().every((c) => c.method !== "OPTIONS" && !c.hasAuthHeader && c.origin === ORIGIN));
    for (const { init } of r.inits) {
      assert.equal(init.headers, undefined);
      assert.equal(init.credentials, "omit");
    }
  };

  before(async () => {
    mock = await startMock({
      port: 0,
      extraRoutes: (router) => {
        router.add("POST", "/v1/test/echo", (ctx) => ({
          status: 200,
          json: { formAccepted: ctx.formAccepted, form: ctx.form ? Object.fromEntries(ctx.form) : null, query: Object.fromEntries(ctx.query) },
        }));
        router.add("GET", "/v1/test/html", () => ({ status: 200, text: "<html>captive portal</html>", headers: { "content-type": "text/html" } }));
        router.add("GET", "/v1/test/broken-json", () => ({ status: 200, text: "{", headers: { "content-type": "application/json" } }));
        router.add("GET", "/v1/test/bad-request", () => ({ status: 400, json: { status: 400, error: "authorization_pending" } }));
      },
    });
  });
  after(async () => {
    await mock.close();
  });
  beforeEach(() => {
    mock.reset();
    token = mock.issueToken().access;
  });

  describe("simple requests (CC-01, CNFR-19)", () => {
    it("GET with the token in query: no preflight, no own headers, credentials omit", async () => {
      const r = rig();
      const res = await r.t.send(get("/v1/types", { query: { access_token: token } }));
      assert.equal(res.status, 200);
      assert.equal((res.json as { items: unknown[] }).items.length, 7);
      assert.equal(typeof res.ms, "number");
      assert.equal(r.inits[0].init.mode, "cors");
      assert.equal(r.inits[0].init.method, "GET");
      assert.equal(r.inits[0].init.body, undefined);
      assertSimple(r);
    });

    it("POST with a form sends a URLSearchParams body", async () => {
      const r = rig();
      const res = await r.t.send({ method: "POST", path: "/v1/test/echo", query: { access_token: token }, form: { title: "MSX Тест", n: 2 }, retry: "auto", timeoutMs: 8000, cls: "fg" });
      assert.deepEqual(res.json, { formAccepted: true, form: { title: "MSX Тест", n: "2" }, query: { access_token: token } });
      assert.ok(r.inits[0].init.body instanceof URLSearchParams);
      assert.match(mock.calls()[0].contentType ?? "", /^application\/x-www-form-urlencoded/);
      assertSimple(r);
    });

    it("POST with postBody: query sends the form in query and an empty body", async () => {
      const r = rig();
      r.flags.set("postBody", "query");
      const res = await r.t.send({ method: "POST", path: "/v1/test/echo", query: { access_token: token }, form: { title: "x", n: 2 }, retry: "auto", timeoutMs: 8000, cls: "fg" });
      assert.deepEqual(res.json, { formAccepted: false, form: null, query: { access_token: token, title: "x", n: "2" } });
      assert.equal(r.inits[0].init.body, undefined);
      assert.equal(mock.calls()[0].contentType, undefined);
      assertSimple(r);
    });
  });

  describe("buildUrl", () => {
    it("drops undefined query values and encodes the rest", () => {
      const r = rig();
      const url = r.t.buildUrl(get("/v1/items", { query: { type: "movie", genre: undefined, page: 2, q: "а b&c" } }));
      assert.equal(url, `${mock.url}/v1/items?type=movie&page=2&q=%D0%B0+b%26c`);
      assert.equal(r.t.buildUrl(get("/v1/types")), `${mock.url}/v1/types`);
    });

    it("puts the form into query only with postBody: query", () => {
      const r = rig();
      const post: ApiRequest = { method: "POST", path: "/oauth2/device", query: { grant_type: "device_code" }, form: { a: 1 }, retry: "none", timeoutMs: 15_000, cls: "fg" };
      assert.equal(r.t.buildUrl(post), `${mock.url}/oauth2/device?grant_type=device_code`);
      r.flags.set("postBody", "query");
      assert.equal(r.t.buildUrl(post), `${mock.url}/oauth2/device?grant_type=device_code&a=1`);
    });
  });

  describe("statuses", () => {
    it("429 twice with retry auto → success after pauses of 3 s and 6 s; fg limit is 1 for 30 s", async () => {
      mock.setScenario({ rules: [{ path: "^/v1/types$", status: 429, times: 2 }] });
      const r = rig();
      const t0 = r.clock.perf();
      const res = await r.clock.runUntilSettled(r.t.send(get("/v1/types", { query: { access_token: token } })));
      assert.equal(res.status, 200);
      assert.equal(r.clock.perf() - t0, 9000);
      assert.equal(mock.calls().length, 3);
      assert.equal(r.limiter.fgLimit(), 1);
      await r.clock.advance(23_999);
      assert.equal(r.limiter.fgLimit(), 1, "30 s after the last 429 have not passed yet");
      await r.clock.advance(1);
      assert.equal(r.limiter.fgLimit(), 3);
      assert.equal(r.metrics.summary().counters["api:429"], 2);
    });

    it("429 with retry none → KP-429 after exactly one call", async () => {
      mock.setScenario({ rules: [{ path: "^/v1/types$", status: 429 }] });
      const r = rig();
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/types", { retry: "none" }))), (e: unknown) => {
        kp("KP-429")(e);
        assert.equal((e as KpError).status, 429);
        return true;
      });
      assert.deepEqual(calls(), ["GET /v1/types"]);
      assert.equal(r.limiter.fgLimit(), 1);
    });

    it("500 with retry auto → 3 attempts, then KP-5XX", async () => {
      mock.setScenario({ rules: [{ path: "^/v1/items$", status: 500 }] });
      const r = rig();
      const t0 = r.clock.perf();
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/items"))), kp("KP-5XX"));
      assert.equal(mock.calls().length, 3);
      assert.equal(r.clock.perf() - t0, 9000);
    });

    it("401 → KP-AUTH and 404 → KP-404, without retries", async () => {
      const r = rig();
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/types"))), kp("KP-AUTH"));
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/nothing", { query: { access_token: token } }))), kp("KP-404"));
      assert.equal(mock.calls().length, 2);
    });

    it("other 4xx come back as a response, not an error", async () => {
      const r = rig();
      const res = await r.t.send(get("/v1/test/bad-request"));
      assert.equal(res.status, 400);
      assert.deepEqual(res.json, { status: 400, error: "authorization_pending" });
    });

    it("HTML or broken JSON → KP-BAD without retries", async () => {
      const r = rig();
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/test/html"))), kp("KP-BAD"));
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/test/broken-json"))), kp("KP-BAD"));
      assert.equal(mock.calls().length, 2);
    });
  });

  describe("network errors and the no-cors probe (CC-13, CM-01)", () => {
    it("3 dropped /v1/items in a row, /v1/types reachable → one probe, KP-429, api_no_cors", async () => {
      mock.setScenario({ rules: [{ path: "^/v1/items$", drop: true }] });
      const r = rig();
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/items", { query: { access_token: token } }))), kp("KP-429"));
      assert.deepEqual(calls(), [`GET /v1/items?access_token=${token}`, `GET /v1/items?access_token=${token}`, `GET /v1/items?access_token=${token}`, PROBE]);
      const noCors = r.inits.filter((i) => i.init.mode === "no-cors");
      assert.deepEqual(noCors.map((i) => [i.url, i.init.credentials]), [[`${mock.url}/v1/types?access_token=x`, "omit"]]);
      assert.ok(r.log.entries().some((e) => e.tag === "api" && e.level === "warn" && e.msg === "api_no_cors"));
      assert.equal(r.limiter.fgLimit(), 1);
    });

    it("everything dropped → KP-NET; the probe also fails", async () => {
      mock.setScenario({ rules: [{ path: ".*", drop: true }] });
      const r = rig();
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/items"))), kp("KP-NET"));
      assert.deepEqual(calls(), ["GET /v1/items", "GET /v1/items", "GET /v1/items", PROBE]);
      assert.equal(r.limiter.fgLimit(), 3);
      assert.ok(!r.log.entries().some((e) => e.msg === "api_no_cors"));
    });

    it("noCorsErrors + 429: the emulator gives TypeError, the transport says KP-429, never KP-CORS", async () => {
      mock.setScenario({ noCorsErrors: true, rules: [{ path: "^/v1/items$", status: 429 }] });
      const r = rig();
      let err: unknown;
      await r.clock.runUntilSettled(r.t.send(get("/v1/items")).catch((e: unknown) => (err = e)));
      kp("KP-429")(err);
      assert.notEqual((err as KpError).code, "KP-CORS");
      assert.deepEqual(calls(), ["GET /v1/items", "GET /v1/items", "GET /v1/items", PROBE]);
      assert.equal(r.limiter.fgLimit(), 1);
    });

    it("a probe verdict «no CORS» counts for the breaker as a reply, like a real 429 (BUG-29-1)", async () => {
      mock.setScenario({ noCorsErrors: true, rules: [{ path: "^/v1/items", status: 429 }] });
      const r = rig();
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/items"))), kp("KP-429"));
      assert.equal(r.breaker.state(), "closed");
      // Ещё два TypeError и проба: без сброса это были бы 4-й и 5-й сбои подряд — breaker открылся бы.
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/items/1"))), kp("KP-429"));
      assert.equal(r.breaker.state(), "closed");
      assert.equal(calls().filter((c) => c === PROBE).length, 2);
      assert.equal(calls().filter((c) => c === "GET /v1/items/1").length, 3);
    });

    it("the TypeError counter spans requests; a probe verdict pauses 6 s before the retry", async () => {
      mock.setScenario({ rules: [{ path: "^/v1/items$", drop: true, times: 3 }] });
      const r = rig();
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/items", { retry: "none" }))), kp("KP-NET"));
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/items", { retry: "none" }))), kp("KP-NET"));
      const t0 = r.clock.perf();
      const res = await r.clock.runUntilSettled(r.t.send(get("/v1/items", { query: { access_token: token } })));
      assert.equal(res.status, 200);
      assert.equal(r.clock.perf() - t0, 6000);
      assert.equal(calls().filter((c) => c === PROBE).length, 1);
    });

    it("a response resets the TypeError counter", async () => {
      mock.setScenario({ rules: [{ path: "^/v1/items$", drop: true }] });
      const r = rig();
      const once = (path: string): Promise<unknown> => r.clock.runUntilSettled(r.t.send(get(path, { retry: "none" }))).catch((e: unknown) => e);
      await once("/v1/items");
      await once("/v1/items");
      await once("/v1/types");
      await once("/v1/items");
      await once("/v1/items");
      assert.equal(calls().filter((c) => c === PROBE).length, 0);
    });

    it("an open breaker fails fast with KP-NET and sends nothing", async () => {
      const r = rig();
      for (let i = 0; i < 5; i++) r.breaker.failure();
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/types"))), kp("KP-NET", "breaker-open"));
      assert.equal(mock.calls().length, 0);
    });

    it("5 network failures open the breaker", async () => {
      // Обрыв и у пробы: если `/v1/types` доступен, проба признаёт «ответ без CORS», а это для breaker не сбой.
      mock.setScenario({ rules: [{ path: ".*", drop: true }] });
      const r = rig();
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/items"))), KpError);
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/items", { retry: "none" }))), KpError);
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/items", { retry: "none" }))), KpError);
      assert.equal(r.breaker.state(), "open");
    });

    it("probeNoCors() always uses the fixed safe URL", async () => {
      const r = rig();
      assert.equal(await r.clock.runUntilSettled(r.t.probeNoCors()), true);
      mock.setScenario({ rules: [{ path: ".*", drop: true }] });
      assert.equal(await r.clock.runUntilSettled(r.t.probeNoCors()), false);
      assert.deepEqual(calls(), [PROBE, PROBE]);
      assert.ok(r.inits.every((i) => i.init.mode === "no-cors" && i.init.credentials === "omit"));
    });
  });

  // Этап 33b: блокировка по SNI или упавший VPN — TLS-рукопожатие висит, fetch не отвечает ничем. Раньше экран ждал
  // таймаут (8 с, у OAuth и карточки 15 с) и повторы 3 с и 6 с: «Нет связи» — через 33 с, у карточки через 54 с.
  describe("a hung connection (stage 33b: SNI block, VPN down)", () => {
    const NO_ANSWER_MS = 6000;
    const hang = (path: string): void => mock.setScenario({ rules: [{ path, hang: true }] });
    /** Всё, что дальше уходит в сеть, висит: ждать ответы в реальном времени перед каждым поддельным таймером незачем. */
    const silent = (r: Rig): Rig => {
      r.clock.ioGraceMs = 20;
      return r;
    };
    const authed = (path: string, over: Partial<ApiRequest> = {}): ApiRequest => get(path, { query: { access_token: token }, ...over });
    /** Попытка висит, пока транспорт её не оборвёт (как fetch с AbortController). */
    const hung = (init: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    });
    const logged = (r: Rig, re: RegExp): boolean => r.log.entries().some((e) => e.tag === "api" && re.test(e.msg));

    it("nothing has ever answered: KP-NET no-answer after 6 s without retries; the fetch itself runs on to its own timeout", async () => {
      hang("^/v1/items$");
      const r = silent(rig());
      const t0 = r.clock.perf();
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/items"))), kp("KP-NET", "no-answer"));
      assert.equal(r.clock.perf() - t0, NO_ANSWER_MS);
      assert.deepEqual(calls(), ["GET /v1/items"]);
      const signal = r.inits[0]?.init.signal as AbortSignal;
      assert.equal(signal.aborted, false, "a slow but alive network may still answer it");
      await r.clock.advance(8000 - NO_ANSWER_MS);
      assert.equal(signal.aborted, true, "its usual timeout of 8 s ends it");
      await r.clock.advance(60_000);
      assert.deepEqual(calls(), ["GET /v1/items"], "no retries, no no-cors probe");
      assert.equal(r.metrics.summary().counters["api:no_answer"], 1);
      assert.ok(logged(r, /^GET \/v1\/items no-answer 6000ms fg$/), JSON.stringify(r.log.entries()));
    });

    it("the verdict also ends requests waiting in the limiter queue; those never reach the network", async () => {
      hang("^/v1/items");
      const r = silent(rig());
      const sends = [1, 2, 3, 4, 5].map((id) => r.t.send(get(`/v1/items/${id}`)).catch((e: unknown) => e));
      const t0 = r.clock.perf();
      const errs = await r.clock.runUntilSettled(Promise.all(sends));
      assert.equal(r.clock.perf() - t0, NO_ANSWER_MS);
      for (const e of errs) kp("KP-NET", "no-answer")(e);
      assert.equal(mock.calls().length, 3, "3 in flight (CNFR-18), 2 waited in the queue");
      await r.clock.advance(60_000);
      assert.equal(mock.calls().length, 3, "the abandoned ones are not sent later");
      assert.deepEqual(r.limiter.inFlight(), { fg: 0, bg: 0 });
    });

    it("a late answer to an abandoned request proves the link: the next slow request is not cut at 6 s", async () => {
      hang("^/v1/items$");
      const r = rig();
      await assert.rejects(r.clock.runUntilSettled(r.t.send(authed("/v1/items"))), kp("KP-NET", "no-answer"));
      assert.equal(mock.release(), 1);
      // Поздний ответ ждём, не двигая поддельное время: под нагрузкой часы дошли бы до таймаута 8 с раньше ответа.
      for (let i = 0; i < 1000 && !logged(r, /^GET \/v1\/items 200 /); i++) await realSleep(10);
      assert.ok(logged(r, /^GET \/v1\/items 200 /), "the late answer arrived");
      hang("^/v1/items$");
      const t0 = r.clock.perf();
      await assert.rejects(r.clock.runUntilSettled(r.t.send(authed("/v1/items"))), kp("KP-NET", "timeout"));
      assert.equal(r.clock.perf() - t0, 8000, "the full timeout; nothing answered meanwhile — no blind retry");
      assert.equal(mock.calls().length, 2);
    });

    it("a timeout while KinoPub answers other requests is retried after 3 s and 6 s (spec §5.3)", async () => {
      // Каждая попытка /v1/items висит, а KinoPub тем временем отвечает на /v1/types: связь жива, потерян один ответ.
      const r: Rig = rig((url, init, next) => {
        if (!url.includes("/v1/items")) return next(url, init);
        void r.t.send(authed("/v1/types")).catch(() => undefined);
        return hung(init);
      });
      const t0 = r.clock.perf();
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/items"))), kp("KP-NET", "timeout"));
      assert.equal(r.clock.perf() - t0, 8000 + 3000 + 8000 + 6000 + 8000);
      assert.equal(r.inits.filter((i) => i.url.includes("/v1/items")).length, 3);
      assert.equal(calls().filter((c) => c === PROBE).length, 0, "a timeout is not a TypeError: no probe");
    });

    it("the link goes quiet mid-session: the first timeout is final at 8 s, the requests waiting behind it end at once", async () => {
      const r = rig();
      await r.clock.runUntilSettled(r.t.send(authed("/v1/types")));
      hang("^/v1/items");
      silent(r);
      const sends = [1, 2, 3, 4, 5].map((id) => r.t.send(get(`/v1/items/${id}`)).catch((e: unknown) => e));
      const t0 = r.clock.perf();
      const errs = await r.clock.runUntilSettled(Promise.all(sends));
      assert.equal(r.clock.perf() - t0, 8000);
      for (const e of errs) kp("KP-NET")(e);
      assert.equal(mock.calls().filter((c) => c.path.startsWith("/v1/items")).length, 3);
      // Следующий запрос на молчащей связи — вердикт через 6 с.
      const t1 = r.clock.perf();
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/items/6"))), kp("KP-NET", "no-answer"));
      assert.equal(r.clock.perf() - t1, NO_ANSWER_MS);
    });

    it("retry: none is never abandoned (refresh rotates the pair, CM-01): it waits for its own timeout", async () => {
      hang("^/oauth2/token$");
      const r = silent(rig());
      const t0 = r.clock.perf();
      const refresh: ApiRequest = { method: "POST", path: "/oauth2/token", retry: "none", timeoutMs: 15_000, cls: "fg" };
      await assert.rejects(r.clock.runUntilSettled(r.t.send(refresh)), kp("KP-NET", "timeout"));
      assert.equal(r.clock.perf() - t0, 15_000);
    });

    it("TypeErrors are not a hang: 3 attempts and the no-cors probe as before (CC-13)", async () => {
      mock.setScenario({ rules: [{ path: ".*", drop: true }] });
      const r = rig();
      await assert.rejects(r.clock.runUntilSettled(r.t.send(get("/v1/items"))), kp("KP-NET", "network"));
      assert.deepEqual(calls(), ["GET /v1/items", "GET /v1/items", "GET /v1/items", PROBE]);
    });
  });

  describe("request class", () => {
    it("prio: a bg request waiting for the bg slot is sent as fg after promote(); later attempts use the current class", async () => {
      const r = rig();
      let release = (): void => {};
      const hold = r.limiter.run("bg", () => new Promise<void>((res) => (release = res)));
      const prio = new Priority("bg");
      const req = get("/v1/types", { query: { access_token: token }, cls: "bg", prio });
      const p = r.t.send(req);
      await r.clock.advance(0);
      assert.equal(mock.calls().length, 0, "waits for the only bg slot");

      prio.promote();
      assert.equal((await r.clock.runUntilSettled(p)).status, 200);
      assert.equal((await r.clock.runUntilSettled(r.t.send(req))).status, 200, "a new attempt queues as fg at once");
      assert.deepEqual(r.limiter.inFlight(), { fg: 0, bg: 1 }, "the bg slot is still held");
      const api = r.log.entries().filter((e) => e.tag === "api");
      assert.ok(api.length === 2 && api.every((e) => /^GET \/v1\/types 200 \d+ms fg$/.test(e.msg)), JSON.stringify(api));
      release();
      await hold;
    });
  });

  describe("journal and metrics", () => {
    it("logs METHOD path status ms class without the access_token; metric without ids", async () => {
      const r = rig();
      await r.t.send(get("/v1/items/2001", { query: { access_token: token, nolinks: 1 }, timeoutMs: 15_000 }));
      mock.setScenario({ rules: [{ path: "^/v1/types$", drop: true }] });
      await r.clock.runUntilSettled(r.t.send(get("/v1/types", { query: { access_token: token }, retry: "none", cls: "bg" }))).catch(() => {});
      const api = r.log.entries().filter((e) => e.tag === "api");
      assert.match(api[0].msg, /^GET \/v1\/items\/2001 200 \d+ms fg$/);
      assert.ok(api.some((e) => /^GET \/v1\/types \S+ \d+ms bg$/.test(e.msg)), JSON.stringify(api));
      assert.ok(!JSON.stringify(r.log.entries()).includes(token), "access_token value leaked into the journal");
      assert.ok("api:/v1/items/:id" in r.metrics.summary().values);
    });
  });
});
