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
const noop = (): void => undefined;

class LazyProbe {
  private ctx: AppContext;
  private load: ProbeLoad;
  private mod: ProbeModule | undefined;
  /** Ожидание модуля со сроком: параллельные вызовы ждут одно. */
  private pending: Promise<ProbeModule> | undefined;
  /**
   * Вызов загрузчика (`<script>` probe.js) в полёте. Переживает срок ожидания: повтор ждёт его же, а не вставляет
   * второй `<script>`, который гонялся бы с опоздавшим первым за `globalThis.kpProbe`.
   */
  private loading: Promise<ProbeModule> | undefined;

  constructor(ctx: AppContext, load: ProbeLoad) {
    this.ctx = ctx;
    this.load = load;
  }

  loaded(): ProbeModule | undefined {
    return this.mod;
  }

  get(): Promise<ProbeModule> {
    if (this.mod !== undefined) return Promise.resolve(this.mod);
    this.pending ??= this.wait();
    return this.pending;
  }

  private async wait(): Promise<ProbeModule> {
    try {
      return await this.timed(this.loading ??= this.fetch());
    } catch (e) {
      this.pending = undefined;
      const msg = e instanceof Error ? e.message : String(e);
      this.ctx.log.warn(TAG, "probe_load_failed", { msg });
      throw new KpError("KP-NET", "probe.js not loaded", undefined, msg);
    }
  }

  /**
   * Один вызов загрузчика; версию probe.js сверяет он (src/main.ts). Модуль ставится, даже если пришёл после срока
   * ожидания; отказ освобождает место следующей загрузке.
   */
  private fetch(): Promise<ProbeModule> {
    const t0 = this.ctx.clock.perf();
    let started: Promise<ProbeModule>;
    try {
      started = this.load();
    } catch (e) {
      started = Promise.reject(e);
    }
    const p = started.then((mod) => this.accept(mod, t0)).finally(() => {
      this.loading = undefined;
    });
    // Отказ после срока ожидания уже никто не ждёт.
    p.catch(noop);
    return p;
  }

  /** Одна регистрация: `install` — только для первого модуля. */
  private accept(mod: ProbeModule, t0: number): ProbeModule {
    if (this.mod !== undefined) return this.mod;
    const { ctx } = this;
    mod.install(ctx);
    this.mod = mod;
    const ms = Math.round(ctx.clock.perf() - t0);
    ctx.metrics.record("probe:load", ms);
    ctx.log.info(TAG, "probe.js loaded", { ms });
    return mod;
  }

  private timed(p: Promise<ProbeModule>): Promise<ProbeModule> {
    const { clock } = this.ctx;
    return new Promise((resolve, reject) => {
      const timer = clock.setTimeout(() => reject(new Error(`timeout ${PROBE_LOAD_TIMEOUT_MS} ms`)), PROBE_LOAD_TIMEOUT_MS);
      p.then(resolve, reject).finally(() => clock.clearTimeout(timer));
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
 * отказ или таймаут — `KpError("KP-NET")`. Следующий вызов ждёт ту же загрузку, если она ещё идёт, иначе загружает
 * заново.
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
