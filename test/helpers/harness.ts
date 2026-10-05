import type { FetchLike } from "../../src/api/transport.ts";
import type { AppContext } from "../../src/app/context.ts";
import { createApp } from "../../src/app/create-app.ts";
import { TokenStore } from "../../src/auth/tokens.ts";
import { KvStore } from "../../src/bridge/storage.ts";
import type { Flags } from "../../src/config/flags.ts";
import * as probeEntry from "../../src/probe/entry.ts";
import { probeModule } from "../../src/probe/lazy.ts";
import type { ProbeLoad } from "../../src/probe/lazy.ts";
import { App } from "../../src/router/router.ts";
import type { RouteTable } from "../../src/router/router.ts";
import { startMock } from "../../tools/kpmock/server.ts";
import type { MockServer } from "../../tools/kpmock/server.ts";
import { createCorsFetch } from "./cors-fetch.ts";
import { FakeClock } from "./fake-clock.ts";
import { FakeHost } from "./fake-host.ts";
import { MemoryStorage } from "./memory-storage.ts";

/** Адрес плагина в тестах: `ctx.P`, origin для эмулятора CORS и `@P` во всех действиях. */
export const TEST_P = "https://example.github.io/msx/app/index.html";

export interface TestApp {
  app: App; ctx: AppContext; host: FakeHost; clock: FakeClock; storage: MemoryStorage; mock: MockServer;
  fetch: FetchLike & { preflights: number };
  /** Остановить mock, если его поднял сам `createTestApp`; чужой mock не трогается. */
  close(): Promise<void>;
  /** `clock.runUntilSettled(p)`: таймеры FakeClock идут, пока `p` не завершится. */
  run<T>(p: Promise<T>): Promise<T>;
  /** `app.handleRequest(dataId, {})` до завершения (через `run`). */
  request(dataId: string): Promise<any>;
}

export interface TestAppOptions {
  mock?: MockServer; storage?: MemoryStorage; clock?: FakeClock; loggedIn?: boolean; flags?: Partial<Flags>; P?: string;
  /** Подмена обработчиков маршрутов (`App`) — только для тестов маршрутизатора. */
  routes?: Partial<RouteTable>;
  /**
   * Пробник (probe.js, этап 23b): `eager` (по умолчанию) — загружен до возврата стенда, `ctx.probe` готов сразу;
   * `lazy` — грузится по первому маршруту пробника, как в браузере; функция — свой загрузчик (сбой, задержка).
   */
  probe?: "eager" | "lazy" | ProbeLoad;
}

/**
 * Всё приложение как в браузере, но с FakeHost, FakeClock, MemoryStorage и kpmock (порт 0) за эмулятором CORS.
 * `build.apiBase` и `apiFallbackBase` — адрес mock. `loggedIn: true` — пара от `mock.issueToken()` уже в
 * `kp.auth.pair` (gen 1 на чистом хранилище, срок 1 ч), как после входа по коду.
 */
export async function createTestApp(o: TestAppOptions = {}): Promise<TestApp> {
  const own = o.mock === undefined;
  const mock = o.mock ?? (await startMock({ port: 0 }));
  const clock = o.clock ?? new FakeClock();
  const storage = o.storage ?? new MemoryStorage();
  const P = o.P ?? TEST_P;
  const fetch = createCorsFetch({ origin: new URL(P).origin });
  if (o.loggedIn === true) new TokenStore(new KvStore(storage), clock).save({ ...mock.issueToken(), expiresIn: 3600 });
  const host = new FakeHost();
  const loadProbe: ProbeLoad = typeof o.probe === "function" ? o.probe : () => Promise.resolve(probeEntry);
  let { app, ctx } = createApp({ host, storage, fetch, P, clock, build: { apiBase: mock.url, apiFallbackBase: mock.url }, loadProbe });
  if (o.routes !== undefined) app = new App(ctx, o.routes);
  if (o.probe === undefined || o.probe === "eager") {
    try {
      await probeModule(ctx);
    } catch (e) {
      if (own) await mock.close();
      throw e;
    }
  }
  for (const [k, v] of Object.entries(o.flags ?? {})) ctx.flags.set(k as keyof Flags, v as never);
  const run = <T>(p: Promise<T>): Promise<T> => clock.runUntilSettled(p);
  return {
    app, ctx, host, clock, storage, mock, fetch, run,
    request: (dataId) => run(app.handleRequest(dataId, {})),
    close: async () => {
      if (own) await mock.close();
    },
  };
}
