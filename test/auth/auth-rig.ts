import { Breaker } from "../../src/api/breaker.ts";
import { KpApi } from "../../src/api/client.ts";
import { Limiter } from "../../src/api/limiter.ts";
import { Transport } from "../../src/api/transport.ts";
import { AuthService } from "../../src/auth/auth-service.ts";
import { TokenStore } from "../../src/auth/tokens.ts";
import { KvStore } from "../../src/bridge/storage.ts";
import { DEFAULT_FLAGS, FlagStore } from "../../src/config/flags.ts";
import { Logger } from "../../src/core/log.ts";
import { Metrics } from "../../src/core/metrics.ts";
import { useKpApiMock } from "../api/kpapi-rig.ts";
import type { KpApiEnv } from "../api/kpapi-rig.ts";
import { FakeClock } from "../helpers/fake-clock.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";

// Обвязка тестов авторизации: kpmock (хуки и проверки useKpApiMock этапа 13), эмулятор CORS, FakeClock,
// MemoryStorage и настоящая связка Transport → KpApi ⇄ AuthService, как в createApp.

export const VERSION = "1.2.3";

export interface AuthRig {
  mem: MemoryStorage; store: KvStore; tokens: TokenStore; auth: AuthService; api: KpApi;
  clock: FakeClock; log: Logger; loggedOut: string[];
  run<T>(p: Promise<T>): Promise<T>;
}

export interface AuthEnv extends KpApiEnv {
  /** `login: true` — пара от `mock.issueToken()` уже сохранена (устройство «kpmock TV» в mock). */
  authRig(opts?: { login?: boolean; version?: string }): AuthRig;
  /** Ключи `kp.auth.*` в хранилище стенда. */
  authKeys(r: AuthRig): string[];
}

export function useAuthMock(): AuthEnv {
  const env = useKpApiMock();
  return {
    ...env,
    authKeys: (r) => r.store.keys("auth"),
    authRig: (opts) => {
      const m = env.mock();
      const clock = new FakeClock();
      const log = new Logger(clock);
      const mem = new MemoryStorage();
      const store = new KvStore(mem, log);
      const flags = new FlagStore(new KvStore(new MemoryStorage()), { ...DEFAULT_FLAGS, apiBase: m.url, apiFallbackBase: m.url });
      const t = new Transport({ fetch: env.cors, clock, log, metrics: new Metrics(), flags, limiter: new Limiter(clock), breaker: new Breaker(clock) });
      const tokens = new TokenStore(store, clock);
      const auth = new AuthService({ tokens, clock, log, version: opts?.version ?? VERSION });
      const api = new KpApi(t, auth);
      auth.bindApi(api);
      const loggedOut: string[] = [];
      auth.onLoggedOut = (reason) => loggedOut.push(reason);
      if (opts?.login) tokens.save({ ...m.issueToken(), expiresIn: 3600 });
      return { mem, store, tokens, auth, api, clock, log, loggedOut, run: (p) => clock.runUntilSettled(p) };
    },
  };
}
