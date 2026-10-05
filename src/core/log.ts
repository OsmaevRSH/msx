import type { Clock } from "./clock.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  t: number;
  level: LogLevel;
  tag: string;
  msg: string;
  data?: Record<string, unknown>;
}

// CNFR-20, спец. §13: токены и коды входа не попадают в журнал.
const KEYS = "access_token|refresh_token|user_code|code|client_secret";
const QUERY_RE = new RegExp(`\\b(${KEYS})=[^&\\s"'#\\\\]+`, "g");
const NUMBER = "-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?";
const JSON_RE = new RegExp(`("(?:${KEYS})"\\s*:\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|${NUMBER})`, "g");
// JSON, сериализованный внутрь строки другого JSON: \"code\":\"…\".
const ESCAPED_JSON_RE = new RegExp(`(\\\\"(?:${KEYS})\\\\"\\s*:\\s*)(?:\\\\"[^]*?\\\\"|${NUMBER})`, "g");

export function maskSecrets(s: string): string {
  return s
    .replace(QUERY_RE, "$1=***")
    .replace(JSON_RE, '$1"***"')
    .replace(ESCAPED_JSON_RE, '$1\\"***\\"');
}

function maskData(data: Record<string, unknown>): Record<string, unknown> {
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    return { unserializable: true };
  }
  const masked = maskSecrets(json);
  try {
    return JSON.parse(masked) as Record<string, unknown>;
  } catch {
    return { masked };
  }
}

export class Logger {
  sink: ((e: LogEntry) => void) | undefined;

  private clock: Clock;
  private capacity: number;
  private buf: LogEntry[] = [];
  private head = 0;

  constructor(clock: Clock, capacity = 500) {
    this.clock = clock;
    this.capacity = Math.max(1, capacity);
  }

  debug(tag: string, msg: string, data?: Record<string, unknown>): void {
    this.write("debug", tag, msg, data);
  }

  info(tag: string, msg: string, data?: Record<string, unknown>): void {
    this.write("info", tag, msg, data);
  }

  warn(tag: string, msg: string, data?: Record<string, unknown>): void {
    this.write("warn", tag, msg, data);
  }

  error(tag: string, msg: string, data?: Record<string, unknown>): void {
    this.write("error", tag, msg, data);
  }

  entries(): LogEntry[] {
    return this.buf.slice(this.head).concat(this.buf.slice(0, this.head));
  }

  tail(n: number): LogEntry[] {
    return n > 0 ? this.entries().slice(-n) : [];
  }

  private write(level: LogLevel, tag: string, msg: string, data?: Record<string, unknown>): void {
    const e: LogEntry = { t: this.clock.now(), level, tag, msg: maskSecrets(msg) };
    if (data !== undefined) e.data = maskData(data);
    if (this.buf.length < this.capacity) {
      this.buf.push(e);
    } else {
      this.buf[this.head] = e;
      this.head = (this.head + 1) % this.capacity;
    }
    if (this.sink !== undefined) {
      try {
        this.sink(e);
      } catch {
        // Сбой вывода журнала не должен ломать вызывающий код.
      }
    }
  }
}
