import type { AppContext, MsxInfo } from "../app/context.ts";
import type { Flags } from "../config/flags.ts";
import { fmtDate, fmtTime } from "../core/format.ts";
import { maskSecrets } from "../core/log.ts";
import type { LogEntry } from "../core/log.ts";
import { stat } from "../core/metrics.ts";
import type { Stat } from "../core/metrics.ts";
import { replaceContent } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { ids } from "../router/ids.ts";
import { CHECK_IDS } from "./runner.ts";
import type { CheckId, CheckResult } from "./runner.ts";
import { loadCold, loadPersist, loadSchema } from "./store.ts";
import type { ColdLog, PersistLog, SchemaLog } from "./store.ts";

// Отчёт пробника (спец. §13, CM-05): страницы крупного текста для фото на ТВ и одна строка JSON в консоль web MSX.
// В отчёте нет токенов, кодов входа и IP (CNFR-20).

export interface Report {
  version: string; at: number; msxInfo: MsxInfo | null; flags: Partial<Flags>; results: CheckResult[];
  metrics: { values: Record<string, Stat>; counters: Record<string, number> };
  persist: PersistLog; cold: ColdLog; schema: SchemaLog | null; log: LogEntry[];
}

export const REPORT_FLAG = "probe_report";
const LOG_ENTRIES = 30;
const PAGE_LINES = 12;
const LINE_MAX = 100;
const TOP_API = 4;
const SECRET_MIN = 6;

const T = {
  headline: (i: number, n: number): string => `Отчёт · страница ${i} из ${n}`,
  back: "Назад",
  next: "Дальше",
  notRun: "не запускалась",
  flagsDefault: "по умолчанию",
  hintAudio: "CDG-05: a2 звучит другой озвучкой, чем a1? — проверьте на слух",
  hintButtons: "CDG-06: кнопки плеера (озвучка, субтитры, качество) работают? — проверьте",
  hintGrid: "CDG-12: навигация по сетке без рывков? — оцените сами",
  metrics: "Замеры: p50 / p95, число",
  noValues: "нет замеров",
  logTitle: (n: number): string => `Журнал: предупреждения и ошибки (${n})`,
};

// --- Очистка (CNFR-20) ---

const SECRET_NAMES = /\b(access_token|refresh_token|user_code|client_secret)\b/g;
const SECRET_KEYS = new Set(["access_token", "refresh_token", "user_code", "client_secret"]);
/** Ключ `code` в отчёте — код ошибки плагина; любое другое значение может быть кодом входа. */
const KP_CODE = /^KP-[0-9A-Z]+$/;
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)/g;

function cleanString(s: string, secrets: readonly string[]): string {
  let out = s;
  for (const v of secrets) out = out.split(v).join("***");
  out = maskSecrets(out).replace(SECRET_NAMES, "***");
  return out.replace(IPV4, (m: string, ...oct: string[]) => (oct.slice(0, 4).every((o) => Number(o) <= 255) ? "x.x.x.x" : m));
}

function clean(v: unknown, secrets: readonly string[]): unknown {
  if (typeof v === "string") return cleanString(v, secrets);
  if (Array.isArray(v)) return v.map((x) => clean(x, secrets));
  if (typeof v !== "object" || v === null) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (SECRET_KEYS.has(k) || (k === "code" && !(typeof x === "string" && KP_CODE.test(x)))) continue;
    out[k] = clean(x, secrets);
  }
  return out;
}

/** Копия без IPv4, `access_token=…`, `refresh_token`, `user_code`, `code=…` и значений `secrets` во всех строках. */
export function sanitize<T>(v: T, secrets: readonly string[] = []): T {
  return clean(v, secrets.filter((s) => s.length >= SECRET_MIN)) as T;
}

