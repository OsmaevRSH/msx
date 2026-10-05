import type { AppContext } from "../app/context.ts";
import type { TimerId } from "../core/clock.ts";
import { stat } from "../core/metrics.ts";
import { positionFrom } from "../progress/samples.ts";
import type { PlaybackSession } from "../progress/session.ts";
import type { TrackerEvent } from "../progress/tracker.ts";
import { fmtSec } from "./report.ts";
import type { CheckId, CheckResult } from "./runner.ts";
import { loadTitle, result } from "./store.ts";

// Проверки пробника уровня ТВ (спец. §16.2): CDG-05…07, 11 — по событиям трекера для плиток с `kp:p`,
// CDG-12 — по счётчикам сообщений маршрутизатора за сессию «Сетки 150».

const PLAYER_EVENTS = ["video:load", "video:play", "video:pause", "video:stop"] as const;
/** Прогресс опирается на позиции паузы и остановки (Plan B §9.2). */
const NEED_POSITION = ["video:pause", "video:stop"];
/** Запасной путь CDG-07: `requestData("video")` один раз через 15 с после старта. */
const REQUEST_DATA_AFTER_MS = 15_000;
/** Back-снимок (`trigger:back` → снимок → `eject`) приходит перед `video:stop`, тики — раз в 10 с. */
const BACK_WINDOW_MS = 5_000;
/** Конец последней серии сезона без старта следующей за это время — автопереход не сработал. */
const AUTONEXT_WAIT_MS = 30_000;
const MIN_TICKS = 2;
const MIN_EXTEND = 2;
const AUDIO_VARIANTS = ["a1", "a2", "hls2"] as const;
const COUNTERS = { pf: "msg:pf", pfRaw: "msg:pf_raw", extend: "msg:extend" } as const;

type AudioVariant = (typeof AUDIO_VARIANTS)[number];
type Raw = Extract<TrackerEvent, { kind: "raw" }>;

const AUDIO_LABEL: Record<AudioVariant, string> = { a1: "a1", a2: "a2", hls2: "HLS2" };

interface TicksRun { mid: number; events: Set<string>; withPos: Set<string>; snaps: number[]; stoppedAt?: number; rdv?: boolean; rdvTimer?: TimerId }
interface PropsRun { mid: number; loadProps: boolean; snaps: number; okRecorded: boolean }
interface AutonextRun { itemId: number; mid: number; season: number; nextMid?: number; timer?: TimerId }
type Counts = Record<keyof typeof COUNTERS, number>;
interface TvState { lastRaw?: Raw; ticks?: TicksRun; props?: PropsRun; autonext?: AutonextRun; grid?: Counts }

const states = new WeakMap<AppContext, TvState>();

function stateOf(ctx: AppContext): TvState {
  let st = states.get(ctx);
  if (st === undefined) {
    st = {};
    states.set(ctx, st);
  }
  return st;
}

const isAudio = (p: string | undefined): p is AudioVariant => (AUDIO_VARIANTS as readonly string[]).includes(p ?? "");
const short = (names: readonly string[]): string => names.map((n) => n.replace("video:", "")).join(",");

function record(ctx: AppContext, id: CheckId, ok: boolean | null, summary: string, values: CheckResult["values"]): void {
  ctx.probe.record(result(ctx, id, ok, summary, values));
}

export function installTvChecks(ctx: AppContext): void {
  const st = stateOf(ctx);
  ctx.tracker.addListener((e) => {
    switch (e.kind) {
      case "raw":
        onRaw(ctx, st, e);
        st.lastRaw = e;
        return;
      case "load":
        onLoad(ctx, st, e.s);
        return;
      case "started":
        onStarted(ctx, st, e.s, e.ttffMs);
        return;
      case "snapshot":
        onSnapshot(ctx, st, e.s);
        return;
      case "stop":
        onStop(ctx, st, e.s);
        return;
      default:
        return;
    }
  });
}

// --- События трекера ---

/** `video:play/pause/stop` сессии «События и тики»; `video:load` учитывается в `onLoad` — сессия ещё прежняя. */
function onRaw(ctx: AppContext, st: TvState, e: Raw): void {
  const run = st.ticks;
  const s = ctx.tracker.session();
  if (run === undefined || e.source !== "handleEvent" || e.name === "video:load" || s?.probe !== "ticks" || s.mid !== run.mid) return;
  run.events.add(e.name);
  if (e.position !== undefined) run.withPos.add(e.name);
}

