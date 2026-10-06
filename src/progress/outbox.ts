import type { AppContext } from "../app/context.ts";
import type { ReqClass } from "../api/transport.ts";
import type { TimerId } from "../core/clock.ts";
import { KpError, isKpError, toKpError } from "../core/errors.ts";
import { checkToggleResult } from "./rules.ts";

const TAG = "outbox";
/** Спец. §10.3: повторы через 10 с, 30 с, 2 мин, 10 мин, далее каждые 30 мин. */
const RETRY_MS = [10_000, 30_000, 120_000, 600_000, 1_800_000] as const;
/** Спец. §10.3: ТВ может долго быть выключен, а сервера, который отправил бы без ТВ, нет. */
const TTL_MS = 7 * 86_400_000;
/** Защита от цикла таймера, если запись почему-то не удалось перезаписать с новым `nextAt`. */
const MIN_TIMER_MS = 1000;

type Kind = "m" | "w";
interface Base { item: number; season: number; video: number; createdAt: number; attempts: number; nextAt: number }
/**
 * `marktime`: последняя позиция (секунды) и время решения о ней `at` (этап 33c). Порядок позиций — по `at`, а не
 * по `createdAt`: запрос, решённый раньше, может упасть позже. У записей прежних версий `at` нет — берётся `createdAt`.
 */
interface MarkRec extends Base { time: number; at?: number }
/** «Просмотрено»: желаемое состояние, а не команда «переключить» (CM-01). */
interface WatchRec extends Base { desired: 0 | 1 }
type Rec = MarkRec | WatchRec;

// Ключи kp.out.<m|w>_<item>_<season>_<video>; kp.out.overlay в том же пространстве — не запись outbox.
const KEY_RE = /^([mw])_(\d+)_(\d+)_(\d+)$/;
const keyOf = (kind: Kind, item: number, season: number, video: number): string => `${kind}_${item}_${season}_${video}`;
const seasonArg = (season: number): number | undefined => (season > 0 ? season : undefined);

/** Запрос мог не дойти до сервера или ответ потерялся — повторить позже (спец. §5.3). */
export function isTransient(e: unknown): boolean {
  return isKpError(e) && (e.code === "KP-NET" || e.code === "KP-429" || e.code === "KP-5XX");
}

/** 4xx кроме 401 и 429 — ошибка сопоставления номеров, повтор не поможет (Plan B §9.5). */
function isRejected(e: unknown): boolean {
  if (!isKpError(e)) return false;
  if (e.code === "KP-404") return true;
  const st = e.status;
  return e.code === "KP-BAD" && st !== undefined && st >= 400 && st < 500 && st !== 401 && st !== 429;
}

function errData(e: unknown): Record<string, unknown> {
  const err = toKpError(e);
  return { err: err.code, status: err.status, msg: err.message };
}

const stampOf = (r: MarkRec): number => r.at ?? r.createdAt;

const isInt = (v: unknown, min: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function recFrom(kind: Kind, v: unknown): Rec | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (!isInt(r.item, 1) || !isInt(r.season, 0) || !isInt(r.video, 1)) return undefined;
  if (!isNum(r.createdAt) || !isInt(r.attempts, 0) || !isNum(r.nextAt)) return undefined;
  const base: Base = { item: r.item, season: r.season, video: r.video, createdAt: r.createdAt, attempts: r.attempts, nextAt: r.nextAt };
  if (kind === "m") {
    if (!isInt(r.time, 0)) return undefined;
    return isNum(r.at) ? { ...base, time: r.time, at: r.at } : { ...base, time: r.time };
  }
  return r.desired === 0 || r.desired === 1 ? { ...base, desired: r.desired } : undefined;
}

/** Та же запись (не заменена новым значением, пока шёл запрос). */
const same = (a: Rec, b: Rec): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Неотправленные `marktime` и отметки «просмотрено» в `kp.out.*` (спец. §10.3, CM-01): переживают перезапуск,
 * уходят по расписанию и сразу при `ready`. «Просмотрено» всегда начинается со сверки статуса (Р-20):
 * `toggle` — переключатель, вслепую его повторять нельзя.
 */
export class Outbox {
  private ctx: AppContext;
  private timer: TimerId | undefined;
  private queue: Promise<void> = Promise.resolve();
  /** `marktime` одного ключа уходят по одному: иначе более старая позиция (повторы транспорта, outbox) дошла бы позже. */
  private lanes = new Map<string, Promise<void>>();
  /** Время решения последней позиции ключа, дошедшей до KinoPub: решённое раньше уже устарело. */
  private delivered = new Map<string, number>();
  private lastAt = 0;

  constructor(ctx: AppContext) {
    this.ctx = ctx;
  }

  /** Таймер повторов для записей, оставшихся с прошлого запуска. */
  start(): void {
    this.schedule();
  }

  /** Отправить все записи сейчас, не дожидаясь расписания (`ready`). Прогоны идут по одному. */
  flush(): Promise<void> {
    return this.enqueue(true);
  }

