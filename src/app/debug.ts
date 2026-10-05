import type { MsxHost } from "../bridge/host.ts";
import type { App } from "../router/router.ts";
import type { AppContext } from "./context.ts";

/** Кольцо последних значений (для отладочной статистики e2e). */
export class Ring<T = string> {
  private buf: T[] = [];
  private cap: number;

  constructor(cap: number) {
    this.cap = Math.max(1, cap);
  }

  push(v: T): void {
    this.buf.push(v);
    if (this.buf.length > this.cap) this.buf.shift();
  }

  items(): T[] {
    return this.buf.slice();
  }
}

/** Хост, который записывает каждое выполненное действие в `ring` и передаёт его дальше. */
export function recordingHost(host: MsxHost, ring: Ring<string>): MsxHost {
  return {
    executeAction(action: string, data?: unknown): void {
      ring.push(action);
      host.executeAction(action, data);
    },
    requestData(dataId: string): Promise<any> {
      return host.requestData(dataId);
    },
  };
}

export interface DebugStats {
  bootId: string; readyCount: number; initCount: number; readyAt: number | undefined; initAnsweredAt: number | undefined;
  requests: string[]; actions: string[]; messages: string[];
}

export function debugStats(ctx: AppContext, app: App): DebugStats {
  const s = ctx.state;
  return {
    bootId: s.bootId, readyCount: s.readyCount, initCount: s.initCount, readyAt: s.readyAt, initAnsweredAt: s.initAnsweredAt,
    requests: app.requests.items(), actions: app.actions.items(), messages: app.messages.items(),
  };
}

/**
 * Только в dev/e2e-сборке (`DEBUG_HOOKS=1`): `globalThis.__kp = { ctx, app, stats() }`, а `ctx.host` заменяется
 * записывающим прокси (сервисы берут `ctx.host` при каждом вызове, поэтому подмена видна всем).
 */
export function installDebugHooks(ctx: AppContext, app: App): void {
  if (!ctx.build.debugHooks) return;
  ctx.host = recordingHost(ctx.host, app.actions);
  (globalThis as Record<string, unknown>).__kp = { ctx, app, stats: (): DebugStats => debugStats(ctx, app) };
}
