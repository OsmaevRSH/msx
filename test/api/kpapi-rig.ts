import { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Breaker } from "../../src/api/breaker.ts";
import { KpApi } from "../../src/api/client.ts";
import type { TokenSource } from "../../src/api/client.ts";
import { Limiter } from "../../src/api/limiter.ts";
import { Transport } from "../../src/api/transport.ts";
import type { ApiRequest, ApiResponse, FetchLike } from "../../src/api/transport.ts";
import { KvStore } from "../../src/bridge/storage.ts";
import { DEFAULT_FLAGS, FlagStore } from "../../src/config/flags.ts";
import { KpError } from "../../src/core/errors.ts";
import { Logger } from "../../src/core/log.ts";
import { Metrics } from "../../src/core/metrics.ts";
import { startMock } from "../../tools/kpmock/server.ts";
import type { CallRecord, MockOptions, MockServer } from "../../tools/kpmock/server.ts";
import { createCorsFetch } from "../helpers/cors-fetch.ts";
import type { CorsFetch } from "../helpers/cors-fetch.ts";
import { FakeClock } from "../helpers/fake-clock.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";

// Общая обвязка contract-тестов KpApi: kpmock на порту 0, эмулятор CORS, FakeClock.

export const ORIGIN = "https://example.github.io";

/** Транспорт, который запоминает сформированные клиентом запросы (таблица повторов и таймаутов §0.6.5). */
export class SpyTransport extends Transport {
  reqs: ApiRequest[] = [];

  send(req: ApiRequest): Promise<ApiResponse> {
    this.reqs.push(req);
    return super.send(req);
  }
}

/** Простой источник токенов над `mock.issueToken()`; refresh — через сам клиент, без single-flight (это этап 14). */
export class TestTokens implements TokenSource {
  pair: { access: string; refresh: string } | undefined;
  gen = 1;
  refreshCalls: number[] = [];
  repair = true;
  api: KpApi | undefined;

  access(): { token: string; gen: number } | undefined {
    return this.pair ? { token: this.pair.access, gen: this.gen } : undefined;
  }

  async refresh(gen: number): Promise<void> {
    this.refreshCalls.push(gen);
    if (!this.repair || !this.pair || !this.api) return;
    const raw = await this.api.refreshToken(this.pair.refresh);
    this.pair = { access: raw.access, refresh: raw.refresh };
    this.gen += 1;
  }
}

export interface Rig {
  api: KpApi; t: SpyTransport; tokens: TestTokens; clock: FakeClock; log: Logger; flags: FlagStore;
  run<T>(p: Promise<T>): Promise<T>;
}

export interface KpApiEnv {
  mock(): MockServer;
  rig(): Rig;
  calls(path?: string): CallRecord[];
  control(path: string): Promise<void>;
  cors: CorsFetch;
}

/** KpError с нужным кодом (и статусом); для assert.rejects. */
export const kp = (code: string, status?: number) => (e: unknown): boolean => {
  assert.ok(e instanceof KpError, `expected KpError, got ${String(e)}`);
  assert.equal(e.code, code);
  if (status !== undefined) assert.equal(e.status, status);
  return true;
};

export const q = (c: CallRecord): URLSearchParams => new URLSearchParams(c.query);

/**
 * Регистрирует хуки в текущем `describe`. После каждого теста проверяет критерий этапа 13: ни preflight,
 * ни своих заголовков; `access_token` только в query и только у `/v1/*`.
 */
export function useKpApiMock(extraRoutes?: MockOptions["extraRoutes"]): KpApiEnv {
  let mock: MockServer | undefined;
  const cors = createCorsFetch({ origin: ORIGIN });
  const inits: RequestInit[] = [];
  const fetch: FetchLike = (url, init) => {
    inits.push(init);
    return cors(url, init);
  };
  const server = (): MockServer => {
    assert.ok(mock, "kpmock is not started");
    return mock;
  };

  before(async () => {
    mock = await startMock(extraRoutes ? { port: 0, extraRoutes } : { port: 0 });
  });
  after(async () => {
    await server().close();
  });
  beforeEach(() => {
    server().reset();
    inits.length = 0;
  });
  afterEach(() => {
    for (const c of server().calls()) {
      assert.notEqual(c.method, "OPTIONS");
      assert.equal(c.hasAuthHeader, false);
      assert.equal(q(c).has("access_token"), c.path.startsWith("/v1/"), `${c.method} ${c.path}: access_token only on /v1/*`);
    }
    for (const init of inits) {
      assert.equal(init.headers, undefined);
      assert.equal(init.credentials, "omit");
    }
  });

  return {
    mock: server,
    cors,
    calls: (path) => server().calls().filter((c) => path === undefined || c.path === path),
    control: async (path) => {
      const res = await globalThis.fetch(server().url + path, { method: "POST" });
      assert.equal(res.status, 200);
    },
    rig: () => {
      const m = server();
      const clock = new FakeClock();
      const log = new Logger(clock);
      const flags = new FlagStore(new KvStore(new MemoryStorage()), { ...DEFAULT_FLAGS, apiBase: m.url, apiFallbackBase: m.url });
      const t = new SpyTransport({ fetch, clock, log, metrics: new Metrics(), flags, limiter: new Limiter(clock), breaker: new Breaker(clock) });
      const tokens = new TestTokens();
      tokens.pair = m.issueToken();
      const api = new KpApi(t, tokens);
      tokens.api = api;
      return { api, t, tokens, clock, log, flags, run: (p) => clock.runUntilSettled(p) };
    },
  };
}
