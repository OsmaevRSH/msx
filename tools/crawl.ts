import { performance } from "node:perf_hooks";
import type { Flags } from "../src/config/flags.ts";
import { sleep } from "../src/core/clock.ts";
import type { LogEntry } from "../src/core/log.ts";
import { ids, isPanelId, parseDataId, parseMessage } from "../src/router/ids.ts";
import { createTestApp } from "../test/helpers/harness.ts";
import { FIX } from "./kpmock/fixtures.ts";
import type { TestApp } from "../test/helpers/harness.ts";
import {
  RESOLVE_KINDS, actionIssues, actionsOf, addressIssues, answerIssues, bytesOf, contextIssues, kindOf, menuActionIssues,
  placeholderIssues, sizeLimit, splitChain, startVariant,
} from "./crawl-rules.ts";

// Краулер графа действий (этап 32, спец. §14.1; Plan B §12.5). Весь плагин в процессе, как в тестах: kpmock на
// порту 0, FakeHost, FakeClock, вход парой `mock.issueToken()`. Обход в ширину от `init`: из каждого ответа и из
// каждого действия, которое плагин выполнил сам, берутся запросы к плагину и сообщения; каждый ответ и каждое
// действие проверяются правилами `crawl-rules.ts`. Видео — только «с начала» (Р-34): прогресс фикстур не меняется.

export interface CrawlFailure { dataId: string; rule: string; detail: string }
export interface CrawlReport {
  nodes: number; failures: CrawlFailure[]; maxBytes: Record<string, number>;
  /** Разных действий, прошедших проверку грамматики. */
  edges: number;
}
export interface CrawlOptions {
  maxNodes?: number; depth?: number; flags?: Partial<Flags>;
  /** Строка на каждый узел: глубина, вход и что обойдено (`npm run crawl -- --verbose`). */
  trace?: (line: string) => void;
}

const MAX_NODES = 600;
const MAX_DEPTH = 5;
/** Повторный запрос того же `dataId` отвечает из кэша (спец. §6.3, CNFR-04). */
const CACHE_MS = 50;
/** На время повторного запроса mock отвечает с такой задержкой: экран, который ждёт сеть, в `CACHE_MS` не уложится. */
const NET_DELAY_MS = 200;
/**
 * Реальное время повтора — только «не ждал сеть»: оно ниже `NET_DELAY_MS` с запасом. Бюджет `CACHE_MS` проверяет
 * поддельное время — реальные 50 мс на загруженном раннере CI превышаются и без сети (этап 35).
 */
const CACHE_REAL_MS = NET_DELAY_MS / 2;
/**
 * Сообщения плагин обрабатывает в фоне (`App.spawn`): поддельное время идёт шагами, пока mock получает запросы
 * (не меньше паузы ввода поиска 500 мс и ответа на неё, не больше 10 с — опрос входа идёт бесконечно).
 */
const SETTLE_STEP_MS = 500;
const SETTLE_MIN_MS = 1_000;
const SETTLE_MAX_MS = 10_000;
/** `reload:content` внутри перезапроса — не глубже: защита от экрана, который перерисовывает сам себя. */
const MAX_RELOADS = 2;
/** Ввод поиска: «е», «с», «т» в порядке клавиатуры дают «ест» — он есть в названиях mock («Тестовый …»). */
const SEARCH_KEYS = new Set(["е", "с", "т"]);
/** Выход из KinoPub завершает сессию обхода: такие сообщения — после всего остального. */
const LAST = new Set(["set:logout", "probe:logout"]);

/** Сколько узлов одного вида обходить: краулеру нужна каждая разметка и каждое действие, а не каждый тайтл. */
const CAPS: Record<string, number> = {
  item: 8, season: 8, play: 2, playEp: 3, probePlay: 6, extend: 3, searchInput: SEARCH_KEYS.size, pf: 2,
};
/**
 * Длинные сезоны SERIAL_LONG (100 и 200 серий, CNFR-16): их нет в каталоге mock, поэтому обход идёт к ним сразу от
 * `init`, а дальше — по переходам между частями сезона.
 */
