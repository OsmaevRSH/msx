import type { AppContext } from "../app/context.ts";
import type { ItemSummary, Page } from "../api/models.ts";
import { toKpError } from "../core/errors.ts";
import { fmtCount } from "../core/format.ts";
import { chain, commitMsg } from "../msx/actions.ts";
import { gridEdges } from "../msx/edges.ts";
import type { MsxContentRoot } from "../msx/types.ts";
import { ids, msgs } from "../router/ids.ts";
import type { Msg, SearchControl } from "../router/ids.ts";
import { KEY_CHARS, keyboardPage, recentShown } from "./keyboard.ts";
import type { SearchView } from "./keyboard.ts";
import { MAX_BYTES, WINDOW, bytes } from "./list.ts";
import { controlOptions } from "./list-head.ts";
import { RECENT_MAX, forgetQueries, recentQueries, rememberQuery } from "./recent.ts";
import { GRID_DECOMPRESSED, ROW, gridPreload, gridTemplate, posterTiles } from "./tiles.ts";

// Поиск S7 (спец. §3.4, §6.3, §11 S7): строка запроса живёт в памяти плагина. Каждое нажатие сразу
// перерисовывает экран (ввод пришёл с текущего экрана), запрос к API — через 300 мс после последнего
// нажатия и от 2 символов. Один ответ (первая порция 48) — и подсказки колонки (первые 6), и сетка результатов:
// второго запроса на ту же строку нет, а стирание к уже найденной строке отвечает из кэша без паузы и сети.
// Результаты и догрузка перерисовываются только у текущего экрана (CD-16, CE-06).

const TAG = "search";
const FLAG = "search";
const EXTEND_KEY = "search";
const PER_PAGE = 48;
/** Как окно списка S5: дальше 96 результатов поиск не листают, а уточняют запрос (CNFR-16). */
const MAX_RESULTS = WINDOW;
/** Ряд плиток — страница MSX; выдача ужимается по байтам целыми рядами. */
const PAGE = ROW;
const MIN_CHARS = 2;
const MAX_CHARS = 32;
/** CNFR-10: подсказки и результат ≤ 1,5 с после последней буквы; пауза короче — подсказки успевают за вводом. */
const DEBOUNCE_MS = 300;
const T = { headline: "Поиск", query: "{ico:search}", forget: "Очистить историю" };
const RESULTS = ["результат", "результата", "результатов"] as const;

/**
 * Состояние поиска в памяти и то, что не входит в общий `SearchState`: число найденного, идущая догрузка и
 * `capped` — результатов больше `MAX_RESULTS`.
 */
type SearchEntry = SearchView & { loading?: Promise<void>; capped?: boolean };

/** Что уходит в API: без пробелов по краям (пробел в конце строки ввода — не новый запрос). */
const norm = (q: string): string => q.trim();

export async function searchScreen(ctx: AppContext): Promise<MsxContentRoot> {
  const s: SearchEntry = ctx.state.search;
  const root: MsxContentRoot = { type: "list", compress: true, flag: FLAG, cache: false, reuse: false, ...gridPreload(ctx), headline: T.headline };
  // `header` — страница над шаблонными элементами; без результатов клавиатура — единственная страница.
  if (s.items.length === 0) {
    root.pages = [keyboardPage(ctx, s)];
    // Под недавними запросами — «Очистить историю»: опции экрана, красная кнопка выполняет сразу (Option Shortcut).
    if (recentShown(ctx, s).length > 0) {
      root.options = controlOptions(T.headline, [{ icon: "delete", label: T.forget, key: "red", action: chain(["cleanup", commitMsg(msgs.searchControl("forget"))]) }]);
    }
    return root;
  }
  // V-09: в результатах клавиатура уходит вверх, а `headline` MSX у экрана из меню не показывает — запрос в `extension`.
  root.extension = `${T.query} «${norm(s.query)}» · ${fmtCount(s.total ?? s.items.length, RESULTS)}`;
  const tiles = posterTiles(ctx, s.items);
  if (!s.done) tiles[tiles.length - 1] = { ...tiles[tiles.length - 1], live: { type: "setup", action: commitMsg(msgs.extend(EXTEND_KEY)) } };
  // Корень сжат ради клавиатуры 16×8, плитки — те же 12×6, что в каталоге (`decompress`).
  const template = gridTemplate(ctx, true);
  // CNFR-16 при любых названиях: хвост выдачи отрезается рядами, подсказка говорит, сколько показано. Под последним
  // рядом — стражи (`msx/edges.ts`); над первым — клавиатура.
  for (let n = tiles.length; ; n = (Math.ceil(n / PAGE) - 1) * PAGE) {
    const cut = n < tiles.length;
    root.header = keyboardPage(ctx, s.capped === true || cut ? { ...s, shown: n } : s);
    root.template = template;
    const { items, inserts } = gridEdges(cut ? tiles.slice(0, n) : tiles, GRID_DECOMPRESSED, { bottom: true });
    root.items = items;
    if (inserts !== undefined) root.inserts = inserts;
    if (n <= PAGE || bytes(root) <= MAX_BYTES) return root;
  }
}

