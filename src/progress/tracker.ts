import type { AppContext } from "../app/context.ts";
import type { ItemDetail, MediaUnit } from "../api/models.ts";
import type { TimerId } from "../core/clock.ts";
import { toKpError } from "../core/errors.ts";
import { refreshAfterPlayback } from "../screens/refresh.ts";
import { MIN_POSITION, decideMarktime, decideWatched, isWatchedPosition, judgePosition } from "./rules.ts";
import { positionFrom, propsFrom } from "./samples.ts";
import { sameRun, sessionFromProps } from "./session.ts";
import type { PlaybackSession } from "./session.ts";

export type TrackerEvent =
  | { kind: "raw"; source: "handleEvent" | "handleData" | "timer"; name: string; position?: number }
  | { kind: "load"; s: PlaybackSession }
  | { kind: "started"; s: PlaybackSession; ttffMs?: number }
  | { kind: "pause" | "stop"; s: PlaybackSession; pos?: number }
  | { kind: "snapshot"; s: PlaybackSession; pos?: number }
  | { kind: "marktime"; s: PlaybackSession; time: number; ok: boolean }
  | { kind: "watched"; s: PlaybackSession; result: "done" | "queued" };

const TAG = "progress";
/** Plan B §9.3: события в пределах 2 с склеиваются в одно с последней позицией. */
const COALESCE_MS = 2000;
/** Plan B §9.2: экран за плеером перерисовывается после `stop`, когда MSX уже закрыла плеер. */
const REFRESH_DELAY_MS = 2000;
/** Конец серии без `ended`: позиция останавливается за секунды до длительности. */
const END_SLACK_SEC = 3;
/**
 * Этап 33c: после `stop` приходят запоздалые снимки того же видео (`trigger:back` гонится с `eject`, тик совпадает с
 * выходом; 10 с — запас на медленную очередь ТВ). Фикс 34b: окно — только для снимков без nonce `kp:r`.
 */
const LATE_MS = 10_000;
const RUNS_KEPT = 8;
/**
 * Фикс 35a: автостарт web MSX не шлёт `video:play` (на ТВ, видимо, тоже), а первый тик — через 60 с. Через 5 с после
 * `video:load` плагин один раз спрашивает позицию: ушла от стартовой — запуск стартовал.
 */
const START_CHECK_MS = 5000;

type MarkKind = "hb" | "pause" | "stop" | "snapshot";
type SnapshotSource = "handleData" | "timer";
interface Pending { s: PlaybackSession; pos: number; kind: MarkKind; timer: TimerId }
/** Видео закрытой сессии и время закрытия: его снимки без nonce в окне `LATE_MS` — запоздалые. */
interface Closed { itemId: number; mid: number; video: number; at: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Признак старта по позиции (фикс 35a): > 0 и дальше секунды от стартовой. Незапустившийся плеер отвечает 0 или
 * `resume:position`, а перемотка назад сразу после «Продолжить» — тоже старт.
 */
const moved = (s: PlaybackSession, pos: number | undefined): boolean => pos !== undefined && pos > 0 && Math.abs(pos - s.from) >= 1;

function errData(e: unknown): Record<string, unknown> {
  const err = toKpError(e);
  return { err: err.code, status: err.status, msg: err.message };
}

function unitOf(item: ItemDetail, season: number, video: number): MediaUnit | undefined {
  if (season === 0) return item.videos.find((v) => v.number === video);
  return item.seasons.find((x) => x.number === season)?.episodes.find((e) => e.number === video);
}

/**
 * События плеера → прогресс в KinoPub (спец. §10, Plan B §9.2–9.4): сессия по свойствам `kp:*`, `marktime` по
 * правилам с склейкой снимков, «просмотрено» с 90 % через outbox со сверкой, перерисовка экрана после `stop`.
 * Этап 33c: сессию открывает явный старт, запоздалые снимки закрытой сессии и откаты без подтверждения
 * (`judgePosition`) прогресс не трогают. Фикс 34b: сессия — это запуск с nonce `kp:r` из ответа resolve.
 */
export class ProgressTracker {
  private ctx: AppContext;
  private listeners: ((e: TrackerEvent) => void)[] = [];
  private current: PlaybackSession | undefined;
  private pending: Pending | undefined;
  private refreshTimer: TimerId | undefined;
  private closed: Closed | undefined;
  /** Nonce последних `RUNS_KEPT` закрытых запусков: их снимки и `video:load` — запоздалые без срока. */
  private runs: string[] = [];
  private runSeq: number;
  /** Был явный старт (`video:load` без `kp:*`, `video:play` без сессии): снимок с `kp:*` может открыть сессию. */
  private armed = false;
  /** Запросы прогресса сессии в полёте: после `stop` карточка помечается устаревшей, когда они завершатся. */
  private work = new WeakMap<PlaybackSession, Set<Promise<unknown>>>();