  size(): number {
    return this.keys().length;
  }

  /**
   * `marktime` из трекера: сразу, но после запроса того же ключа, который ещё в полёте. Сеть, 429, 5xx → запись
   * с временем решения, `"queued"`; позиция, которую уже обогнала более новая, — `"superseded"`; прочие ошибки —
   * исключение.
   */
  sendMarktime(itemId: number, season: number, video: number, time: number): Promise<"done" | "queued" | "superseded"> {
    const key = keyOf("m", itemId, season, video);
    const at = this.stamp();
    return this.inLane(key, async () => {
      try {
        await this.ctx.api.marktime(itemId, video, time, seasonArg(season));
      } catch (e) {
        if (!isTransient(e)) throw e;
        if (!this.putMarktime(itemId, season, video, time, at)) return "superseded";
        this.ctx.log.warn(TAG, "marktime_queued", { key, time, ...errData(e) });
        return "queued";
      }
      this.forgetMarktime(itemId, season, video, at);
      return "done";
    });
  }

  /**
   * Позиция для повтора; `at` — время решения о ней. Решение старше записи или позиции, уже дошедшей до KinoPub,
   * не записывается (`false`): повтор откатил бы прогресс назад.
   */
  putMarktime(itemId: number, season: number, video: number, time: number, at: number = this.stamp()): boolean {
    const key = keyOf("m", itemId, season, video);
    const cur = this.readMark(key);
    if (at <= (this.delivered.get(key) ?? Number.NEGATIVE_INFINITY) || (cur !== undefined && at < stampOf(cur))) {
      this.ctx.log.info(TAG, "marktime_stale_dropped", { key, time });
      return false;
    }
    const now = this.ctx.clock.now();
    const rec: MarkRec = { item: itemId, season, video, time: Math.max(0, Math.floor(time)), at, createdAt: now, attempts: 0, nextAt: now + RETRY_MS[0] };
    this.write(key, rec);
    this.schedule();
    return true;
  }

  /**
   * Позиция, решённая в `sentAt`, дошла до KinoPub: запись, решённая раньше, откатила бы её назад, а решённая
   * позже новее — она остаётся. Сравниваются времена решений, не записи: старый запрос мог упасть позже нового.
   */
  forgetMarktime(itemId: number, season: number, video: number, sentAt: number = this.stamp()): void {
    const key = keyOf("m", itemId, season, video);
    if (sentAt > (this.delivered.get(key) ?? Number.NEGATIVE_INFINITY)) this.delivered.set(key, sentAt);
    const rec = this.readMark(key);
    if (rec !== undefined && stampOf(rec) <= sentAt) {
      this.ctx.store.remove("out", key);
      this.schedule();
    }
  }

  /**
   * Сверка `GET /v1/watching?id=` → `toggle` только при расхождении → проверка ответа и одна коррекция.
   * Сеть, 429, 5xx на любом шаге → запись с желаемым состоянием, `"queued"`; прочие ошибки — исключение.
   */
  async setWatched(itemId: number, season: number, video: number, desired: 0 | 1): Promise<"done" | "queued"> {
    const key = keyOf("w", itemId, season, video);
    try {
      await this.apply(itemId, season, video, desired, "fg");
    } catch (e) {
      if (isTransient(e)) {
        const now = this.ctx.clock.now();
        this.write(key, { item: itemId, season, video, desired, createdAt: now, attempts: 0, nextAt: now + RETRY_MS[0] });
        this.ctx.log.warn(TAG, "watched_queued", { item: itemId, season, video, desired, ...errData(e) });
        this.schedule();
        return "queued";
      }
      if (isRejected(e)) this.ctx.store.remove("out", key);
      this.ctx.log.error(TAG, "watched_failed", { item: itemId, season, video, desired, ...errData(e) });
      throw e;
    }
    this.ctx.store.remove("out", key);
    return "done";
  }

  // --- Внутреннее ---

  /** `cls`: немедленная отметка из трекера — передний план, повторы из `kp.out.*` — фон (Plan B §9.5). */
  private async apply(item: number, season: number, video: number, desired: 0 | 1, cls: ReqClass): Promise<void> {
    const { api, log } = this.ctx;
    const unit = (await api.watching(item, cls)).find((u) => u.season === season && u.number === video);
    if (unit === undefined) throw new KpError("KP-404", "unit-not-in-watching");
    if ((unit.status === 1 ? 1 : 0) === desired) return;
    // Ответ toggle — новое состояние: 0 при желаемой 1 значит, что статус успел смениться после сверки (Plan B §9.4 п. 3).
    for (let i = 0; i < 2; i++) {
      if (checkToggleResult(desired, await api.toggle(item, video, seasonArg(season), cls)) === "done") return;
    }
    log.error(TAG, "toggle_mismatch", { item, season, video, desired });
  }