const SEEDS = [ids.season(FIX.SERIAL_LONG, 1), ids.season(FIX.SERIAL_LONG, 2)];
const REQ_CAP = 3;
const MSG_CAP = 2;

type Node =
  | { k: "req"; id: string; depth: number; screen?: string }
  | { k: "msg"; msg: string; depth: number; screen?: string }
  /** Перезапрос открытого экрана по `reload:content` или замене с его флагом — сразу, как это делает MSX. */
  | { k: "reload"; id: string; depth: number };

/** Узел очереди; перезапросы в очередь не попадают. */
type Work = Exclude<Node, { k: "reload" }>;

const label = (n: Node): string => (n.k === "msg" ? `msg:${n.msg}` : n.k === "reload" ? `${n.id} (reload)` : n.id);

/** Ключ лимита: панели настроек и переключатели «Для разработчика» — каждая свои, догрузка — по спискам. */
function capKey(n: Node): string {
  if (n.k !== "msg") {
    const r = parseDataId(n.id);
    return r.k === "panel" && r.type === "setting" ? `panel:setting:${r.args[0] ?? ""}` : kindOf(n.id);
  }
  const m = parseMessage(n.msg);
  if (m.k === "act") return `act:${m.module}:${m.name}${m.module === "probe" && m.name === "flag" ? `:${m.args[0] ?? ""}` : ""}`;
  if (m.k === "searchControl") return `searchControl:${m.c}`;
  if (m.k === "extend") return `extend:${m.key.replace(/:(?:up|down):\d+$/, "")}`;
  return m.k;
}

const capOf = (n: Node, key: string): number => CAPS[key] ?? CAPS[key.split(":")[0] ?? ""] ?? (n.k === "msg" ? MSG_CAP : REQ_CAP);

const REQUEST = /^(?:lazy:)?(content:|panel:|video:resolve:|replace:(content|menu):([A-Za-z0-9_]+):)request:interaction:([^@]*)@/;

class Crawler {
  private t: TestApp;
  private o: CrawlOptions;
  private nodes = 0;
  private failures: CrawlFailure[] = [];
  private maxBytes: Record<string, number> = {};
  private queue: Work[] = [];
  private last: Work[] = [];
  private seen = new Set<string>();
  private taken = new Map<string, number>();
  private edges = new Set<string>();
  /** Флаг последнего ответа каждого экрана: замена `replace:content:<флаг>:…` должна его повторять. */
  private flags = new Map<string, string | undefined>();
  private errors: LogEntry[] = [];

  constructor(t: TestApp, o: CrawlOptions) {
    this.t = t;
    this.o = o;
    t.ctx.log.sink = (e) => {
      if (e.level === "error") this.errors.push(e);
    };
  }

  async run(): Promise<CrawlReport> {
    this.t.app.ready();
    this.push({ k: "req", id: ids.init(), depth: 0 });
    for (const id of SEEDS) this.push({ k: "req", id, depth: 1 });
    await this.drain();
    if (this.last.length > 0) {
      // После выхода — меню и экраны без входа; код входа не подтверждается, чтобы обход не вошёл снова.
      this.t.mock.setScenario({ pendingPolls: 1_000_000 });
      this.queue.push(...this.last.splice(0));
      await this.drain();
    }
    return { nodes: this.nodes, failures: this.failures, maxBytes: this.maxBytes, edges: this.edges.size };
  }

  private budget(): boolean {
    return this.nodes < (this.o.maxNodes ?? MAX_NODES);
  }

  private async drain(): Promise<void> {
    let prev: Node | undefined;
    for (let n = this.queue.shift(); n !== undefined && this.budget(); n = this.queue.shift()) {
      // Что плагин сделал в фоне после прошлого узла (догрузка, замена экрана после сверки), MSX тоже выполнил бы.
      if (prev !== undefined) await this.hostActions(prev, 0);
      const w: Work = n;
      await this.visit(w, () => (w.k === "msg" ? this.message(w) : this.request(w)));
      prev = w;
    }
  }

