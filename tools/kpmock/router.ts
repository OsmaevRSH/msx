import type { IncomingMessage } from "node:http";
import type { Scenario } from "./scenario.ts";
import type { MockState } from "./state.ts";

export interface MockResponse {
  status: number; json?: unknown; text?: string; body?: Buffer; headers?: Record<string, string>;
  drop?: boolean;              // оборвать соединение вместо ответа (клиент получит TypeError)
}

export interface HandlerCtx {
  req: IncomingMessage; url: URL; params: Record<string, string>; query: URLSearchParams;
  form: URLSearchParams | undefined;   // тело POST, только если formAccepted
  formAccepted: boolean;               // Content-Type начинается с application/x-www-form-urlencoded (ловушка Apple)
  state: MockState;
  base: string;                        // http://<Host запроса>, иначе адрес сервера; для ссылок на CDN и постеры
  scenario: Scenario;
}

export type Handler = (ctx: HandlerCtx) => MockResponse | Promise<MockResponse>;

/** Брошенная из обработчика ошибка превращается сервером в ответ `status` с телом `json`. */
export class HttpError extends Error {
  status: number;
  json: unknown;
  constructor(status: number, json: unknown) {
    super(`HTTP ${status}`);
    this.status = status;
    this.json = json;
  }
}

/** Токен — только из `?access_token=` (спец. §5.2); заголовок Authorization не читается. Иначе — 401. */
export function requireAuth(ctx: HandlerCtx): { access: string; deviceId: number } {
  const access = ctx.query.get("access_token") ?? "";
  const rec = access ? ctx.state.tokenInfo(access) : undefined;
  if (!rec) throw new HttpError(401, { status: 401, error: "unauthorized" });
  return { access, deviceId: rec.deviceId };
}

interface Route { method: string; re: RegExp; score: number; handler: Handler }

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compile(pattern: string): { re: RegExp; score: number } {
  let score = 0;
  const src = pattern.split("/").map((seg) => {
    if (!seg.startsWith(":")) return escapeRe(seg);
    score += 1;
    return `(?<${seg.slice(1)}>[^/]+)`;
  }).join("/");
  return { re: new RegExp(`^${src}$`), score };
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/**
 * Маршруты вида `/v1/items/:id` или RegExp с именованными группами. Если подходят несколько,
 * выигрывает маршрут с меньшим числом параметров (статический путь раньше `:id`, RegExp — последним),
 * при равенстве — добавленный раньше. HEAD обслуживается GET-маршрутом, метод `*` — любой.
 */
export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string | RegExp, h: Handler): void {
    const { re, score } = typeof pattern === "string" ? compile(pattern) : { re: pattern, score: 1000 };
    this.routes.push({ method: method.toUpperCase(), re, score, handler: h });
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | undefined {
    const m = method.toUpperCase();
    let best: { route: Route; groups: Record<string, string> } | undefined;
    for (const route of this.routes) {
      if (route.method !== "*" && route.method !== m && !(m === "HEAD" && route.method === "GET")) continue;
      if (best && route.score >= best.route.score) continue;
      const hit = route.re.exec(path);
      if (hit) best = { route, groups: { ...hit.groups } };
    }
    if (!best) return undefined;
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(best.groups)) if (v !== undefined) params[k] = decode(v);
    return { handler: best.route.handler, params };
  }
}
