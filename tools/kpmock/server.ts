import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpError, Router } from "./router.ts";
import type { HandlerCtx, MockResponse } from "./router.ts";
import { registerAll } from "./routes/index.ts";
import { DEFAULT_SCENARIO, cloneScenario, mergeScenario, overLimit, takeRule } from "./scenario.ts";
import type { Scenario } from "./scenario.ts";
import { MockState } from "./state.ts";

export interface MockOptions {
  port?: number; host?: string; media?: "playlist" | "webm";   // port 0 = случайный, host "127.0.0.1"
  extraRoutes?: (r: Router) => void;                           // дополнительные маршруты только для тестов
}
export interface CallRecord { t: number; method: string; path: string; query: string; contentType?: string;
  origin?: string; hasAuthHeader: boolean; status: number }   // status 0 — соединение оборвано
export interface MockServer { url: string; state: MockState; calls(): CallRecord[]; stats(): { maxInFlight: number };
  setScenario(p: Partial<Scenario>): void; reset(): void; issueToken(): { access: string; refresh: string }; close(): Promise<void> }

type Kind = "api" | "cdn" | "control" | "other";

function kindOf(path: string): Kind {
  if (path.startsWith("/v1/") || path.startsWith("/oauth2/")) return "api";
  if (path.startsWith("/__mock/")) return "control";
  if (path.startsWith("/cdn/") || path.startsWith("/poster/")) return "cdn";
  return "other";
}