function onLoad(ctx: AppContext, st: TvState, s: PlaybackSession): void {
  const raw = st.lastRaw;
  const fromEvent = raw !== undefined && raw.source === "handleEvent" && raw.name === "video:load";
  autonextArrived(ctx, st, s);
  switch (s.probe) {
    case "ticks": {
      if (st.ticks?.rdvTimer !== undefined) ctx.clock.clearTimeout(st.ticks.rdvTimer);
      const run: TicksRun = { mid: s.mid, events: new Set(), withPos: new Set(), snaps: [] };
      if (fromEvent) run.events.add("video:load");
      if (fromEvent && raw.position !== undefined) run.withPos.add("video:load");
      st.ticks = run;
      return;
    }
    case "props":
      st.props = { mid: s.mid, loadProps: fromEvent, snaps: 0, okRecorded: false };
      return;
    case "autonext": {
      if (st.autonext?.timer !== undefined) ctx.clock.clearTimeout(st.autonext.timer);
      const title = loadTitle(ctx.store);
      st.autonext = { itemId: s.itemId, mid: s.mid, season: s.season };
      if (title !== undefined && title.id === s.itemId) st.autonext.nextMid = title.s2e1.mid;
      return;
    }
    default:
      return;
  }
}

function onStarted(ctx: AppContext, st: TvState, s: PlaybackSession, ttffMs: number | undefined): void {
  if (isAudio(s.probe)) {
    recordAudio(ctx, s.probe, ttffMs === undefined ? true : Math.round(ttffMs));
    return;
  }
  const run = st.ticks;
  if (s.probe !== "ticks" || run === undefined || run.mid !== s.mid || run.rdvTimer !== undefined || run.rdv !== undefined) return;
  run.rdvTimer = ctx.clock.setTimeout(() => {
    run.rdvTimer = undefined;
    ctx.host.requestData("video").then(
      (d: unknown) => positionFrom(d).position !== undefined,
      () => false,
    ).then((ok) => {
      run.rdv = ok;
      if (run.stoppedAt !== undefined && st.ticks === run) recordTicks(ctx, run);
    }).catch(() => undefined);
  }, REQUEST_DATA_AFTER_MS);
}

/** Только снимки из триггеров плеера (`handleData`); снимки heartbeat-таймера сюда не относятся. */
function onSnapshot(ctx: AppContext, st: TvState, s: PlaybackSession): void {
  if (st.lastRaw?.source !== "handleData") return;
  const run = st.ticks;
  if (s.probe === "ticks" && run !== undefined && run.mid === s.mid && run.stoppedAt === undefined) run.snaps.push(ctx.clock.now());
  const p = st.props;
  if (s.probe === "props" && p !== undefined && p.mid === s.mid) {
    p.snaps += 1;
    if (p.loadProps && !p.okRecorded) {
      p.okRecorded = true;
      recordProps(ctx, p);
    }
  }
}

function onStop(ctx: AppContext, st: TvState, s: PlaybackSession): void {
  const run = st.ticks;
  if (s.probe === "ticks" && run !== undefined && run.mid === s.mid && run.stoppedAt === undefined) {
    run.stoppedAt = ctx.clock.now();
    if (run.rdvTimer !== undefined) ctx.clock.clearTimeout(run.rdvTimer);
    run.rdvTimer = undefined;
    recordTicks(ctx, run);
  }
  if (s.probe === "props" && st.props?.mid === s.mid) recordProps(ctx, st.props);
  if (isAudio(s.probe) && !s.started) recordAudio(ctx, s.probe, false);
  const an = st.autonext;
  if (an === undefined || an.mid !== s.mid) return;
  if (!s.ended) {
    st.autonext = undefined;
    return;
  }
  an.timer = ctx.clock.setTimeout(() => {
    if (st.autonext !== an) return;
    st.autonext = undefined;
    record(ctx, "CDG-11", false, `за ${AUTONEXT_WAIT_MS / 1000} с не стартовала следующая серия: нужен autonext=resolve`,
      { autonext: ctx.flags.get().autonext, mid: an.mid });
  }, AUTONEXT_WAIT_MS);
}

// --- Итоги проверок ---

/** CDG-05: TTFF трёх плиток; значения копятся в сохранённом результате (плитки запускаются по одной). */
function recordAudio(ctx: AppContext, v: AudioVariant, value: number | boolean): void {
  const prev = ctx.probe.results().find((r) => r.id === "CDG-05")?.values ?? {};
  const got: Partial<Record<AudioVariant, number | boolean>> = {};
  for (const k of AUDIO_VARIANTS) {
    const x = prev[k];
    if (typeof x === "number" || typeof x === "boolean") got[k] = x;
  }
  // Выход по Back до старта не отменяет прежний удачный старт этой плитки.
  if (value === false && got[v] !== undefined && got[v] !== false) return;
  got[v] = value;
  const values: CheckResult["values"] = { ...got };
  const ttffs = AUDIO_VARIANTS.flatMap((k) => {
    const x = got[k];
    return typeof x === "number" ? [x] : [];
  });
  const each = AUDIO_VARIANTS.flatMap((k) => {
    const x = got[k];
    if (x === undefined) return [];
    return [`${AUDIO_LABEL[k]} ${x === false ? "не стартовал" : typeof x === "number" ? fmtSec(x) : "старт"}`];
  });
  let head = "";
  if (ttffs.length > 0) {
    const s = stat(ttffs);
    values.p50 = s.p50;
    values.p95 = s.p95;
    head = `TTFF p50 ${fmtSec(s.p50)} p95 ${fmtSec(s.p95)}: `;
  }
  const failed = AUDIO_VARIANTS.some((k) => got[k] === false);
  const waiting = AUDIO_VARIANTS.filter((k) => got[k] === undefined);
  const tail = waiting.length > 0 ? `; ждут ${waiting.map((k) => AUDIO_LABEL[k]).join(", ")}` : "";
  const ok = failed ? false : waiting.length > 0 ? null : true;
  record(ctx, "CDG-05", ok, `${head}${each.join(", ")}${tail}`, values);
}

