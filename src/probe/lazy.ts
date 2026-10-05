import type { AppContext } from "../app/context.ts";
import { KpError } from "../core/errors.ts";
import type * as ProbeEntry from "./entry.ts";
import { coldOnReady, persistOnReady, watchBlocks } from "./store.ts";

// Пробник в app.js (этап 23b): замеры каждого запуска (CDG-09, CDG-10) и загрузка probe.js по первому маршруту
// пробника. Остальной код пробника — в probe.js (src/probe/entry.ts); app.js импортирует его только как тип.

export type ProbeModule = typeof ProbeEntry;
/** Загрузка probe.js: в браузере — `<script>` (src/main.ts), в тестах — модуль `entry.ts`. */
export type ProbeLoad = () => Promise<ProbeModule>;

/** Дольше MSX показывала бы загрузку без ответа: экран ошибки с «Повторить» лучше (спец. §12). */
export const PROBE_LOAD_TIMEOUT_MS = 15_000;

const TAG = "probe";

const notConfigured: ProbeLoad = () => Promise.reject(new Error("probe.js loader is not configured"));

class LazyProbe {
  private ctx: AppContext;
  private load: ProbeLoad;
  private mod: ProbeModule | undefined;
  private pending: Promise<ProbeModule> | undefined;

  constructor(ctx: AppContext, load: ProbeLoad) {
    this.ctx = ctx;
    this.load = load;
  }

  loaded(): ProbeModule | undefined {
    return this.mod;
  }

  get(): Promise<ProbeModule> {
    if (this.mod !== undefined) return Promise.resolve(this.mod);
    this.pending ??= this.start();
    return this.pending;
  }

  private async start(): Promise<ProbeModule> {
    const { ctx } = this;
    const t0 = ctx.clock.perf();
    try {
      const mod = await this.timed();
      mod.install(ctx);
      this.mod = mod;
      const ms = Math.round(ctx.clock.perf() - t0);
      ctx.metrics.record("probe:load", ms);
      ctx.log.info(TAG, "probe.js loaded", { ms });
      return mod;
    } catch (e) {
      this.pending = undefined;
      const msg = e instanceof Error ? e.message : String(e);
      ctx.log.warn(TAG, "probe_load_failed", { msg });
      throw new KpError("KP-NET", "probe.js not loaded", undefined, msg);
    }
  }

  /** Поздно пришедший модуль после таймаута не ставится: следующий запрос загрузит заново. */
  private timed(): Promise<ProbeModule> {
    const { clock } = this.ctx;
    return new Promise((resolve, reject) => {
      const timer = clock.setTimeout(() => reject(new Error(`timeout ${PROBE_LOAD_TIMEOUT_MS} ms`)), PROBE_LOAD_TIMEOUT_MS);
      let started: Promise<ProbeModule>;
      try {
        started = this.load();
      } catch (e) {
        started = Promise.reject(e);
      }
      started.then(resolve, reject).finally(() => clock.clearTimeout(timer));
    });
  }
}

const probes = new WeakMap<AppContext, LazyProbe>();

/** Из `createApp`: загрузчик probe.js и подписка CDG-09 на вытеснение блоков L2 — с первого запуска, без probe.js. */
export function attachProbe(ctx: AppContext, load: ProbeLoad = notConfigured): void {
  probes.set(ctx, new LazyProbe(ctx, load));
  watchBlocks(ctx);
}

/** Из `App.ready()` при каждой загрузке плагина: холодный старт (CDG-10) и маркер хранилища (CDG-09). */
export function probeOnReady(ctx: AppContext): void {
  coldOnReady(ctx);
  persistOnReady(ctx);
}

/**
 * Модуль пробника; первая загрузка ставит `ctx.probe` и проверки уровня ТВ. Параллельные вызовы ждут одну загрузку;
 * отказ или таймаут — `KpError("KP-NET")`, а следующий вызов загружает заново.
 */
export function probeModule(ctx: AppContext): Promise<ProbeModule> {
  const p = probes.get(ctx);
  return p === undefined ? Promise.reject(new KpError("KP-BAD", "probe is not attached")) : p.get();
}

/**
 * `fn` с модулем пробника: сразу, если probe.js уже загружен, — сообщения и события доходят до пробника в том же
 * порядке, что без ленивой загрузки (CDG-12 считает сообщения после `act:probe:grid`); иначе после загрузки.
 */
export function withProbe<T>(ctx: AppContext, fn: (m: ProbeModule) => T): T | Promise<T> {
  const mod = probes.get(ctx)?.loaded();
  return mod !== undefined ? fn(mod) : probeModule(ctx).then(fn);
}