  private async visit(n: Node, body: () => Promise<void>): Promise<void> {
    this.nodes += 1;
    this.o.trace?.(`${n.depth} ${this.auth()} ${label(n)}`);
    await body();
    for (const e of this.errors.splice(0)) this.fail(label(n), "log", `${e.tag} ${e.msg} ${JSON.stringify(e.data ?? {})}`);
  }

  private fail(dataId: string, rule: string, detail: string): void {
    this.failures.push({ dataId, rule, detail });
  }

  // --- Узлы ---

  private async request(n: Extract<Node, { k: "req" }>): Promise<void> {
    await this.show(n.screen);
    await this.answer(n);
    if (!RESOLVE_KINDS.has(parseDataId(n.id).k)) await this.fromCache(n);
  }

  /** Запрос узла, проверка ответа, его действия в очередь; действия плагина за это время — тоже. */
  private async answer(n: Extract<Node, { k: "req" | "reload" }>, reloads = 0): Promise<void> {
    this.t.host.clearActions();
    const answer = await this.t.request(n.id);
    this.check(n, answer);
    for (const a of actionsOf(answer)) this.follow(a, n, false);
    if (parseDataId(n.id).k === "init") this.menuData(n, answer);
    await this.hostActions(n, reloads);
  }

  private async message(n: Extract<Node, { k: "msg" }>): Promise<void> {
    await this.show(n.screen);
    this.t.host.clearActions();
    const log = console.log;
    // «Отчёт в консоль» пишет отчёт в console.log — в выводе краулера он лишний.
    console.log = () => undefined;
    try {
      this.t.app.handleData({ message: n.msg });
      await this.settle();
    } catch (e) {
      this.fail(label(n), "exception", e instanceof Error ? e.message : String(e));
    } finally {
      console.log = log;
    }
    await this.hostActions(n, 0);
  }

  /** Поддельное время шагами, пока плагин ходит в mock. */
  private async settle(): Promise<void> {
    const { t } = this;
    let calls = t.mock.calls().length;
    for (let ms = SETTLE_STEP_MS; ms <= SETTLE_MAX_MS; ms += SETTLE_STEP_MS) {
      await t.run(sleep(t.clock, SETTLE_STEP_MS));
      const now = t.mock.calls().length;
      if (ms >= SETTLE_MIN_MS && now === calls) return;
      calls = now;
    }
  }

  /** Сообщения и панели приходят с экрана, который сейчас открыт в MSX: открыть его, если плагин считает текущим другой. */
  private async show(screen: string | undefined): Promise<void> {
    if (screen !== undefined && this.t.ctx.current.get() !== screen) await this.t.request(screen);
  }

  /** Экран под узлом: контентный запрос — он сам, панель, resolve и сообщение — экран, с которого они пришли. */
  private screenOf(n: Node): string | undefined {
    if (n.k === "reload") return n.id;
    if (n.k === "msg") return n.screen;
    const k = parseDataId(n.id).k;
    if (k === "init") return undefined;
    return isPanelId(n.id) || RESOLVE_KINDS.has(k) ? n.screen : n.id;
  }

  /** Повтор того же `dataId` — из кэша: ≤ 50 мс поддельного времени и без ожидания сети, хотя mock на это время медленнее. */
  private async fromCache(n: Extract<Node, { k: "req" }>): Promise<void> {
    const { t } = this;
    t.mock.setScenario({ delayMs: NET_DELAY_MS });
    const fake0 = t.clock.perf();
    const t0 = performance.now();
    let t1 = t0;
    try {
      await t.run(t.app.handleRequest(n.id, {}).then(() => {
        t1 = performance.now();
      }));
    } finally {
      t.mock.setScenario({ delayMs: 0 });
    }
    t.host.clearActions();
    const real = Math.round(t1 - t0);
    const fake = t.clock.perf() - fake0;
    if (real > CACHE_REAL_MS || fake > CACHE_MS) {
      this.fail(label(n), "cache", `repeat took ${real} ms (fake ${fake} ms) > ${CACHE_REAL_MS} ms (fake ${CACHE_MS} ms)`);
    }
  }

  // --- Проверки ---

