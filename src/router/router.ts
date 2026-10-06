import { persistState } from "../app/context.ts";
import type { AppContext, MsxInfo } from "../app/context.ts";
import { Ring } from "../app/debug.ts";
import type { PluginApp } from "../bridge/host.ts";
import { onFocus } from "../cache/prefetch.ts";
import { KpError, toKpError } from "../core/errors.ts";
import { resolvePlay } from "../playback/resolve.ts";
import { probeOnReady, withProbe } from "../probe/lazy.ts";
import { bookmarksScreen } from "../screens/bookmarks.ts";
import { errorScreen, errorText } from "../screens/error.ts";
import { homeScreen, warmHome } from "../screens/home.ts";
import { itemScreen, onItemAct } from "../screens/item.ts";
import { listScreen, onExtend } from "../screens/list.ts";
import { loginScreen, onLoginAct } from "../screens/login.ts";
import { buildMenu } from "../screens/menu.ts";
import { onPanelAct, panelScreen } from "../screens/panels.ts";
import { onSearchInput, searchScreen } from "../screens/search.ts";
import { seasonScreen } from "../screens/season.ts";
import { onSettingsAct, settingsScreen } from "../screens/settings.ts";
import { parseDataId, parseMessage } from "./ids.ts";
import type { Msg, Route } from "./ids.ts";

const TAG = "router";
const RING = 200;

/** Обработчик маршрута; таблица ниже — единственное место связи `dataId` с экранами (план §0.6.8, этап 16). */
export type RouteTable = { [K in Route["k"]]: (ctx: AppContext, r: Extract<Route, { k: K }>) => unknown };

const ROUTES: RouteTable = {
  init: (ctx) => buildMenu(ctx),
  login: (ctx) => loginScreen(ctx),
  home: (ctx) => homeScreen(ctx),
  list: (ctx, r) => listScreen(ctx, r.key),
  search: (ctx) => searchScreen(ctx),
  item: (ctx, r) => itemScreen(ctx, r.id),
  season: (ctx, r) => seasonScreen(ctx, r.id, r.n),
  panel: (ctx, r) => panelScreen(ctx, r.type, r.args),
  settings: (ctx) => settingsScreen(ctx),
  bookmarks: (ctx) => bookmarksScreen(ctx),
  // Пробник — в probe.js: ответ после его загрузки, отказ загрузки — экран ошибки KP-NET (этап 23b).
  probe: (ctx, r) => withProbe(ctx, (m) => m.probeScreen(ctx, r.page)),
  dev: (ctx) => withProbe(ctx, (m) => m.devScreen(ctx)),
  play: (ctx, r) => resolvePlay(ctx, r),
  playEp: (ctx, r) => resolvePlay(ctx, r),
  probePlay: (ctx, r) => withProbe(ctx, (m) => m.probeResolve(ctx, r)),
  unknown: (ctx) => errorScreen(ctx, new KpError("KP-BAD", "unknown route")),
};

/** Без входа доступны только эти маршруты (и `unknown` — он сразу экран ошибки). */
const PUBLIC = new Set<Route["k"]>(["init", "login", "probe", "dev", "unknown"]);
/** Ответ для `video:resolve:…`: ошибка — `{ error }`, а не экран. */
const RESOLVE = new Set<Route["k"]>(["play", "playEp", "probePlay"]);

const isObj = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** Только платформа, версия MSX, плеер и модель ТВ из `requestData("info")`; IP и ID устройства не берутся (§13). */
export function msxInfoFrom(d: unknown): MsxInfo | undefined {
  const i = isObj(d) && isObj(d.info) ? d.info : d;
  if (!isObj(i)) return undefined;
  const out: MsxInfo = {};
  const platform = str(i.platform);
  const version = isObj(i.application) ? str(i.application.version) : undefined;
  const player = str(i.player);
  const model = isObj(i.system) ? str(i.system.modelName) ?? str(i.system.model) : undefined;
  if (platform !== undefined) out.platform = platform;
  if (version !== undefined) out.version = version;
  if (player !== undefined) out.player = player;
  if (model !== undefined) out.model = model;
  return out;
}

/**
 * Маршрутизатор плагина (спец. §3.5, §6): `dataId` → экран или ответ resolve, сообщения → обработчики модулей,
 * события плеера → трекер. Исключение экрана — экран ошибки, исключение resolve — `{ error }`.
 */
export class App implements PluginApp {
  /** Последние 200 dataId, действий и сообщений — для `__kp.stats()` (app/debug.ts). */
  readonly requests = new Ring<string>(RING);
  readonly actions = new Ring<string>(RING);
  readonly messages = new Ring<string>(RING);

  private ctx: AppContext;
  private routes: RouteTable;

  /** `routes` — подмена обработчиков только для тестов маршрутизатора. */
  constructor(ctx: AppContext, routes?: Partial<RouteTable>) {
    this.ctx = ctx;
    this.routes = { ...ROUTES, ...routes };
  }

  ready(): void {
    const { ctx } = this;
    ctx.state.readyCount += 1;
    ctx.state.readyAt = ctx.clock.perf();
    // Спец. §6.1: в ready ничего тяжёлого и ничего не ждём — всё в фоне.
    this.spawn("info", () => this.loadInfo());
    if (ctx.auth.isLoggedIn()) {
      this.spawn("auth", () => ctx.auth.onReady());
      this.spawn("outbox", async () => {
        ctx.outbox.start();
        try {
          await ctx.outbox.flush();
        } finally {
          // В фоновой полосе лимитера один слот (спец. §8.5): прогрев главной встаёт в очередь после отметок outbox.
          warmHome(ctx);
        }
      });
    }
    this.spawn("probe", () => probeOnReady(ctx));
  }

