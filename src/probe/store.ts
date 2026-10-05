import type { AppContext } from "../app/context.ts";
import type { KvStore, Ns } from "../bridge/storage.ts";
import type { TimerId } from "../core/clock.ts";
import { stat } from "../core/metrics.ts";
import type { Schema } from "./fingerprint.ts";
import type { CheckId, CheckResult } from "./runner.ts";

// Данные пробника в `kp.cfg.probe.*` (план, этап 20) и проверки хранилища CDG-09 и холодного старта CDG-10 (спец. §16.2).

export const PROBE_KEYS = {
  results: "probe.results", cold: "probe.cold", persist: "probe.persist", title: "probe.title", schema: "probe.schema",
} as const;

export interface ColdRec { at: number; bootId: string; evalMs: number; readyMs: number; initMs?: number }
/** `first` — самый первый замеченный запуск (кэш ТВ пуст, CNFR-02); `recent` — последние 10. */
export interface ColdLog { first?: ColdRec; recent: ColdRec[] }
export interface PersistRun { at: number; markerAt?: number; authOk: boolean; l2Ok: boolean; l2Blocks: number; l2Expect?: number }
/**
 * `markerAt` — время последней «Записать»; `expect` — сколько блоков должно дожить до запуска (без вытесненных
 * самим плагином); `runs` — каждый запуск плагина (CDG-09).
 */
export interface PersistLog { markerAt?: number; expect?: number; runs: PersistRun[] }
export interface UnitRef { mid: number; s: number; e: number; duration: number }
/** Тестовый тайтл: сериал с ≥ 2 сезонами и ≥ 2 озвучками в S1E1 (CDG-05, 08, 11). */
export interface TestTitle { id: number; title: string; seasons: number; audios: number; s1e1: UnitRef; s1Last: UnitRef; s2e1: UnitRef }
export type SchemaLog = Record<string, Schema>;

const COLD_KEEP = 10;
const PERSIST_KEEP = 20;
const BLOCKS = 10;
/** 50 000 символов ≈ 100 КБ (UTF-16, как считает `KvStore.bytes`): 10 блоков ≈ 1 МБ `kp.l2.*`. */
const BLOCK_CHARS = 50_000;
const MARKER = "probeMarker";
const MARKER2 = "probeMarker2";
const QUOTA_CAP = 8_000_000;
/** Блоки заполнения квоты, символов: грубо, затем точнее (точность ≈ 1 КБ). */
const QUOTA_STEPS = [50_000, 5_000, 500];
const QUOTA_MIN = 1_500_000;
const CNFR_01_MS = 800;
const CNFR_02_MS = 2500;
const NS: readonly Ns[] = ["auth", "cfg", "out", "l2"];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export function result(ctx: AppContext, id: CheckId, ok: boolean | null, summary: string, values: CheckResult["values"] = {}): CheckResult {
  return { id, ok, summary, values, at: ctx.clock.now() };
}

// --- Хранение ---

export function loadResults(store: KvStore): Partial<Record<CheckId, CheckResult>> {
  const raw = store.get<unknown>("cfg", PROBE_KEYS.results);
  return isObj(raw) ? (raw as Partial<Record<CheckId, CheckResult>>) : {};
}

export function saveResults(store: KvStore, r: Partial<Record<CheckId, CheckResult>>): void {
  store.set("cfg", PROBE_KEYS.results, r);
}

export function loadCold(store: KvStore): ColdLog {
  const raw = store.get<unknown>("cfg", PROBE_KEYS.cold);
  if (!isObj(raw) || !Array.isArray(raw.recent)) return { recent: [] };
  return raw as unknown as ColdLog;
}

export function loadPersist(store: KvStore): PersistLog {
  const raw = store.get<unknown>("cfg", PROBE_KEYS.persist);
  if (!isObj(raw) || !Array.isArray(raw.runs)) return { runs: [] };
  return raw as unknown as PersistLog;
}

export function loadTitle(store: KvStore): TestTitle | undefined {
  const raw = store.get<unknown>("cfg", PROBE_KEYS.title);
  return isObj(raw) && num(raw.id) !== undefined && isObj(raw.s1e1) ? (raw as unknown as TestTitle) : undefined;
}

export function saveTitle(store: KvStore, t: TestTitle): void {
  store.set("cfg", PROBE_KEYS.title, t);
}

export function loadSchema(store: KvStore): SchemaLog | undefined {
  const raw = store.get<unknown>("cfg", PROBE_KEYS.schema);
  return isObj(raw) ? (raw as SchemaLog) : undefined;
}

export function saveSchema(store: KvStore, s: SchemaLog): void {
  store.set("cfg", PROBE_KEYS.schema, s);
}

// --- CDG-09: хранилище ---

const blockKey = (i: number): string => `probe.c${i}`;