  private check(n: Extract<Node, { k: "req" | "reload" }>, answer: unknown): void {
    const at = label(n);
    const { P } = this.t.ctx;
    const k = parseDataId(n.id).k;
    for (const i of answerIssues(n.id, answer)) this.fail(at, i.rule, i.detail);
    if (typeof answer !== "object" || answer === null) return;
    for (const d of contextIssues(answer)) this.fail(at, "context", d);
    for (const d of placeholderIssues(answer)) this.fail(at, "placeholder", d);
    for (const d of addressIssues(answer, P)) this.fail(at, "address", d);
    for (const d of menuActionIssues(P, at, answer)) this.fail(at, "menu", d);
    const size = bytesOf(answer);
    const kind = kindOf(n.id);
    this.maxBytes[kind] = Math.max(this.maxBytes[kind] ?? 0, size);
    if (size > sizeLimit(n.id)) this.fail(at, "size", `${size} B > ${sizeLimit(n.id)} B`);
    const text = JSON.stringify(answer);
    // В здоровом mock экран ошибки или заглушка по ссылке из ответа — висячая ссылка или недоделанный экран.
    const code = /Код: (KP-[A-Z0-9]+)/.exec(text)?.[1];
    if (code !== undefined && !RESOLVE_KINDS.has(k)) this.fail(at, "dangling", `error screen ${code}`);
    if (text.includes("Раздел в разработке")) this.fail(at, "stub", "placeholder screen");
    const error = (answer as { error?: unknown }).error;
    if ((k === "play" || k === "playEp") && typeof error === "string") this.fail(at, "dangling", `resolve error: ${error}`);
    const flag = (answer as { flag?: unknown }).flag;
    if (!isPanelId(n.id) && !RESOLVE_KINDS.has(k)) this.flags.set(n.id, typeof flag === "string" ? flag : undefined);
  }

  // --- Рёбра ---

  /** Пункты меню — `data: request:interaction:<id>@P` (голый запрос, без префикса действия). */
  private menuData(n: Node, answer: unknown): void {
    const menu = (answer as { menu?: { data?: unknown }[] }).menu ?? [];
    for (const m of menu) {
      if (m.data === undefined) continue;
      const id = typeof m.data === "string" ? /^request:interaction:([^@]+)@/.exec(m.data)?.[1] : undefined;
      if (id === undefined) this.fail(label(n), "action", `menu data ${String(m.data)}`);
      else this.addReq(id, n, false);
    }
  }

  /** Действия, которые плагин выполнил сам: проверка, очередь, перезапрос открытого экрана — сразу, как в MSX. */
  private async hostActions(n: Node, reloads: number): Promise<void> {
    const acts = this.t.host.actions.map((a) => a.action);
    this.t.host.clearActions();
    const reload = new Set<string>();
    for (const a of acts) this.follow(a, n, true, reload);
    for (const id of reload) {
      if (reloads >= MAX_RELOADS || !this.budget()) break;
      const r: Node = { k: "reload", id, depth: n.depth };
      await this.visit(r, () => this.answer(r, reloads + 1));
    }
  }

  /** Проверить действие и поставить в очередь то, что оно запросит у плагина. `reload` — только у действий плагина. */
  private follow(action: string, from: Node, host: boolean, reload?: Set<string>): void {
    const at = label(from);
    if (!this.edges.has(action)) {
      this.edges.add(action);
      for (const d of actionIssues(action)) this.fail(at, "action", d);
    }
    if (host) {
      for (const d of addressIssues(action, this.t.ctx.P)) this.fail(at, "address", d);
      for (const d of menuActionIssues(this.t.ctx.P, at, action)) this.fail(at, "menu", d);
    }
    for (const m of splitChain(action)) this.member(m, from, reload);
  }

