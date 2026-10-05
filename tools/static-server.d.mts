// Типы для tools/static-server.mjs.

export interface StaticServer {
  /** `http://<host>:<port>` без завершающего «/». */
  url: string;
  close(): Promise<void>;
}

/** port 0 (по умолчанию) — случайный свободный порт; host по умолчанию 127.0.0.1. */
export function serveStatic(opts: { dir: string; port?: number; host?: string }): Promise<StaticServer>;