// Заголовки боевого API (спец. §5.1, CFX-01): ACA* на ответах, включая 401.
const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "1728000",
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function startMock(opts: MockOptions = {}): Promise<MockServer> {
  const host = opts.host ?? "127.0.0.1";
  const baseScenario = mergeScenario(DEFAULT_SCENARIO, { media: opts.media ?? DEFAULT_SCENARIO.media });
  const state = new MockState();
  const router = new Router();
  let scenario = cloneScenario(baseScenario);
  let calls: CallRecord[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let window: number[] = [];
  let url = "";

  registerAll(router, state, () => url);
  opts.extraRoutes?.(router);

  const mock: MockServer = {
    url: "",
    state,
    calls: () => calls.map((c) => ({ ...c })),
    stats: () => ({ maxInFlight }),
    setScenario: (p) => { scenario = mergeScenario(scenario, p); },
    reset: () => {
      state.reset();
      scenario = cloneScenario(baseScenario);
      calls = [];
      maxInFlight = 0;
      window = [];
    },
    issueToken: () => {
      const device = state.createDevice({ title: "kpmock TV", hardware: "kpmock", software: "kpmock" });
      return state.issueToken(device, scenario.accessTtlSec);
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };

  function apiHeaders(status: number, ruleNoCors: boolean): Record<string, string> {
    const h: Record<string, string> = { server: "nginx", "cache-control": "private, no-store" };
    const errorNoCors = (status === 429 || status >= 500) && (ruleNoCors || scenario.noCorsErrors);
    if (!scenario.corsOff && !errorNoCors) Object.assign(h, CORS);
    if (status === 401) h["www-authenticate"] = 'Bearer realm="api"';
    return h;
  }

  function reply(res: ServerResponse, rec: CallRecord, kind: Kind, out: MockResponse, opt: { ruleNoCors?: boolean; head?: boolean } = {}): void {
    const headers: Record<string, string> = kind === "api" ? apiHeaders(out.status, opt.ruleNoCors === true) : {};
    let payload: Buffer | string = "";
    if (out.body !== undefined) {
      payload = out.body;
      headers["content-type"] = "application/octet-stream";
    } else if (out.text !== undefined) {
      payload = out.text;
      headers["content-type"] = "text/plain; charset=utf-8";
    } else if (out.json !== undefined) {
      payload = JSON.stringify(out.json);
      headers["content-type"] = "application/json; charset=utf-8";
    }
    for (const [k, v] of Object.entries(out.headers ?? {})) headers[k.toLowerCase()] = v;
    rec.status = out.status;
    res.writeHead(out.status, headers);
    res.end(opt.head ? undefined : payload);
  }

  function drop(req: IncomingMessage, rec: CallRecord): void {
    rec.status = 0;
    req.socket.destroy();
  }

  function notFound(kind: Kind): MockResponse {
    return kind === "api" ? { status: 404, json: { status: 404, error: "Not found" } } : { status: 404, text: "Not found" };
  }

  async function control(req: IncomingMessage, res: ServerResponse, method: string, path: string): Promise<void> {
    const body = await readBody(req);
    const send = (status: number, json: unknown): void => {
      res.writeHead(status, { "access-control-allow-origin": "*", "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(json));
    };
    switch (`${method} ${path}`) {
      case "GET /__mock/calls": return send(200, mock.calls());
      case "GET /__mock/stats": return send(200, mock.stats());
      case "GET /__mock/scenario": return send(200, scenario);
      case "POST /__mock/scenario": {
        let patch: unknown;
        try {
          patch = JSON.parse(body.toString("utf8") || "{}");
        } catch {
          return send(400, { status: 400, error: "bad json" });
        }
        if (typeof patch !== "object" || patch === null || Array.isArray(patch)) return send(400, { status: 400, error: "object expected" });
        mock.setScenario(patch as Partial<Scenario>);
        return send(200, scenario);
      }
      case "POST /__mock/reset":
        mock.reset();
        return send(200, { status: 200 });
      case "POST /__mock/token": {
        const pair = mock.issueToken();
        return send(200, { access: pair.access, refresh: pair.refresh, expires_in: scenario.accessTtlSec });
      }
      case "POST /__mock/expire-access":
        state.expireAllAccess();
        return send(200, { status: 200 });
      default:
        return send(404, { status: 404, error: "Not found" });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const reqUrl = new URL(req.url ?? "/", "http://kpmock.invalid");
    const path = reqUrl.pathname;
    const kind = kindOf(path);
    if (kind === "control" && method !== "OPTIONS") return control(req, res, method, path);

    const rec: CallRecord = { t: Date.now(), method, path, query: reqUrl.search.slice(1), hasAuthHeader: req.headers.authorization !== undefined, status: 0 };
    if (req.headers["content-type"] !== undefined) rec.contentType = req.headers["content-type"];
    if (req.headers.origin !== undefined) rec.origin = req.headers.origin;
    calls.push(rec);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    res.once("close", () => { inFlight -= 1; });

    // Любой preflight отклоняется без CORS, хотя боевой сервер его поддерживает: так ловится непростой запрос (CNFR-19).
    if (method === "OPTIONS") return reply(res, rec, "other", { status: 405, text: "Method Not Allowed" });

    const body = await readBody(req);
    if (scenario.delayMs > 0) await sleep(scenario.delayMs);
    const rule = takeRule(scenario, method, path);
    if (rule) {
      if (rule.delayMs) await sleep(rule.delayMs);
      if (rule.drop) return drop(req, rec);
      if (rule.status !== undefined) {
        return reply(res, rec, kind, { status: rule.status, json: { status: rule.status, error: "mock" } }, { ruleNoCors: rule.noCors === true });
      }
    }
    if (kind === "api" && overLimit(scenario, window, Date.now())) {
      return reply(res, rec, kind, { status: 429, json: { status: 429, error: "Too Many Requests" } });
    }

    const head = method === "HEAD";
    const route = router.match(method, path);
    if (!route) return reply(res, rec, kind, notFound(kind), { head });
    const formAccepted = (req.headers["content-type"] ?? "").toLowerCase().startsWith("application/x-www-form-urlencoded");
    const ctx: HandlerCtx = {
      req, url: reqUrl, params: route.params, query: reqUrl.searchParams,
      form: formAccepted ? new URLSearchParams(body.toString("utf8")) : undefined, formAccepted,
      state, base: req.headers.host ? `http://${req.headers.host}` : url, scenario,
    };
    let out: MockResponse;
    try {
      out = await route.handler(ctx);
    } catch (e) {
      out = e instanceof HttpError
        ? { status: e.status, json: e.json }
        : { status: 500, json: { status: 500, error: `kpmock: ${e instanceof Error ? e.message : String(e)}` } };
    }
    if (out.drop) return drop(req, rec);
    reply(res, rec, kind, out, { head });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      } else {
        req.socket.destroy();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  url = `http://${shown}:${port}`;
  mock.url = url;
  return mock;
}