/** Текущая пара токенов (`kp.auth.pair`, решение Р-16): их значения вырезаются, где бы ни встретились. */
function secretsOf(ctx: AppContext): string[] {
  const pair = ctx.store.get<unknown>("auth", "pair");
  if (typeof pair !== "object" || pair === null) return [];
  return Object.values(pair as Record<string, unknown>).filter((v): v is string => typeof v === "string");
}

// --- Отчёт ---

export function buildReport(ctx: AppContext): Report {
  const r: Report = {
    version: ctx.build.version,
    at: ctx.clock.now(),
    msxInfo: ctx.state.msxInfo ?? null,
    flags: ctx.flags.overrides(),
    results: ctx.probe.results(),
    metrics: ctx.metrics.summary(),
    persist: loadPersist(ctx.store),
    cold: loadCold(ctx.store),
    schema: loadSchema(ctx.store) ?? null,
    log: ctx.log.tail(LOG_ENTRIES),
  };
  return sanitize(r, secretsOf(ctx));
}

/** Основной канал из web MSX (CM-05): одна строка, которую пользователь копирует из консоли браузера. */
export function reportLine(r: Report): string {
  return `KPREPORT ${JSON.stringify(sanitize(r))}`;
}

/**
 * «Отчёт в консоль»: `console.log` — основной канал из web MSX (CM-05). Буфер обмена в iframe без `clipboard-write`
 * может не сработать, поэтому только попытка без ожидания.
 */
export function printReport(r: Report): void {
  const line = reportLine(r);
  console.log(line);
  try {
    const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    clip?.writeText(line).catch(() => undefined);
  } catch {
    // нет доступа к буферу обмена
  }
}

