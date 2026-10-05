import type { AppContext } from "../app/context.ts";
import type { ItemDetail, MediaUnit } from "../api/models.ts";
import type { TimerId } from "../core/clock.ts";
import { toKpError } from "../core/errors.ts";
import { refreshAfterPlayback } from "../screens/refresh.ts";
import { isTransient } from "./outbox.ts";
import { MIN_POSITION, decideMarktime, decideWatched, isWatchedPosition } from "./rules.ts";
import { positionFrom, propsFrom } from "./samples.ts";
import { sessionFromProps } from "./session.ts";
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

type MarkKind = "hb" | "pause" | "stop" | "snapshot";
type SnapshotSource = "handleData" | "timer";
interface Pending { s: PlaybackSession; pos: number; kind: MarkKind; timer: TimerId }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

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
 */
export class ProgressTracker {
  private ctx: AppContext;
  private listeners: ((e: TrackerEvent) => void)[] = [];
  private current: PlaybackSession | undefined;
  private pending: Pending | undefined;
  private refreshTimer: TimerId | undefined;
  /** Запросы прогресса сессии в полёте: после `stop` карточка помечается устаревшей, когда они завершатся. */
  private work = new WeakMap<PlaybackSession, Set<Promise<unknown>>>();

  constructor(ctx: AppContext) {
    this.ctx = ctx;
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
    if (fresh !== undefined && (this.current === undefined || this.current.mid !== fresh.mid)) this.open(fresh);
    const s = this.current;
    if (s === undefined || position === undefined) return;
    s.lastPos = position;
    if (position > 0 && !s.started) this.markStarted(s, false);
    this.emit({ kind: "snapshot", s, pos: position });
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

  // --- События плеера ---

  private onLoad(ev: unknown): void {
    this.cancelRefresh();
    this.ctx.heartbeat.stop();
    const s = sessionFromProps(propsFrom(ev), this.ctx.clock.now());
    if (s !== undefined) {
      this.open(s);
      return;
    }
    // Чужое видео без наших маркеров: прежняя сессия закончилась.
    this.flushPending();
    this.current = undefined;
    this.ctx.log.debug(TAG, "load_without_kp");
  }

  private onPlay(): void {
    const s = this.current;
    if (s === undefined) return;
    if (!s.started) this.markStarted(s, true);
    if (this.ctx.flags.get().heartbeat === "timer") this.ctx.heartbeat.start();
  }

  private onPause(pos: number | undefined): void {
    this.ctx.heartbeat.stop();
    const s = this.current;
    if (s === undefined) return;
    if (pos !== undefined) {
      this.cancelPending();
      s.lastPos = pos;
    }
    this.emit(pos === undefined ? { kind: "pause", s } : { kind: "pause", s, pos });
    // Plan B §9.2: пауза без позиции пропускается.
    if (pos !== undefined) this.position(s, pos, "pause");
  }

  /** Позиция события или последний снимок: Back-снимок приходит раньше `stop`, который после `eject` бывает без неё (M-02). */
  private onStop(evPos: number | undefined, endedFlag: boolean): void {
    this.ctx.heartbeat.stop();
    const s = this.current;
    if (s === undefined) return;
    this.cancelPending();
    const pos = evPos !== undefined && evPos > 0 ? evPos : s.lastPos ?? evPos;
    s.ended = endedFlag || (pos !== undefined && s.duration > 0 && pos >= s.duration - END_SLACK_SEC);
    this.current = undefined;
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
    this.current = s;
    this.ctx.log.info(TAG, "load", { item: s.itemId, mid: s.mid, season: s.season, video: s.video, probe: s.probe });
    this.emit({ kind: "load", s });
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

  /** Сеть, 429, 5xx → outbox (позиция абсолютная, повтор безопасен); прочие ошибки — в журнал без повтора. */
  private mark(s: PlaybackSession, pos: number, kind: MarkKind): void {
    const d = decideMarktime(s, pos, kind);
    if (!d.send || d.time === undefined) return;
    const time = d.time;
    const { api, clock, log, outbox } = this.ctx;
    // Переданная дальше (отправленная или в outbox) позиция повторно не отправляется (Plan B §9.3).
    s.lastSentPos = time;
    const sentAt = clock.now();
    this.track(s, api.marktime(s.itemId, s.video, time, s.season > 0 ? s.season : undefined).then(
      () => {
        s.lastSentAt = clock.now();
        outbox.forgetMarktime(s.itemId, s.season, s.video, sentAt);
        log.debug(TAG, "marktime", { item: s.itemId, season: s.season, video: s.video, time });
        this.emit({ kind: "marktime", s, time, ok: true });
      },
      (e: unknown) => {
        if (isTransient(e)) {
          outbox.putMarktime(s.itemId, s.season, s.video, time);
          log.warn(TAG, "marktime_queued", { item: s.itemId, season: s.season, video: s.video, time, ...errData(e) });
        } else {
          log.error(TAG, "marktime_failed", { item: s.itemId, season: s.season, video: s.video, time, ...errData(e) });
        }
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
