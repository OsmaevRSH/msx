export type KpErrorCode = "KP-NET" | "KP-429" | "KP-5XX" | "KP-404" | "KP-AUTH" | "KP-CORS" | "KP-BAD";

export class KpError extends Error {
  code: KpErrorCode;
  status: number | undefined;
  detail: string | undefined;

  constructor(code: KpErrorCode, message: string, status?: number, detail?: string) {
    super(message);
    this.name = "KpError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function isKpError(e: unknown): e is KpError {
  return e instanceof KpError;
}

// Спец. §5.3: TypeError из fetch неотличим для CORS, DNS, TCP/TLS и VPN — всё это временная сеть.
// Таймаут через AbortController (AbortError) или AbortSignal.timeout (TimeoutError) — тоже сеть.
const NET_ERROR_NAMES = ["TypeError", "AbortError", "TimeoutError"];

export function toKpError(e: unknown): KpError {
  if (isKpError(e)) return e;
  const name = errorName(e);
  const message = errorMessage(e);
  if (e instanceof TypeError || (name !== undefined && NET_ERROR_NAMES.includes(name))) {
    return new KpError("KP-NET", message, undefined, name);
  }
  return new KpError("KP-BAD", message, undefined, name);
}

function errorName(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const name = (e as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function errorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(e);
}