  private enqueue(all: boolean): Promise<void> {
    const next = this.queue.then(() => this.run(all));
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Сначала `m_*`, затем `w_*` (спец. §10.3); `all` — не глядя на `nextAt`. */
  private async run(all: boolean): Promise<void> {
    const { clock, log, store } = this.ctx;
    try {
      for (const kind of ["m", "w"] as const) {
        for (const key of this.keys(kind)) {
          const rec = this.read(key);
          if (rec === undefined) {
            store.remove("out", key);
            log.warn(TAG, "outbox_bad_record", { key });
            continue;
          }
          if (clock.now() - rec.createdAt > TTL_MS) {
            store.remove("out", key);
            log.warn(TAG, "outbox_expired", { key, attempts: rec.attempts });
            continue;
          }
          if (all || rec.nextAt <= clock.now()) await this.send(key, rec);
        }
      }
    } finally {
      this.schedule();
    }
  }

  /** `marktime` — в очереди своего ключа; пока запись ждала, её могла заменить или снять более новая позиция. */
  private send(key: string, rec: Rec): Promise<void> {
    if (!("time" in rec)) return this.attempt(key, rec);
    return this.inLane(key, async () => {
      const cur = this.read(key);
      if (cur !== undefined && same(cur, rec)) await this.attempt(key, rec);
    });
  }

  private async attempt(key: string, rec: Rec): Promise<void> {
    const { api, clock, log } = this.ctx;
    try {
      if ("time" in rec) {
        await api.marktime(rec.item, rec.video, rec.time, seasonArg(rec.season), "bg");
        this.forgetMarktime(rec.item, rec.season, rec.video, stampOf(rec));
      } else {
        await this.apply(rec.item, rec.season, rec.video, rec.desired, "bg");
      }
      this.removeIfSame(key, rec);
      log.info(TAG, "outbox_sent", { key, attempts: rec.attempts });
    } catch (e) {
      if (isRejected(e)) {
        this.removeIfSame(key, rec);
        log.error(TAG, "outbox_dropped", { key, ...errData(e) });
        return;
      }
      const cur = this.read(key);
      if (cur === undefined || !same(cur, rec)) return;
      const attempts = rec.attempts + 1;
      const delay = RETRY_MS[Math.min(attempts, RETRY_MS.length - 1)] as number;
      this.write(key, { ...rec, attempts, nextAt: clock.now() + delay });
      log.warn(TAG, "outbox_retry", { key, attempts, ...errData(e) });
    }
  }

  private schedule(): void {
    const { clock } = this.ctx;
    if (this.timer !== undefined) clock.clearTimeout(this.timer);
    this.timer = undefined;
    let next = Number.POSITIVE_INFINITY;
    for (const key of this.keys()) next = Math.min(next, this.read(key)?.nextAt ?? next);
    if (next === Number.POSITIVE_INFINITY) return;
    this.timer = clock.setTimeout(() => {
      this.timer = undefined;
      this.enqueue(false).catch((e: unknown) => this.ctx.log.error(TAG, "outbox_run_failed", errData(e)));
    }, Math.max(MIN_TIMER_MS, next - clock.now()));
  }

  private keys(kind?: Kind): string[] {
    return this.ctx.store.keys("out").filter((k) => {
      const m = KEY_RE.exec(k);
      return m !== null && (kind === undefined || m[1] === kind);
    });
  }

  private read(key: string): Rec | undefined {
    const m = KEY_RE.exec(key);
    return m === null ? undefined : recFrom(m[1] as Kind, this.ctx.store.get<unknown>("out", key));
  }

  private readMark(key: string): MarkRec | undefined {
    const rec = this.read(key);
    return rec !== undefined && "time" in rec ? rec : undefined;
  }

  /**
   * Время решения о позиции: строго растёт, чтобы два решения в одну миллисекунду тоже были упорядочены. Отсчёт —
   * не раньше записей в хранилище: если часы ТВ ушли назад после перезапуска, новое решение всё равно новее записи.
   */
  private stamp(): number {
    if (this.lastAt === 0) {
      for (const key of this.keys("m")) {
        const r = this.readMark(key);
        if (r !== undefined) this.lastAt = Math.max(this.lastAt, stampOf(r));
      }
    }
    this.lastAt = Math.max(this.ctx.clock.now(), this.lastAt + 1);
    return this.lastAt;
  }

  /** `fn` стартует, когда завершится (успехом или ошибкой) предыдущий запрос того же ключа. */
  private inLane<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.lanes.get(key) ?? Promise.resolve()).then(fn);
    const tail = run.then(() => undefined, () => undefined);
    this.lanes.set(key, tail);
    tail.then(() => {
      if (this.lanes.get(key) === tail) this.lanes.delete(key);
    }).catch(() => undefined);
    return run;
  }

  private write(key: string, rec: Rec): void {
    if (!this.ctx.store.set("out", key, rec)) this.ctx.log.error(TAG, "outbox_write_failed", { key });
  }

  private removeIfSame(key: string, rec: Rec): void {
    const cur = this.read(key);
    if (cur !== undefined && same(cur, rec)) this.ctx.store.remove("out", key);
  }
}