/** `search:input:*`, `search:control:*`, `search:recent:*` и `extend:search` (спец. §3.4). */
export function onSearchInput(ctx: AppContext, m: Msg): void {
  const s: SearchEntry = ctx.state.search;
  switch (m.k) {
    case "searchInput":
      edit(ctx, s, typed(ctx, s.query, m.ch));
      return;
    case "searchControl":
      control(ctx, s, m.c);
      return;
    case "searchRecent":
      pick(ctx, s, m.n);
      return;
    case "extend":
      if (m.key === EXTEND_KEY) {
        extend(ctx, s).catch((e: unknown) => ctx.log.warn(TAG, "extend_failed", { err: toKpError(e).code }));
      }
      return;
    default:
      return;
  }
}

/**
 * Из поиска открыт тайтл (подсказка или плитка; вызывает маршрутизатор): строка — в недавние запросы. В журнал —
 * только длина и число недавних, текст запроса личный.
 */
export function rememberSearch(ctx: AppContext): void {
  const q = norm(ctx.state.search.query);
  if (q.length < MIN_CHARS) return;
  rememberQuery(ctx.store, q);
  ctx.log.info(TAG, "recent", { len: q.length, n: recentQueries(ctx.store).length });
}

// --- Внутреннее ---

/** Новая строка или undefined, если символ не с клавиатуры или строка уже длиной 32. */
function typed(ctx: AppContext, q: string, ch: string): string | undefined {
  if (ch.length !== 1 || !KEY_CHARS.includes(ch)) {
    ctx.log.debug(TAG, "bad_input", { n: ch.length });
    return undefined;
  }
  return q.length < MAX_CHARS ? q + ch : undefined;
}

function control(ctx: AppContext, s: SearchEntry, c: SearchControl): void {
  switch (c) {
    case "back":
      edit(ctx, s, s.query.slice(0, -1));
      return;
    case "clear":
      edit(ctx, s, "");
      return;
    case "space":
      // Как в RBTV: без пробела в начале и без двух пробелов подряд.
      if (s.query !== "" && !s.query.endsWith(" ") && s.query.length < MAX_CHARS) edit(ctx, s, `${s.query} `);
      return;
    case "lang":
      // Меняется только раскладка на экране: запрос и результаты те же.
      s.lang = s.lang === "ru" ? "en" : "ru";
      ctx.host.executeAction("reload:content");
      return;
    case "forget":
      ctx.log.info(TAG, "recent_cleared", { n: recentQueries(ctx.store).length });
      forgetQueries(ctx.store);
      delete s.recent;
      ctx.host.executeAction("reload:content");
      return;
  }
}

/**
 * Недавний запрос `n` — в поле, поиск сразу, без паузы ввода (найденное в кэше — без сети). Пока ответа нет, колонка
 * остаётся недавними (`recent`): строки на тех же местах, фокус пульта не перескакивает на клавиатуру.
 */
function pick(ctx: AppContext, s: SearchEntry, n: number): void {
  const q = recentQueries(ctx.store)[n];
  if (q === undefined) return;
  s.query = q;
  if (!restart(ctx, s, 0) && s.status === "loading") s.recent = true;
  ctx.host.executeAction("reload:content");
}

/**
 * Применить новую строку: экран перерисовывается сразу (спец. §6.3), прежние результаты и таймер сбрасываются, а
 * подсказки остаются до ответа на новую строку. Если запрос для API не изменился (пробел в конце), результаты и
 * ожидание остаются.
 */
function edit(ctx: AppContext, s: SearchEntry, next: string | undefined): void {
  if (next === undefined || next === s.query) return;
  const same = norm(next) === norm(s.query);
  s.query = next;
  if (!same) restart(ctx, s, DEBOUNCE_MS);
  ctx.host.executeAction("reload:content");
}