function recordProps(ctx: AppContext, p: PropsRun): void {
  const ok = p.loadProps && p.snaps > 0;
  const summary = ok
    ? `video:load со свойствами kp:*, снимков триггеров ${p.snaps}`
    : !p.loadProps ? "video:load без свойств kp:* из resolve: нужен playerPropsIn=item" : "снимков от триггеров плеера нет";
  record(ctx, "CDG-06", ok, summary, { loadProps: p.loadProps, snapshots: p.snaps });
}

/** CDG-07: события с позициями, ≥ 2 снимка тиков и Back-снимок (последний снимок перед `video:stop`). */
function recordTicks(ctx: AppContext, run: TicksRun): void {
  const last = run.snaps[run.snaps.length - 1];
  const back = last !== undefined && run.stoppedAt !== undefined && run.stoppedAt - last <= BACK_WINDOW_MS;
  const ticks = run.snaps.length - (back ? 1 : 0);
  const events = PLAYER_EVENTS.filter((n) => run.events.has(n));
  const withPos = PLAYER_EVENTS.filter((n) => run.withPos.has(n));
  const eventsOk = events.length === PLAYER_EVENTS.length && NEED_POSITION.every((n) => run.withPos.has(n));
  const ok = eventsOk && ticks >= MIN_TICKS && back;
  const values: CheckResult["values"] = { events: short(events), withPos: short(withPos), ticks, back };
  if (run.rdv !== undefined) values.requestDataVideo = run.rdv;
  const rdv = run.rdv === undefined ? "не проверен" : run.rdv ? "с позицией" : "без позиции";
  const summary = `события ${events.length}/4, с позицией: ${short(withPos) || "нет"}; тиков ${ticks}; ` +
    `Back-снимок ${back ? "есть" : "нет"}; requestData ${rdv}`;
  record(ctx, "CDG-07", ok, summary, values);
}

/** Первая серия следующего сезона того же тайтла после плитки «Автопереход» (CDG-11). */
function autonextArrived(ctx: AppContext, st: TvState, s: PlaybackSession): void {
  const an = st.autonext;
  if (an === undefined || s.itemId !== an.itemId || s.mid === an.mid) return;
  const next = an.nextMid !== undefined ? s.mid === an.nextMid : s.season === an.season + 1 && s.video === 1;
  if (!next) return;
  if (an.timer !== undefined) ctx.clock.clearTimeout(an.timer);
  st.autonext = undefined;
  const mode = ctx.flags.get().autonext;
  record(ctx, "CDG-11", true, `стартовала S${s.season}E${s.video} (autonext=${mode})`, { autonext: mode, mid: s.mid });
}

// --- CDG-12: «Сетка 150» ---

function counts(ctx: AppContext): Counts {
  const c = ctx.metrics.summary().counters;
  return { pf: c[COUNTERS.pf] ?? 0, pfRaw: c[COUNTERS.pfRaw] ?? 0, extend: c[COUNTERS.extend] ?? 0 };
}

/** Кнопка «Сетка 150»: начало сессии списка — счётчики сообщений считаются с этого момента. */
export function gridBegin(ctx: AppContext): void {
  stateOf(ctx).grid = counts(ctx);
}

/**
 * Итог сессии «Сетки 150» к возврату в «Диагностику» или к отчёту. Нераскрытый `{context:kid}` маршрутизатор
 * считает отдельно (`msg:pf_raw`), поэтому вывод не зависит от разметки плиток списка.
 */
export function gridCheck(ctx: AppContext): void {
  const base = stateOf(ctx).grid;
  if (base === undefined) return;
  const now = counts(ctx);
  const pf = now.pf - base.pf;
  const pfRaw = now.pfRaw - base.pfRaw;
  const extend = now.extend - base.extend;
  if (pf + pfRaw + extend === 0) return;
  const kidNumeric = pf > 0 && pfRaw === 0;
  const ok = extend >= MIN_EXTEND && kidNumeric;
  const focus = pf + pfRaw === 0 ? "сообщений фокуса нет (focusPrefetch=off?)" : `фокус: pf ${pf}, нераскрытых ${pfRaw}`;
  const summary = `${focus}; догрузок ${extend}${extend < MIN_EXTEND ? ` (нужно ≥ ${MIN_EXTEND})` : ""}`;
  record(ctx, "CDG-12", ok, summary, { pf, pfRaw, extend, kidNumeric, focusPrefetch: ctx.flags.get().focusPrefetch });
}