  private member(m: string, from: Node, reload: Set<string> | undefined): void {
    const r = REQUEST.exec(m);
    const current = this.t.ctx.current.get();
    if (r !== null) {
      const [, prefix, replace, flag, id = ""] = r;
      if (replace === "content") {
        // MSX заменяет экран, только если флаг совпал с флагом открытого экрана (спец. §6.3, Plan B M-01).
        const screen = reload !== undefined ? current : this.screenOf(from);
        const want = screen === undefined ? undefined : this.flags.get(screen);
        if (want !== flag) this.fail(label(from), "flag", `${m}: open screen ${screen ?? "-"} has flag ${want ?? "-"}`);
        if (reload === undefined) this.addReq(id, from, false);
        else if (id === current) reload.add(id);
        return;
      }
      if (prefix === "video:resolve:") this.addReq(startVariant(id), from, true);
      else this.addReq(id, from, prefix === "panel:");
      return;
    }
    const msg = /^interaction:commit:message:(.+)$/.exec(m)?.[1];
    if (msg !== undefined) this.addMsg(msg, from);
    else if (reload !== undefined && m === "reload:content" && current !== undefined) reload.add(current);
  }

  // --- Очередь ---

  private auth(): string {
    return this.t.ctx.auth.isLoggedIn() ? "in" : "out";
  }

  private push(n: Work, toLast = false): void {
    const key = `${this.auth()}|${n.k}|${n.k === "msg" ? n.msg : n.id}`;
    if (n.depth > (this.o.depth ?? MAX_DEPTH) || this.seen.has(key)) return;
    const cap = capKey(n);
    const taken = this.taken.get(`${this.auth()}|${cap}`) ?? 0;
    if (taken >= capOf(n, cap)) return;
    this.seen.add(key);
    this.taken.set(`${this.auth()}|${cap}`, taken + 1);
    (toLast ? this.last : this.queue).push(n);
  }

  /** `overlay` — панель или resolve: открывается поверх экрана, с которого пришло действие. */
  private addReq(id: string, from: Node, overlay: boolean): void {
    if (parseDataId(id).k === "unknown") {
      this.fail(label(from), "dangling", `unknown dataId ${id}`);
      return;
    }
    const n: Extract<Node, { k: "req" }> = { k: "req", id, depth: from.depth + 1 };
    const screen = this.screenOf(from);
    if (overlay && screen !== undefined) n.screen = screen;
    this.push(n);
  }

  private addMsg(msg: string, from: Node): void {
    const m = parseMessage(msg);
    if (m.k === "unknown") {
      this.fail(label(from), "dangling", `unknown message ${msg}`);
      return;
    }
    if (m.k === "searchInput" && !SEARCH_KEYS.has(m.ch)) return;
    const n: Extract<Node, { k: "msg" }> = { k: "msg", msg, depth: from.depth + 1 };
    const screen = this.screenOf(from);
    if (screen !== undefined) n.screen = screen;
    this.push(n, m.k === "act" && LAST.has(`${m.module}:${m.name}`));
  }
}

/** Обход графа действий плагина от `init` со входом (спец. §14.1); после всего — выход и экраны без входа. */
export async function crawl(opts: CrawlOptions = {}): Promise<CrawlReport> {
  const t = await createTestApp({ loggedIn: true, ...(opts.flags !== undefined ? { flags: opts.flags } : {}) });
  try {
    return await new Crawler(t, opts).run();
  } finally {
    await t.close();
  }
}

function summary(name: string, r: CrawlReport): string {
  const lines = [`crawl ${name}: ${r.nodes} nodes, ${r.edges} actions, ${r.failures.length} failures`];
  for (const [kind, bytes] of Object.entries(r.maxBytes).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${kind.padEnd(26)} ${String(bytes).padStart(6)} B`);
  }
  for (const f of r.failures) lines.push(`  FAIL ${f.rule} ${f.dataId}: ${f.detail}`);
  return lines.join("\n");
}

if (import.meta.main) {
  const trace = process.argv.includes("--verbose") ? (line: string): void => console.log(line) : undefined;
  // Второй проход — свойства плеера в шаблоне сезона через {context:…} (CDG-06, Р-18).
  const runs: [string, CrawlOptions][] = [["defaults", {}], ["playerPropsIn=item", { maxNodes: 120, flags: { playerPropsIn: "item" } }]];
  let failed = 0;
  for (const [name, o] of runs) {
    const r = await crawl(trace === undefined ? o : { ...o, trace });
    console.log(summary(name, r));
    failed += r.failures.length;
  }
  process.exit(failed > 0 ? 1 : 0);
}
