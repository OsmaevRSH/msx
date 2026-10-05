import type { FetchLike } from "../../src/api/transport.ts";

/**
 * Эмулятор браузерного CORS поверх `fetch` Node (решение Р-6): Node CORS не проверяет, а тесты CC-01 и CC-13
 * должны видеть то же, что WebView ТВ. Повторяет спецификацию Fetch в той мере, в какой она касается плагина:
 * простые запросы, preflight, проверка `Access-Control-Allow-*`, скрытие заголовков ответа, `no-cors`.
 */
export type CorsFetch = FetchLike & { readonly preflights: number };

export interface CorsFetchOptions {
  origin: string;                       // origin страницы плагина, например https://example.github.io
  log?: (line: string) => void;
  fetch?: typeof fetch;                 // нижележащий fetch; по умолчанию глобальный
}

const SIMPLE_METHODS = new Set(["GET", "HEAD", "POST"]);
const SIMPLE_CONTENT_TYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]);
const SAFE_REQUEST_HEADERS = new Set(["accept", "accept-language", "content-language", "content-type"]);
const SAFE_RESPONSE_HEADERS = new Set([
  "cache-control", "content-language", "content-length", "content-type", "expires", "last-modified", "pragma",
]);
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

const failed = (): TypeError => new TypeError("Failed to fetch");

function list(v: string | null): Set<string> {
  return new Set((v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== ""));
}

/** Имена заголовков вне CORS-safelist (нижний регистр, по алфавиту), как в `Access-Control-Request-Headers`. */
function unsafeHeaderNames(h: Headers, body: unknown): string[] {
  const out: string[] = [];
  for (const [name, value] of h) {
    if (!SAFE_REQUEST_HEADERS.has(name) || value.length > 128) out.push(name);
    else if (name === "content-type" && !SIMPLE_CONTENT_TYPES.has(mimeEssence(value))) out.push(name);
  }
  if (!h.has("content-type") && body instanceof Blob && body.type !== "" && !SIMPLE_CONTENT_TYPES.has(mimeEssence(body.type))) {
    out.push("content-type");
  }
  return out.sort();
}

function mimeEssence(v: string): string {
  return (v.split(";")[0] ?? "").trim().toLowerCase();
}

/** CORS check спецификации Fetch: ACAO равен `*` (без credentials) или origin; с credentials ещё ACAC: true. */
function corsCheck(res: Response, origin: string, withCredentials: boolean): boolean {
  const acao = res.headers.get("access-control-allow-origin");
  if (acao === null) return false;
  if (!withCredentials) return acao === "*" || acao === origin;
  return acao === origin && res.headers.get("access-control-allow-credentials") === "true";
}

function exposed(res: Response, withCredentials: boolean): Headers {
  const expose = list(res.headers.get("access-control-expose-headers"));
  const all = expose.has("*") && !withCredentials;
  const out = new Headers();
  for (const [name, value] of res.headers) {
    if (name === "set-cookie" || name === "set-cookie2") continue;
    if (SAFE_RESPONSE_HEADERS.has(name) || expose.has(name) || all) out.append(name, value);
  }
  return out;
}

function withProps(r: Response, props: Record<string, unknown>): Response {
  for (const [k, value] of Object.entries(props)) Object.defineProperty(r, k, { value, enumerable: true });
  return r;
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // тело уже прочитано или соединение закрыто
  }
}

export function createCorsFetch(opts: CorsFetchOptions): CorsFetch {
  const origin = new URL(opts.origin).origin;
  const base = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});
  let preflights = 0;

  // Сетевая ошибка в браузере — TypeError; отмена через signal остаётся AbortError.
  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await base(url, init);
    } catch (e) {
      if (init.signal?.aborted) throw init.signal.reason ?? e;
      log(`${init.method ?? "GET"} ${url} network error`);
      throw failed();
    }
  }

  async function preflight(url: string, method: string, unsafe: string[], signal: AbortSignal | undefined, withCredentials: boolean): Promise<void> {
    preflights += 1;
    const h = new Headers({ Origin: origin, "Access-Control-Request-Method": method, Accept: "*/*" });
    if (unsafe.length > 0) h.set("Access-Control-Request-Headers", unsafe.join(","));
    const res = await send(url, { method: "OPTIONS", headers: h, signal: signal ?? null });
    await discard(res);
    const ok = res.status >= 200 && res.status < 300 && corsCheck(res, origin, withCredentials);
    const methods = list(res.headers.get("access-control-allow-methods"));
    const allowed = list(res.headers.get("access-control-allow-headers"));
    const methodOk = SIMPLE_METHODS.has(method) || methods.has(method.toLowerCase()) || (methods.has("*") && !withCredentials);
    // Fetch: «*» в Allow-Headers не покрывает Authorization (спец. §5.2).
    const headersOk = unsafe.every((n) => allowed.has(n) || (allowed.has("*") && !withCredentials && n !== "authorization"));
    log(`OPTIONS ${url} ${res.status} ${ok && methodOk && headersOk ? "allowed" : "blocked"}`);
    if (!ok || !methodOk || !headersOk) throw failed();
  }

  const corsFetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = (init.method ?? "GET").toUpperCase();
    const mode = init.mode ?? "cors";
    const target = new URL(url);
    const sameOrigin = target.origin === origin;
    const h = new Headers(init.headers);
    const body = init.body ?? null;
    const unsafe = unsafeHeaderNames(h, body);
    const signal = init.signal ?? undefined;
    // credentials по умолчанию same-origin: на чужой origin cookie не уходят.
    const withCredentials = init.credentials === "include";
    if (signal?.aborted) throw signal.reason;

    if (mode === "same-origin" && !sameOrigin) throw failed();
    if (mode === "no-cors" && (!SIMPLE_METHODS.has(method) || unsafe.length > 0)) throw failed();
    if (mode === "cors" && !sameOrigin && (!SIMPLE_METHODS.has(method) || unsafe.length > 0)) {
      await preflight(url, method, unsafe, signal, withCredentials);
    }

    if (!sameOrigin && (mode === "cors" || (method !== "GET" && method !== "HEAD"))) h.set("Origin", origin);
    const res = await send(url, { method, headers: h, body, signal: signal ?? null, redirect: init.redirect ?? "follow" });

    if (sameOrigin) return res;
    if (mode === "no-cors") {
      await discard(res);
      log(`${method} ${url} ${res.status} opaque`);
      return withProps(new Response(null), { type: "opaque", status: 0, ok: false, statusText: "", url: "", redirected: false });
    }
    if (!corsCheck(res, origin, withCredentials)) {
      await discard(res);
      log(`${method} ${url} ${res.status} blocked: no Access-Control-Allow-Origin`);
      throw failed();
    }
    log(`${method} ${url} ${res.status}`);
    const out = new Response(NULL_BODY_STATUS.has(res.status) ? null : res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: exposed(res, withCredentials),
    });
    return withProps(out, { type: "cors", url: res.url, redirected: res.redirected });
  };

  Object.defineProperty(corsFetch, "preflights", { get: () => preflights, enumerable: true });
  return corsFetch as CorsFetch;
}
