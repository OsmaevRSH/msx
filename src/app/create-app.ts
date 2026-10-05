import { Breaker } from "../api/breaker.ts";
import { KpApi } from "../api/client.ts";
import { Limiter } from "../api/limiter.ts";
import { Transport } from "../api/transport.ts";
import type { FetchLike } from "../api/transport.ts";
import { AuthService } from "../auth/auth-service.ts";
import { TokenStore } from "../auth/tokens.ts";
import { CurrentScreen } from "../bridge/current.ts";
import type { MsxHost } from "../bridge/host.ts";
import { KvStore } from "../bridge/storage.ts";
import type { StorageLike } from "../bridge/storage.ts";
import { L2 } from "../cache/l2.ts";
import { Lru } from "../cache/lru.ts";
import { Repo } from "../cache/repo.ts";
import { SwrCache } from "../cache/swr.ts";
import { BUILD } from "../config/build.ts";
import type { BuildInfo } from "../config/build.ts";
import { DEFAULT_FLAGS, FlagStore } from "../config/flags.ts";
import type { Flags } from "../config/flags.ts";
import { systemClock } from "../core/clock.ts";
import type { Clock } from "../core/clock.ts";
import { Logger } from "../core/log.ts";
import { Metrics } from "../core/metrics.ts";
import { FallbackChain } from "../playback/modes.ts";
import { PrefsStore } from "../playback/prefs.ts";
import { onTrackerEvent } from "../playback/resolve.ts";
import { ProbeRunner } from "../probe/runner.ts";
import { installTvChecks } from "../probe/tv-checks.ts";
import { HeartbeatTimer } from "../progress/heartbeat.ts";
import { Outbox } from "../progress/outbox.ts";
import { Overlay } from "../progress/overlay.ts";
import { ProgressTracker } from "../progress/tracker.ts";
import { App } from "../router/router.ts";
import { OVERLAY_KEY, persistState } from "./context.ts";
import type { AppContext, AppState } from "./context.ts";

export interface CreateAppOptions {
  host: MsxHost; storage: StorageLike; fetch: FetchLike; P: string;
  clock?: Clock; build?: Partial<BuildInfo>; startedAt?: number;
}

/** Спец. §13: журнал и оверлей сбрасываются в хранилище раз в 30 с (и сразу на `app:suspend`). */
export const PERSIST_EVERY_MS = 30_000;

/** Переключатели по умолчанию с адресами API этой сборки (их же разрешает CSP, решение Р-14). */
export function defaultsFrom(build: BuildInfo): Flags {
  return { ...DEFAULT_FLAGS, apiBase: build.apiBase, apiFallbackBase: build.apiFallbackBase };
}

/** 8 hex из Math.random: признак новой загрузки iframe (CE-05). */
function newBootId(): string {
  return Math.floor(Math.random() * 0x1_0000_0000).toString(16).padStart(8, "0");
}

function initialState(startedAt: number): AppState {
  return {
    lists: new Map(),
    search: { query: "", lang: "ru", items: [], page: 0, totalPages: 0, done: false, seq: 0, status: "idle" },
    bootId: newBootId(),
    startedAt,
    readyCount: 0,
    initCount: 0,
    resolveAt: new Map(),
  };
}

/**
 * Сборка приложения (план §0.6.8, этап 16). Ничего не делает в сети: `init` должен ответить меню сразу (CNFR-03);
 * фоновые дела начинаются в `App.ready()`.
 */
export function createApp(o: CreateAppOptions): { app: App; ctx: AppContext } {
  const build: BuildInfo = { ...BUILD, ...o.build };
  const clock = o.clock ?? systemClock;
  const log = new Logger(clock);
  const metrics = new Metrics();
  const store = new KvStore(o.storage, log);
  const flags = new FlagStore(store, defaultsFrom(build));
  const prefs = new PrefsStore(store);
  const limiter = new Limiter(clock);
  const breaker = new Breaker(clock);
  const transport = new Transport({ fetch: o.fetch, clock, log, metrics, flags, limiter, breaker });
  const tokens = new TokenStore(store, clock);
  const auth = new AuthService({ tokens, clock, log, version: build.version });
  const api = new KpApi(transport, auth);
  auth.bindApi(api);
  const l2 = new L2(store, clock, undefined, log);
  const cache = new SwrCache({ l1: new Lru(), l2, clock, log });
  const repo = new Repo({ api, cache, clock, log });
  const overlay = new Overlay(clock);
  const saved = store.get<unknown>("out", OVERLAY_KEY);
  if (typeof saved === "string") overlay.load(saved);
  const current = new CurrentScreen();
  const state = initialState(o.startedAt ?? clock.perf());

  // Сервисы верхнего уровня получают ctx и читают его поля лениво, поэтому создаются после остальных полей.
  const ctx = {
    P: o.P, build, clock, log, metrics, store, flags, prefs, fetch: o.fetch, transport, api, auth, cache, repo, overlay,
    host: o.host, current, state, l2,
  } as AppContext;
  ctx.tracker = new ProgressTracker(ctx);
  ctx.outbox = new Outbox(ctx);
  ctx.heartbeat = new HeartbeatTimer(ctx);
  ctx.chain = new FallbackChain(ctx);
  ctx.probe = new ProbeRunner(ctx);

  auth.onLoggedOut = () => {
    // Прежний вход по коду завершён: следующий экран входа начнёт новый (этап 17).
    ctx.state.login?.stop();
    ctx.state.login = undefined;
    ctx.host.executeAction("reload:menu");
  };
  ctx.tracker.addListener((e) => onTrackerEvent(ctx, e));
  installTvChecks(ctx);

  const persistTick = (): void => {
    try {
      persistState(ctx, false);
    } catch (e) {
      log.error("app", "persist_failed", { msg: e instanceof Error ? e.message : String(e) });
    }
    clock.setTimeout(persistTick, PERSIST_EVERY_MS);
  };
  clock.setTimeout(persistTick, PERSIST_EVERY_MS);

  return { app: new App(ctx), ctx };
}