/** 1,9 с — для TTFF и прочих секундных замеров. */
export function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(".", ",")} с`;
}

export function checkMark(r: CheckResult | undefined): "✓" | "✗" | "—" {
  return r === undefined || r.ok === null ? "—" : r.ok ? "✓" : "✗";
}

export function checkLine(id: CheckId, r: CheckResult | undefined): string {
  return `${id} ${checkMark(r)} ${r?.summary ?? T.notRun}`;
}

const cut = (s: string): string => (s.length > LINE_MAX ? `${s.slice(0, LINE_MAX - 1)}…` : s);
const ms = (v: number): string => String(Math.round(v));

function headerLines(r: Report): string[] {
  const i = r.msxInfo ?? {};
  const msx = [`MSX ${i.version ?? "?"}`, i.platform, i.player === undefined ? undefined : `плеер ${i.player}`, i.model];
  const flags = Object.entries(r.flags).map(([k, v]) => `${k}=${String(v)}`).join(", ");
  return [
    `KinoPub MSX ${r.version} · ${fmtDate(r.at / 1000)} ${fmtTime(r.at)}`,
    msx.filter((s) => s !== undefined && s !== "").join(" · "),
    `Флаги: ${flags === "" ? T.flagsDefault : flags}`,
  ];
}

function checkLines(r: Report, from: number, to: number): string[] {
  const byId = new Map(r.results.map((x) => [x.id, x]));
  return CHECK_IDS.slice(from, to).map((id) => checkLine(id, byId.get(id)));
}

function metricLines(r: Report): string[] {
  const { values, counters } = r.metrics;
  const out = [T.metrics];
  const ttff = values.ttff;
  out.push(ttff === undefined ? `TTFF: ${T.noValues}` : `TTFF ${fmtSec(ttff.p50)} / ${fmtSec(ttff.p95)}, n ${ttff.n}`);
  const resolve = values.resolve;
  if (resolve !== undefined) out.push(`resolve ${ms(resolve.p50)} / ${ms(resolve.p95)} мс, n ${resolve.n}`);
  const api = Object.entries(values).filter(([k]) => k.startsWith("api:")).sort((a, b) => b[1].n - a[1].n).slice(0, TOP_API);
  for (const [k, s] of api) out.push(`${k.slice(4)} ${ms(s.p50)} / ${ms(s.p95)} мс, n ${s.n}`);
  out.push(`API: 429 — ${counters["api:429"] ?? 0}, сеть — ${counters["api:net"] ?? 0}, таймауты — ${counters["api:timeout"] ?? 0}`);
  const { first, recent } = r.cold;
  if (first === undefined) {
    out.push(`Холодный старт: ${T.noValues}`);
  } else {
    const again = stat(recent.filter((c) => c.bootId !== first.bootId).map((c) => c.readyMs));
    const tail = again.n === 0 ? "повторных нет" : `повторные p50 ${again.p50} / p95 ${again.p95} мс, n ${again.n}`;
    out.push(`Холодный старт: первый ${first.readyMs} мс; ${tail}`);
  }
  const marker = r.persist.markerAt;
  const runs = r.persist.runs.filter((x) => marker !== undefined && x.markerAt === marker);
  const kept = runs.filter((x) => x.authOk && x.l2Ok).length;
  out.push(marker === undefined ? "Хранилище: маркер не записан" : `Хранилище: запусков после маркера ${runs.length}, всё цело ${kept}`);
  if (r.schema !== null) {
    const eps = Object.keys(r.schema);
    const fields = Object.values(r.schema).reduce((n, s) => n + Object.keys(s).length, 0);
    out.push(`Схема API: эндпоинтов ${eps.length}, полей ${fields}`);
  }
  return out;
}

function logLines(r: Report): string[] {
  const bad = r.log.filter((e) => e.level === "warn" || e.level === "error");
  if (bad.length === 0) return [];
  const rows = bad.slice(-(PAGE_LINES - 1)).map((e) => {
    const err = typeof e.data?.err === "string" ? ` ${e.data.err}` : "";
    return `${fmtTime(e.t)} ${e.level === "error" ? "E" : "W"} ${e.tag} ${e.msg}${err}`;
  });
  return [T.logTitle(bad.length), ...rows];
}

/** 3–4 страницы по ≤ 12 строк: окружение и CDG-01…06; CDG-07…12 и что проверить самому; замеры; журнал. */
export function reportPages(r: Report): string[][] {
  const pages = [
    [...headerLines(r), ...checkLines(r, 0, 6)],
    [...checkLines(r, 6, 12), T.hintAudio, T.hintButtons, T.hintGrid],
    metricLines(r),
    logLines(r),
  ];
  return pages.filter((p) => p.length > 0).map((p) => p.slice(0, PAGE_LINES).map(cut));
}

// --- Экран ---

const MARK_ICONS: Readonly<Record<string, string>> = { "✓": "{ico:msx-green:check}", "✗": "{ico:msx-red:close}" };

/** Строка для текста MSX: фигурные скобки — разметка MSX, а значки ✓/✗ в шрифте ТВ может не оказаться. */
export function msxText(s: string): string {
  return s.replace(/\{/g, "(").replace(/\}/g, ")").replace(/[✓✗]/g, (m) => MARK_ICONS[m] ?? m);
}

/** `probe:report:<n>`: страница отчёта для фото; «Назад»/«Дальше» заменяют страницу на месте, Back — к «Диагностике». */
export function reportScreen(ctx: AppContext, n: number): MsxContentRoot {
  const pages = reportPages(buildReport(ctx));
  const i = Math.min(Math.max(1, Math.floor(n)), pages.length);
  const page = (k: number): string => replaceContent(REPORT_FLAG, ctx.P, ids.probe(`report:${k}`));
  const items: MsxContentItem[] = [
    { type: "space", layout: "0,0,12,5", text: (pages[i - 1] ?? []).map(msxText).join("{br}") },
    { id: "r_back", type: "button", layout: "0,5,6,1", label: T.back, action: i > 1 ? page(i - 1) : "back" },
  ];
  if (i < pages.length) items.push({ id: "r_next", type: "button", layout: "6,5,6,1", label: T.next, action: page(i + 1), focus: true });
  return { type: "pages", flag: REPORT_FLAG, cache: false, reuse: false, headline: T.headline(i, pages.length), pages: [{ items }] };
}