  constructor(ctx: AppContext) {
    this.ctx = ctx;
    this.runSeq = ctx.clock.now();
  }

  /** `handleEvent` с `video:*`. */
  onEvent(ev: any): void {
    const name = isObj(ev) && typeof ev.event === "string" ? ev.event : "";
    const { position } = positionFrom(ev);
    this.emit(position === undefined ? { kind: "raw", source: "handleEvent", name } : { kind: "raw", source: "handleEvent", name, position });
    switch (name) {
      case "video:load":
        this.onLoad(ev);
        return;
      case "video:play":
        this.onPlay();
        return;
      case "video:pause":
        this.onPause(position);
        return;
      case "video:stop":
        this.onStop(position, isObj(ev) && isObj(ev.data) && ev.data.ended === true);
        return;
    }
  }

  /**
   * `handleData` с `video` (`interaction:commit:video` из триггеров плеера) и ответ `requestData("video")`
   * heartbeat-таймера (`source: "timer"`). Тип триггера неизвестен: решение принимается по позиции (спец. §10.1).
   */
  onSnapshot(payload: any, source: SnapshotSource = "handleData"): void {
    const { position } = positionFrom(payload);
    this.emit(position === undefined ? { kind: "raw", source, name: "video" } : { kind: "raw", source, name: "video", position });
    const fresh = sessionFromProps(propsFrom(payload), this.ctx.clock.now());
    if (this.isLate(fresh)) {
      this.ctx.log.info(TAG, "late_snapshot_ignored", { mid: fresh?.mid, pos: position });
      return;
    }
    const s = this.sessionFor(fresh);
    if (s === undefined || position === undefined) return;
    if (!s.started && moved(s, position)) this.markStarted(s, false);
    this.emit({ kind: "snapshot", s, pos: position });
    if (!this.trusted(s, position)) return;
    s.lastPos = position;
    const kind: MarkKind = source === "timer" ? "hb" : "snapshot";
    this.watch(s, position, kind);
    this.defer(s, position, kind);
  }

  addListener(fn: (e: TrackerEvent) => void): void {
    this.listeners.push(fn);
  }

  session(): PlaybackSession | undefined {
    return this.current;
  }

  /** Nonce запуска `kp:r` для ответа resolve (фикс 34b): старт плагина в мс + номер resolve, base36 — не повторится. */
  newRun(): string {
    return (++this.runSeq).toString(36);
  }

  // --- События плеера ---

  private onLoad(ev: unknown): void {
    const s = sessionFromProps(propsFrom(ev), this.ctx.clock.now());
    // Повтор `video:load` текущего запуска сессию заново не начинает, запоздалый — закрытую не открывает.
    if (s?.run !== undefined && (s.run === this.current?.run || this.runs.includes(s.run))) {
      this.ctx.log.info(TAG, "load_ignored", { mid: s.mid, run: s.run });
      return;
    }
    this.cancelRefresh();
    this.ctx.heartbeat.stop();
    if (s !== undefined) {
      this.open(s);
      return;
    }
    // Чужое видео или `kp:*` не дошли до `video:load` (CDG-06): прежняя сессия закончилась, а новую откроет снимок.
    this.flushPending();
    this.close();
    this.armed = true;
    this.ctx.log.debug(TAG, "load_without_kp");
  }