/** Блоки ~1 МБ — через L2: чужие записи `kp.l2.*` L2 удаляет при загрузке индекса. */
function writeBlocks(ctx: AppContext, at: number): void {
  const pad = "x".repeat(BLOCK_CHARS);
  for (let i = 0; i < BLOCKS; i++) ctx.l2.put(blockKey(i), { at, i, pad });
  ctx.l2.flush();
}

/**
 * Сколько блоков на месте — по ключам, без чтения 1 МБ JSON при каждом старте (`onReady` идёт до ответа `init`).
 * «Записать» переписывает все блоки, а неудачную запись L2 удаляет, поэтому ключ есть — значит, блок этого маркера.
 */
function blocksPresent(ctx: AppContext): number {
  const keys = new Set(ctx.store.keys("l2"));
  let n = 0;
  for (let i = 0; i < BLOCKS; i++) if (keys.has(blockKey(i))) n += 1;
  return n;
}

/** Кнопка «Записать»: маркер в `kp.auth.probeMarker` и 10 блоков по 100 КБ в `kp.l2.probe.c0…c9`. */
export function persistWrite(ctx: AppContext): number {
  const at = ctx.clock.now();
  ctx.store.set("auth", MARKER, { at });
  writeBlocks(ctx, at);
  const p = loadPersist(ctx.store);
  ctx.store.set("cfg", PROBE_KEYS.persist, { ...p, markerAt: at, expect: BLOCKS });
  ctx.log.info("probe", "persist marker written");
  return at;
}

/** Каждый запуск: дожили ли маркер `kp.auth.*` и блоки `kp.l2.*` с прошлой записи. */
export function persistOnReady(ctx: AppContext): void {
  const p = loadPersist(ctx.store);
  const marker = ctx.store.get<unknown>("auth", MARKER);
  const at = isObj(marker) ? num(marker.at) : undefined;
  const authOk = at !== undefined && (p.markerAt === undefined || p.markerAt === at);
  const l2Blocks = at === undefined ? 0 : blocksPresent(ctx);
  const l2Expect = Math.min(p.expect ?? BLOCKS, BLOCKS);
  const run: PersistRun = { at: ctx.clock.now(), authOk, l2Ok: authOk && l2Blocks >= l2Expect, l2Blocks, l2Expect };
  if (p.markerAt !== undefined) run.markerAt = p.markerAt;
  ctx.store.set("cfg", PROBE_KEYS.persist, { ...p, runs: [...p.runs, run].slice(-PERSIST_KEEP) });
}

/**
 * Блоки, удалённые самим плагином (вытеснение по бюджету L2 за долгий просмотр, очистка `kp.l2.*` при переполнении),
 * — не потеря: `expect` снижается до числа оставшихся. Запись отложена — обработчики зовутся изнутри L2 и KvStore.
 */
export function watchBlocks(ctx: AppContext): void {
  let timer: TimerId | undefined;
  let saving = false;
  const note = (): void => {
    timer = undefined;
    const p = loadPersist(ctx.store);
    const n = blocksPresent(ctx);
    if (p.markerAt === undefined || n >= (p.expect ?? BLOCKS)) return;
    saving = true;
    try {
      ctx.store.set("cfg", PROBE_KEYS.persist, { ...p, expect: n });
    } finally {
      saving = false;
    }
  };
  const schedule = (): void => {
    if (!saving && timer === undefined) timer = ctx.clock.setTimeout(note, 0);
  };
  ctx.l2.onEvict((key) => {
    if (key.startsWith("probe.c")) schedule();
  });
  ctx.store.onL2Purged(schedule);
}

function totalBytes(store: KvStore): number {
  return NS.reduce((n, ns) => n + store.bytes(ns), 0);
}

function authSnapshot(store: KvStore): Map<string, string> {
  return new Map(store.keys("auth").map((k) => [k, JSON.stringify(store.get<unknown>("auth", k))]));
}

/**
 * Квота: блоки `kp.l2.probeq.*` до отказа (не больше 8 МБ); затем запись в `kp.auth.*` должна пройти — обёртка
 * удаляет `kp.l2.*` (спец. §7.3) — и прочие `kp.auth.*` целы. Синхронно: чужие записи не вклиниваются.
 */
function quotaTest(ctx: AppContext): { quotaBytes: number; capped: boolean; purged: boolean; authKept: boolean; marker2: boolean } {
  const { store } = ctx;
  ctx.l2.flush();
  const before = authSnapshot(store);
  let used = totalBytes(store);
  let n = 0;
  let capped = false;
  for (const chars of QUOTA_STEPS) {
    const pad = "q".repeat(chars);
    while (!capped) {
      const key = `probeq.${n}`;
      if (!store.set("l2", key, pad)) break;
      n += 1;
      used += (`kp.l2.${key}`.length + pad.length + 2) * 2;
      capped = used >= QUOTA_CAP;
    }
  }
  const quotaBytes = totalBytes(store);
  const marker2 = store.set("auth", MARKER2, { at: ctx.clock.now() });
  const purged = !store.keys("l2").some((k) => k.startsWith("probeq."));
  const after = authSnapshot(store);
  after.delete(MARKER2);
  const authKept = before.size === after.size && [...before].every(([k, v]) => after.get(k) === v);
  store.remove("auth", MARKER2);
  for (const k of store.keys("l2")) if (k.startsWith("probeq.")) store.remove("l2", k);
  return { quotaBytes, capped, purged, authKept, marker2 };
}