/**
 * Новый поиск по `s.query` через `wait` мс; свежая первая порция из кэша применяется сразу — тогда `true`. Короче
 * 2 символов — без запроса и без подсказок.
 */
function restart(ctx: AppContext, s: SearchEntry, wait: number): boolean {
  s.seq += 1;
  if (s.timer !== undefined) ctx.clock.clearTimeout(s.timer);
  delete s.timer;
  delete s.error;
  delete s.total;
  delete s.capped;
  delete s.recent;
  s.items = [];
  s.page = 0;
  s.totalPages = 0;
  s.done = true;
  const q = norm(s.query);
  if (q.length < MIN_CHARS) {
    s.status = "short";
    delete s.hints;
    return false;
  }
  const cached = ctx.repo.peekSearch(q);
  if (cached !== undefined) {
    found(s, cached);
    ctx.log.info(TAG, "results_cached", { len: q.length, total: s.total, done: s.done });
    return true;
  }
  s.status = "loading";
  const seq = s.seq;
  s.timer = ctx.clock.setTimeout(() => {
    delete s.timer;
    first(ctx, s, seq).catch((e: unknown) => ctx.log.warn(TAG, "search_failed", { err: toKpError(e).code }));
  }, wait);
  return false;
}

/** Первая порция: результаты, число найденного и подсказки колонки — первые 6 из того же ответа. */
function found(s: SearchEntry, page: Page<ItemSummary>): void {
  apply(s, page, 1);
  s.total = page.pagination.totalItems;
  s.status = s.items.length > 0 ? "ready" : "empty";
  s.hints = s.items.slice(0, RECENT_MAX);
  delete s.recent;
}

/** Первая порция после паузы ввода; ответ на устаревший запрос (`seq` сменился) отбрасывается. */
async function first(ctx: AppContext, s: SearchEntry, seq: number): Promise<void> {
  const q = norm(s.query);
  const t0 = ctx.clock.perf();
  try {
    const page = (await ctx.repo.search(q, 1)).value;
    if (s.seq !== seq) return;
    found(s, page);
    ctx.metrics.record("search:first", ctx.clock.perf() - t0);
    // Сам запрос в журнал не пишется: журнал попадает в отчёт пробника.
    ctx.log.info(TAG, "results", { len: q.length, total: s.total, done: s.done });
  } catch (e) {
    if (s.seq !== seq) return;
    s.status = "error";
    s.error = toKpError(e).code;
    delete s.hints;
    delete s.recent;
    ctx.log.warn(TAG, "search_failed", { len: q.length, err: s.error });
  }
  if (ctx.current.isCurrent(ids.search())) ctx.host.executeAction("reload:content");
}

async function extend(ctx: AppContext, s: SearchEntry): Promise<void> {
  if (s.status !== "ready" || s.done || s.loading !== undefined) return;
  const loading = more(ctx, s);
  s.loading = loading;
  try {
    await loading;
  } finally {
    if (s.loading === loading) delete s.loading;
  }
}

async function more(ctx: AppContext, s: SearchEntry): Promise<void> {
  const seq = s.seq;
  const want = s.page + 1;
  let page: Page<ItemSummary>;
  try {
    page = (await ctx.repo.search(norm(s.query), want)).value;
  } catch (e) {
    // live остаётся у последней плитки: следующий показ плитки повторит догрузку.
    ctx.log.warn(TAG, "extend_failed", { page: want, err: toKpError(e).code });
    return;
  }
  if (s.seq !== seq) return;
  const added = apply(s, page, want);
  ctx.log.info(TAG, "extend", { page: want, added, done: s.done });
  if (ctx.current.isCurrent(ids.search())) ctx.host.executeAction("reload:content");
}

/**
 * Дописать порцию без повторов по id. Конец: последняя страница, короткая порция или зажатая страница —
 * за концом KinoPub отдаёт последнюю страницу вместо пустой (Plan B A-13).
 */
function apply(s: SearchEntry, page: Page<ItemSummary>, want: number): number {
  const seen = new Set(s.items.map((it) => it.id));
  let added = 0;
  for (const it of page.items) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    s.items.push(it);
    added += 1;
  }
  const { current, total } = page.pagination;
  s.page = want;
  s.totalPages = total;
  s.done = current >= total || current < want || page.items.length < PER_PAGE;
  if (s.items.length > MAX_RESULTS || (s.items.length === MAX_RESULTS && !s.done)) {
    s.items.length = MAX_RESULTS;
    s.capped = true;
    s.done = true;
  }
  return added;
}