  private onPlay(): void {
    const s = this.current;
    if (s === undefined) {
      // Запоздалый `play` закрытого видео — не старт: новый запуск всё равно начнётся с `video:load`.
      if (!this.recentlyClosed()) this.armed = true;
      return;
    }
    if (!s.started) this.markStarted(s, true);
    if (this.ctx.flags.get().heartbeat === "timer") this.ctx.heartbeat.start();
  }

  private onPause(pos: number | undefined): void {
    this.ctx.heartbeat.stop();
    const s = this.current;
    if (s === undefined) return;
    if (!s.started && moved(s, pos)) this.markStarted(s, false);
    // Plan B §9.2: пауза без позиции пропускается; откат без подтверждения — тоже, ожидающий снимок остаётся.
    const p = pos !== undefined && this.trusted(s, pos) ? pos : undefined;
    if (p !== undefined) {
      this.cancelPending();
      s.lastPos = p;
    }
    this.emit(pos === undefined ? { kind: "pause", s } : { kind: "pause", s, pos });
    if (p !== undefined) this.position(s, p, "pause");
  }

  /**
   * Позиция события или последняя проверенная: Back-снимок приходит раньше `stop`, который после `eject` бывает
   * без неё (M-02). Откат в позиции события без подтверждения не принимается — тогда тоже последняя проверенная.
   */
  private onStop(evPos: number | undefined, endedFlag: boolean): void {
    this.ctx.heartbeat.stop();
    this.armed = false;
    const s = this.current;
    if (s === undefined) return;
    if (!s.started && moved(s, evPos)) this.markStarted(s, false);
    this.cancelPending();
    const pos = evPos !== undefined && evPos > 0 && this.trusted(s, evPos) ? evPos : s.lastPos;
    s.ended = endedFlag || (pos !== undefined && s.duration > 0 && pos >= s.duration - END_SLACK_SEC);
    this.close();
    this.ctx.log.info(TAG, "stop", { item: s.itemId, mid: s.mid, pos, ended: s.ended });
    this.emit(pos === undefined ? { kind: "stop", s } : { kind: "stop", s, pos });
    if (pos !== undefined) this.position(s, pos, "stop");
    Promise.allSettled([...(this.work.get(s) ?? [])])
      .then(() => this.ctx.repo.invalidateAfterProgress(s.itemId))
      .catch((e: unknown) => this.ctx.log.error(TAG, "invalidate_failed", errData(e)));
    // Plan B §9.2: при автопереходе экран под стартующей серией не перерисовываем.
    if (s.ended && s.hasNext) {
      this.ctx.log.info(TAG, "refresh_skipped_autonext", { item: s.itemId });
      return;
    }
    this.cancelRefresh();
    this.refreshTimer = this.ctx.clock.setTimeout(() => {
      this.refreshTimer = undefined;
      this.ctx.log.info(TAG, "refresh_after_playback", { item: s.itemId });
      try {
        refreshAfterPlayback(this.ctx, s.itemId);
      } catch (e) {
        this.ctx.log.error(TAG, "refresh_failed", errData(e));
      }
    }, REFRESH_DELAY_MS);
  }

  // --- Сессия ---

  private open(s: PlaybackSession): void {
    this.flushPending();
    this.close();
    this.current = s;
    this.armed = false;
    this.ctx.log.info(TAG, "load", { item: s.itemId, mid: s.mid, season: s.season, video: s.video, probe: s.probe, peak: s.peak, run: s.run });
    this.emit({ kind: "load", s });
    this.ctx.clock.setTimeout(() => this.checkStart(s), START_CHECK_MS);
  }

  /** Ранняя проверка старта (фикс 35a): только признак старта, прогресс она не пишет и heartbeat не трогает. */
  private checkStart(s: PlaybackSession): void {
    if (this.current !== s || s.started) return;
    this.ctx.host.requestData("video").then((d: unknown) => {
      const f = sessionFromProps(propsFrom(d), 0);
      if (this.current === s && !s.started && (f === undefined || sameRun(s, f)) && moved(s, positionFrom(d).position)) this.markStarted(s, false);
    }, () => undefined);
  }