  async handleRequest(dataId: string, _data: unknown): Promise<unknown> {
    const { ctx } = this;
    const t0 = ctx.clock.perf();
    this.requests.push(dataId);
    if (dataId === "init") ctx.state.initCount += 1;
    ctx.current.onRequest(dataId);
    const r = parseDataId(dataId);
    const resolve = RESOLVE.has(r.k);
    let out: unknown;
    try {
      if (!PUBLIC.has(r.k) && !ctx.auth.isLoggedIn()) {
        out = await this.loginInstead(r, resolve);
      } else {
        const handler = this.routes[r.k] as (ctx: AppContext, r: Route) => unknown;
        out = await handler(ctx, r);
      }
    } catch (e) {
      const err = toKpError(e);
      ctx.log.warn(TAG, "request_failed", { route: r.k, err: err.code, status: err.status, msg: err.message });
      out = resolve ? { error: errorText(e).text } : errorScreen(ctx, e, dataId);
    }
    ctx.metrics.record(`screen:${r.k}`, ctx.clock.perf() - t0);
    if (r.k === "init") ctx.state.initAnsweredAt = ctx.clock.perf();
    return out;
  }

  handleData(d: any): void {
    try {
      this.data(d);
    } catch (e) {
      this.failed("data", e);
    }
  }

  handleEvent(e: any): void {
    const { ctx } = this;
    const name = isObj(e) && typeof e.event === "string" ? e.event : "";
    try {
      if (name.startsWith("video:")) {
        ctx.tracker.onEvent(e);
        return;
      }
      ctx.log.info(TAG, "event", { event: name });
      if (name === "app:suspend") persistState(ctx, true);
    } catch (err) {
      this.failed(`event ${name}`, err);
    }
  }

  // --- Внутреннее ---

  /**
   * Без токенов: контент — экран входа, и текущим считается `login`, чтобы вход по коду обновил его (этап 17
   * перерисовывает только текущий `login`); resolve — `{ error }` с текстом KP-AUTH.
   */
  private async loginInstead(r: Route, resolve: boolean): Promise<unknown> {
    const { ctx } = this;
    ctx.log.info(TAG, "login required", { route: r.k });
    if (resolve) return { error: errorText(new KpError("KP-AUTH", "login required")).text };
    if (r.k !== "panel") ctx.current.onRequest("login");
    return loginScreen(ctx);
  }

  private data(d: any): void {
    if (!isObj(d)) return;
    if (typeof d.message === "string") {
      this.messages.push(d.message);
      this.message(d.message);
      return;
    }
    if (isObj(d.video) || (isObj(d.data) && isObj(d.data.video))) {
      this.messages.push("video");
      this.ctx.tracker.onSnapshot(d);
      return;
    }
    this.ctx.log.debug(TAG, "data_ignored");
  }

  private message(raw: string): void {
    const { ctx } = this;
    const m = parseMessage(raw);
    ctx.metrics.inc(`msg:${m.k}`);
    switch (m.k) {
      case "extend":
        if (m.key === "search") this.spawn("search", () => onSearchInput(ctx, m));
        else this.spawn("extend", () => onExtend(ctx, m.key));
        return;
      case "searchInput":
      case "searchControl":
        this.spawn("search", () => onSearchInput(ctx, m));
        return;
      case "pf":
        this.spawn("pf", () => onFocus(ctx, m.id));
        return;
      case "act":
        this.act(m);
        return;
      case "unknown":
        // Нераскрытый {context:kid} в pf — признак для CDG-12 (этап 23).
        if (raw.startsWith("pf:")) ctx.metrics.inc("msg:pf_raw");
        ctx.log.debug(TAG, "unknown_message", { msg: raw.slice(0, 80) });
        return;
    }
  }

  private act(m: Extract<Msg, { k: "act" }>): void {
    const { ctx } = this;
    const { module, name, args } = m;
    ctx.log.info(TAG, `act ${module} ${name}`, { args });
    const what = `act ${module} ${name}`;
    switch (module) {
      case "login":
        this.spawn(what, () => onLoginAct(ctx, name, args));
        return;
      case "item":
        this.spawn(what, () => onItemAct(ctx, name, args));
        return;
      case "panel":
        this.spawn(what, () => onPanelAct(ctx, name, args));
        return;
      case "set":
        this.spawn(what, () => onSettingsAct(ctx, name, args));
        return;
      case "probe":
        this.spawn(what, () => withProbe(ctx, (m) => m.onProbeAct(ctx, name, args)));
        return;
    }
  }

  private async loadInfo(): Promise<void> {
    const info = msxInfoFrom(await this.ctx.host.requestData("info"));
    if (info !== undefined) this.ctx.state.msxInfo = info;
  }

  /** Запустить без ожидания: и синхронное исключение, и отказ промиса уходят в журнал. */
  private spawn(what: string, fn: () => unknown): void {
    try {
      Promise.resolve(fn()).catch((e: unknown) => this.failed(what, e));
    } catch (e) {
      this.failed(what, e);
    }
  }

  private failed(what: string, e: unknown): void {
    const err = toKpError(e);
    this.ctx.log.error(TAG, "handler_failed", { what, err: err.code, msg: err.message });
  }
}