export function checkStorage(ctx: AppContext): CheckResult {
  const q = quotaTest(ctx);
  const marker = ctx.store.get<unknown>("auth", MARKER);
  const markerAt = isObj(marker) ? num(marker.at) : undefined;
  // Очистка `kp.l2.*` при переполнении стёрла и блоки «Записать»: вернуть их, чтобы следующий запуск их нашёл.
  if (markerAt !== undefined && blocksPresent(ctx) < BLOCKS) {
    writeBlocks(ctx, markerAt);
    ctx.store.set("cfg", PROBE_KEYS.persist, { ...loadPersist(ctx.store), expect: BLOCKS });
  }
  const runs = loadPersist(ctx.store).runs.filter((r) => markerAt !== undefined && r.markerAt === markerAt);
  const survived = runs.filter((r) => r.authOk && r.l2Ok).length;
  const ok = q.quotaBytes >= QUOTA_MIN && q.authKept && q.marker2;
  const kb = Math.round(q.quotaBytes / 1024);
  const values: CheckResult["values"] = {
    quotaBytes: q.quotaBytes, capped: q.capped, purged: q.purged, authKept: q.authKept,
    restarts: runs.length, survived,
  };
  if (markerAt !== undefined) values.markerAt = markerAt;
  const restarts = markerAt === undefined ? "маркер не записан" : `перезапусков ${runs.length}, пережили ${survived}`;
  const summary = `квота ${q.capped ? "≥ " : ""}${kb} КБ, kp.auth ${q.authKept ? "цел" : "повреждён"}; ${restarts}`;
  return result(ctx, "CDG-09", ok, summary, values);
}

// --- CDG-10: холодный старт ---

export function coldOnReady(ctx: AppContext): void {
  const s = ctx.state;
  const log = loadCold(ctx.store);
  if (s.readyAt === undefined || log.recent.some((r) => r.bootId === s.bootId)) return;
  const rec: ColdRec = { at: ctx.clock.now(), bootId: s.bootId, evalMs: Math.round(s.startedAt), readyMs: Math.round(s.readyAt) };
  if (s.initAnsweredAt !== undefined) rec.initMs = Math.round(s.initAnsweredAt);
  const next: ColdLog = { recent: [...log.recent, rec].slice(-COLD_KEEP) };
  next.first = log.first ?? { ...rec };
  ctx.store.set("cfg", PROBE_KEYS.cold, next);
}

/** Ответ `init` приходит после `ready`: время дописывается в запись этой загрузки позже (при `run`/`results`). */
export function fillInit(ctx: AppContext): void {
  const s = ctx.state;
  if (s.initAnsweredAt === undefined) return;
  const log = loadCold(ctx.store);
  const initMs = Math.round(s.initAnsweredAt);
  let changed = false;
  for (const r of [...log.recent, ...(log.first === undefined ? [] : [log.first])]) {
    if (r.bootId === s.bootId && r.initMs === undefined) {
      r.initMs = initMs;
      changed = true;
    }
  }
  if (changed) ctx.store.set("cfg", PROBE_KEYS.cold, log);
}

export function checkColdStart(ctx: AppContext): CheckResult {
  fillInit(ctx);
  const { first, recent } = loadCold(ctx.store);
  if (first === undefined) return result(ctx, "CDG-10", null, "нет замеров: перезапустите плагин");
  // CNFR-01 — запуски с ассетами в кэше, поэтому самый первый (CNFR-02) в выборку не входит.
  const cached = recent.filter((r) => r.bootId !== first.bootId);
  const ready = stat(cached.map((r) => r.readyMs));
  const inits = cached.flatMap((r) => (r.initMs === undefined ? [] : [r.initMs]));
  const last = recent[recent.length - 1] ?? first;
  const ok = (ready.n === 0 || ready.p95 <= CNFR_01_MS) && first.readyMs <= CNFR_02_MS;
  const values: CheckResult["values"] = {
    n: ready.n, readyP50: ready.p50, readyP95: ready.p95, firstReadyMs: first.readyMs,
    lastEvalMs: last.evalMs, lastReadyMs: last.readyMs,
  };
  if (inits.length > 0) values.initP50 = stat(inits).p50;
  if (first.initMs !== undefined) values.firstInitMs = first.initMs;
  if (last.initMs !== undefined) values.lastInitMs = last.initMs;
  const cachedText = ready.n === 0 ? "повторных запусков нет" : `ready p50 ${ready.p50} мс, p95 ${ready.p95} мс (≤ ${CNFR_01_MS})`;
  return result(ctx, "CDG-10", ok, `${cachedText}; первый ${first.readyMs} мс (≤ ${CNFR_02_MS})`, values);
}