  /** Сессия закрыта (`stop`) или вытеснена новым запуском: её снимки с nonce больше не слушаем, без — `LATE_MS`. */
  private close(): void {
    const s = this.current;
    this.current = undefined;
    if (s === undefined) return;
    this.closed = { itemId: s.itemId, mid: s.mid, video: s.video, at: this.ctx.clock.now() };
    if (s.run !== undefined && this.runs.push(s.run) > RUNS_KEPT) this.runs.shift();
  }

  private recentlyClosed(): boolean {
    return this.closed !== undefined && this.ctx.clock.now() - this.closed.at < LATE_MS;
  }

  /** С nonce — снимок закрытого запуска (фикс 34b); без — того же видео или без `kp:*` в окне после закрытия. */
  private isLate(fresh: PlaybackSession | undefined): boolean {
    if (fresh?.run !== undefined) return this.runs.includes(fresh.run);
    const c = this.closed;
    if (c === undefined || !this.recentlyClosed()) return false;
    return fresh === undefined || (fresh.itemId === c.itemId && fresh.mid === c.mid && fresh.video === c.video);
  }

  /**
   * Сессия снимка. Новую снимок открывает только после явного старта: `video:load` без `kp:*` (CDG-06) или
   * `video:play` без сессии. В режиме `events: triggers` событий плеера нет — стартом служит сам снимок (спец. §16.6).
   */
  private sessionFor(fresh: PlaybackSession | undefined): PlaybackSession | undefined {
    const cur = this.current;
    if (fresh === undefined || (cur !== undefined && sameRun(cur, fresh))) return cur;
    if (this.ctx.flags.get().events !== "triggers" && (cur !== undefined || !this.armed)) {
      this.ctx.log.debug(TAG, "snapshot_without_start", { mid: fresh.mid, current: cur?.mid });
      return undefined;
    }
    this.open(fresh);
    return fresh;
  }

  /** Откат дальше `BACK_SLACK_SEC` от максимума сессии — только после подтверждения (`judgePosition`). */
  private trusted(s: PlaybackSession, pos: number): boolean {
    const j = judgePosition(s, pos);
    s.peak = j.peak;
    if (j.held === undefined) delete s.held;
    else s.held = j.held;
    if (j.reason === "held" || j.reason === "seek-back") {
      this.ctx.log.info(TAG, j.reason === "held" ? "position_held" : "seek_back", { mid: s.mid, pos, peak: s.peak });
    }
    return j.ok;
  }

  private markStarted(s: PlaybackSession, fromPlay: boolean): void {
    s.started = true;
    const resolvedAt = fromPlay ? this.ctx.state.resolveAt.get(s.mid) : undefined;
    if (resolvedAt === undefined) {
      this.ctx.log.info(TAG, "started", { mid: s.mid });
      this.emit({ kind: "started", s });
      return;
    }
    const ttffMs = this.ctx.clock.perf() - resolvedAt;
    this.ctx.metrics.record("ttff", ttffMs);
    this.ctx.log.info(TAG, "started", { mid: s.mid, ttffMs });
    this.emit({ kind: "started", s, ttffMs });
  }

  // --- Позиция: оверлей, «просмотрено», marktime ---

  private position(s: PlaybackSession, pos: number, kind: MarkKind): void {
    this.watch(s, pos, kind);
    this.mark(s, pos, kind);
  }

  /** Снимки ждут 2 с: за это время пришедшие снимки склеиваются, уходит последняя позиция. */
  private defer(s: PlaybackSession, pos: number, kind: MarkKind): void {
    if (this.pending !== undefined && this.pending.s === s) {
      this.pending.pos = pos;
      this.pending.kind = kind;
      return;
    }
    this.flushPending();
    this.pending = { s, pos, kind, timer: this.ctx.clock.setTimeout(() => this.flushPending(), COALESCE_MS) };
  }

