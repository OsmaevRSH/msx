import type { KpApi } from "../api/client.ts";
import type { ItemSummary } from "../api/models.ts";
import type { FetchLike, Transport } from "../api/transport.ts";
import type { AuthService } from "../auth/auth-service.ts";
import type { DeviceFlow } from "../auth/device-flow.ts";
import type { CurrentScreen } from "../bridge/current.ts";
import type { MsxHost } from "../bridge/host.ts";
import type { KvStore } from "../bridge/storage.ts";
import type { L2 } from "../cache/l2.ts";
import type { Repo } from "../cache/repo.ts";
import type { SwrCache } from "../cache/swr.ts";
import type { BuildInfo } from "../config/build.ts";
import type { FlagStore } from "../config/flags.ts";
import type { Clock, TimerId } from "../core/clock.ts";
import type { KpErrorCode } from "../core/errors.ts";
import type { Logger } from "../core/log.ts";
import type { Metrics } from "../core/metrics.ts";
import type { FallbackChain } from "../playback/modes.ts";
import type { PrefsStore } from "../playback/prefs.ts";
import type { ProbeRunner } from "../probe/runner.ts";
import type { HeartbeatTimer } from "../progress/heartbeat.ts";
import type { Outbox } from "../progress/outbox.ts";
import type { Overlay } from "../progress/overlay.ts";
import type { ProgressTracker } from "../progress/tracker.ts";

/** Список в памяти (L1 экрана): догрузка `extend` дописывает сюда, возврат к списку отвечает отсюда без сети. */
export interface ListState { key: string; items: ItemSummary[]; page: number; totalPages: number; done: boolean; loading?: Promise<void> }

export interface SearchState {
  query: string; lang: "ru" | "en"; items: ItemSummary[]; page: number; totalPages: number;
  done: boolean; seq: number; timer?: TimerId;
  status: "idle" | "short" | "loading" | "ready" | "empty" | "error"; error?: KpErrorCode;
}

/** Сведения MSX о ТВ из `requestData("info")` в `ready`; без IP и идентификаторов устройства. */
export interface MsxInfo { platform?: string; version?: string; player?: string; model?: string }

export interface AppState {
  lists: Map<string, ListState>;
  search: SearchState;
  login?: DeviceFlow;
  /** 8 hex на каждую загрузку iframe: смена значит, что MSX перезагрузила плагин (CE-05). */
  bootId: string;
  startedAt: number;
  readyAt?: number;
  readyCount: number;
  initAnsweredAt?: number;
  initCount: number;
  /** mid → `clock.perf()` последнего resolve (TTFF). */
  resolveAt: Map<number, number>;
  msxInfo?: MsxInfo;
}

export interface AppContext {
  P: string; build: BuildInfo; clock: Clock; log: Logger; metrics: Metrics; store: KvStore; flags: FlagStore; prefs: PrefsStore;
  fetch: FetchLike; transport: Transport; api: KpApi; auth: AuthService; cache: SwrCache; repo: Repo; overlay: Overlay;
  host: MsxHost; current: CurrentScreen; state: AppState;
  tracker: ProgressTracker; outbox: Outbox; heartbeat: HeartbeatTimer; chain: FallbackChain; probe: ProbeRunner;
  /** L2 (`kp.l2.*`): всё в этом пространстве пишется только через него — чужие записи `L2` удаляет при загрузке индекса. */
  l2: L2;
}

/** Ключ журнала в L2 (`kp.l2.log`) и оверлея прогресса в outbox-пространстве (`kp.out.overlay`), спец. §13, §10.2. */
export const LOG_L2_KEY = "log";
export const OVERLAY_KEY = "overlay";
export const LOG_PERSIST_ENTRIES = 100;

/**
 * Сбросить журнал (последние 100 записей) и оверлей прогресса в хранилище. `flush` — записать L2 сразу
 * (`app:suspend`: ТВ может выгрузить страницу), иначе — обычной отложенной пачкой L2.
 */
export function persistState(ctx: AppContext, flush: boolean): void {
  ctx.l2.put(LOG_L2_KEY, ctx.log.tail(LOG_PERSIST_ENTRIES));
  ctx.store.set("out", OVERLAY_KEY, ctx.overlay.serialize());
  if (flush) ctx.l2.flush();
}