  private flushPending(): void {
    const p = this.pending;
    if (p === undefined) return;
    this.cancelPending();
    this.mark(p.s, p.pos, p.kind);
  }

  private cancelPending(): void {
    if (this.pending !== undefined) this.ctx.clock.clearTimeout(this.pending.timer);
    this.pending = undefined;
  }

  /** Статус из оверлея или карточки — что новее (Plan B §9.4 п. 2). Неизвестен → −1: outbox всё равно сверит. */
  private knownStatus(s: PlaybackSession): -1 | 0 | 1 {
    const o = this.ctx.overlay.get(s.itemId, s.season, s.video);
    const card = this.ctx.repo.peekItem(s.itemId);
    const unit = card === undefined ? undefined : unitOf(card.value, s.season, s.video);
    if (o !== undefined && (unit === undefined || card === undefined || o.at >= card.fetchedAt)) return o.status;
    return unit?.watching.status ?? -1;
  }

  private watch(s: PlaybackSession, pos: number, kind: MarkKind): void {
    const { overlay } = this.ctx;
    const status = this.knownStatus(s);
    if (decideWatched(s, pos, kind, status) === "toggle") {
      s.watchedDone = true;
      overlay.set(s.itemId, s.season, s.video, { time: Math.floor(pos), status: 1 });
      this.ctx.log.info(TAG, "watched", { item: s.itemId, season: s.season, video: s.video });
      this.track(s, this.ctx.outbox.setWatched(s.itemId, s.season, s.video, 1).then(
        (result) => this.emit({ kind: "watched", s, result }),
        // Причину уже записал outbox; здесь — только чтобы отказ не остался необработанным.
        () => undefined,
      ));
      return;
    }
    // Оверлей показывает то, что будет в KinoPub: без случайных запусков < 30 с и без спора с отметкой (A-18).
    if (pos < MIN_POSITION || (s.watchedDone && !isWatchedPosition(pos, s.duration))) return;
    overlay.set(s.itemId, s.season, s.video, { time: Math.floor(pos), status: s.watchedDone || status === 1 ? 1 : 0 });
  }

  /**
   * Через outbox: запросы одного ключа идут по одному; сеть, 429, 5xx → запись (позиция абсолютная, повтор безопасен);
   * прочие ошибки — в журнал без повтора.
   */
  private mark(s: PlaybackSession, pos: number, kind: MarkKind): void {
    const d = decideMarktime(s, pos, kind);
    if (!d.send || d.time === undefined) return;
    const time = d.time;
    const { clock, log, outbox } = this.ctx;
    // Переданная дальше (отправленная или в outbox) позиция повторно не отправляется (Plan B §9.3).
    s.lastSentPos = time;
    this.track(s, outbox.sendMarktime(s.itemId, s.season, s.video, time).then(
      (result) => {
        if (result === "done") s.lastSentAt = clock.now();
        log.debug(TAG, "marktime", { item: s.itemId, season: s.season, video: s.video, time, result });
        this.emit({ kind: "marktime", s, time, ok: result === "done" });
      },
      (e: unknown) => {
        log.error(TAG, "marktime_failed", { item: s.itemId, season: s.season, video: s.video, time, ...errData(e) });
        this.emit({ kind: "marktime", s, time, ok: false });
      },
    ));
  }

  // --- Служебное ---

  private track(s: PlaybackSession, p: Promise<unknown>): void {
    let set = this.work.get(s);
    if (set === undefined) {
      set = new Set();
      this.work.set(s, set);
    }
    const inFlight = set;
    inFlight.add(p);
    p.finally(() => inFlight.delete(p)).catch((e: unknown) => this.ctx.log.error(TAG, "progress_failed", errData(e)));
  }

  private cancelRefresh(): void {
    if (this.refreshTimer !== undefined) this.ctx.clock.clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private emit(e: TrackerEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        this.ctx.log.error(TAG, "listener_failed", { kind: e.kind, ...errData(err) });
      }
    }
  }
}
