import type { DeviceTokenResult, KpApi } from "../api/client.ts";
import type { DeviceCode, TokenPairRaw } from "../api/models.ts";
import type { Clock, TimerId } from "../core/clock.ts";
import { toKpError } from "../core/errors.ts";
import type { KpErrorCode } from "../core/errors.ts";
import type { Logger } from "../core/log.ts";
import type { AuthService } from "./auth-service.ts";

export type LoginState = { phase: "idle" } | { phase: "code"; userCode: string; verificationUri: string; expiresAt: number }
  | { phase: "done" } | { phase: "error"; code: KpErrorCode };

export interface DeviceFlowDeps {
  api: KpApi; auth: AuthService; clock: Clock; log: Logger;
  deviceTitle: () => Promise<string>;
  onChange: (s: LoginState) => void;
}

const TAG = "login";
// Спец. §7.1 п. 3: опрос каждые max(interval, 5) с; slow_down → +5 с.
const MIN_INTERVAL_SEC = 5;
const SLOW_DOWN_STEP_MS = 5000;
const FALLBACK_TITLE = "MSX TV";

/**
 * Вход по коду на ТВ (спец. §7.1, research kinopub-api §4.2–4.3). Опрос — только по `clock.setTimeout`
 * и только пока плагин загружен. `onChange` сообщает о переходах после `start()`: новый код (`renew` или
 * истёк старый), `done`, `error`; состояние, которое вернул сам `start()`, не дублируется.
 */
export class DeviceFlow {
  private d: DeviceFlowDeps;
  private st: LoginState = { phase: "idle" };
  // Номер сеанса опроса: результат опроса или запроса кода от прежнего сеанса отбрасывается.
  private seq = 0;
  private timer: TimerId | undefined;
  private code = "";
  private intervalMs = MIN_INTERVAL_SEC * 1000;
  private codeExpiresAt = 0;
  private starting: Promise<LoginState> | undefined;

  constructor(deps: DeviceFlowDeps) {
    this.d = deps;
  }

  /** Новый код из `idle`/`error`; если код уже показан или вход выполнен — текущее состояние без запроса. */
  start(): Promise<LoginState> {
    if (this.starting !== undefined) return this.starting;
    if (this.st.phase === "code" || this.st.phase === "done") return Promise.resolve(this.st);
    const p = this.newCode(false).finally(() => {
      if (this.starting === p) this.starting = undefined;
    });
    this.starting = p;
    return p;
  }

  /** Новый код взамен текущего (кнопка «Новый код» или истёк срок); сообщается и через `onChange`. */
  renew(): Promise<LoginState> {
    return this.newCode(true);
  }

  /** Остановить опрос; показанный код больше не действует для этого объекта. */
  stop(): void {
    this.halt();
    if (this.st.phase === "code") this.st = { phase: "idle" };
  }

  state(): LoginState {
    return this.st;
  }

  // --- Внутреннее ---

  private halt(): number {
    if (this.timer !== undefined) this.d.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.seq += 1;
    return this.seq;
  }

  private set(st: LoginState, announce: boolean): LoginState {
    this.st = st;
    if (announce) {
      try {
        this.d.onChange(st);
      } catch (e) {
        this.d.log.error(TAG, "on_change_failed", { code: toKpError(e).code });
      }
    }
    return st;
  }

  private async newCode(announce: boolean): Promise<LoginState> {
    const seq = this.halt();
    let dc: DeviceCode;
    try {
      dc = await this.d.api.deviceCode();
    } catch (e) {
      if (seq !== this.seq) return this.st;
      const err = toKpError(e);
      this.d.log.warn(TAG, "device_code_failed", { code: err.code, status: err.status });
      return this.set({ phase: "error", code: err.code }, announce);
    }
    if (seq !== this.seq) return this.st;
    this.code = dc.code;
    this.intervalMs = Math.max(dc.interval, MIN_INTERVAL_SEC) * 1000;
    this.codeExpiresAt = this.d.clock.now() + dc.expiresIn * 1000;
    this.d.log.info(TAG, "code", { intervalMs: this.intervalMs, expiresIn: dc.expiresIn });
    this.schedule(seq);
    return this.set({ phase: "code", userCode: dc.userCode, verificationUri: dc.verificationUri, expiresAt: this.codeExpiresAt }, announce);
  }

  private schedule(seq: number): void {
    this.timer = this.d.clock.setTimeout(() => {
      this.timer = undefined;
      void this.poll(seq);
    }, this.intervalMs);
  }

  private async poll(seq: number): Promise<void> {
    if (seq !== this.seq) return;
    if (this.d.clock.now() >= this.codeExpiresAt) {
      this.d.log.info(TAG, "code_lifetime_over");
      await this.newCode(true);
      return;
    }
    let r: DeviceTokenResult;
    try {
      r = await this.d.api.deviceToken(this.code);
    } catch (e) {
      // Сеть или 429/5xx: следующий опрос по расписанию (спец. §5.3 — у опроса свой таймер).
      if (seq !== this.seq) return;
      this.d.log.warn(TAG, "poll_failed", { code: toKpError(e).code });
      this.schedule(seq);
      return;
    }
    // Пара уже выдана и слот устройства занят: принимаем её, даже если опрос успели остановить.
    if (r.kind === "ok") return this.finish(r.pair);
    if (seq !== this.seq) return;
    switch (r.kind) {
      case "pending":
        this.schedule(seq);
        return;
      case "slow_down":
        this.intervalMs += SLOW_DOWN_STEP_MS;
        this.d.log.info(TAG, "slow_down", { intervalMs: this.intervalMs });
        this.schedule(seq);
        return;
      case "expired":
        await this.newCode(true);
        return;
      case "denied":
        this.halt();
        this.d.log.warn(TAG, "denied");
        this.set({ phase: "error", code: "KP-AUTH" }, true);
        return;
    }
  }

  private async finish(pair: TokenPairRaw): Promise<void> {
    this.halt();
    try {
      await this.d.auth.completeLogin(pair, await this.title());
    } catch (e) {
      this.d.log.error(TAG, "complete_failed", { code: toKpError(e).code });
      this.set({ phase: "error", code: toKpError(e).code }, true);
      return;
    }
    this.d.log.info(TAG, "done");
    this.set({ phase: "done" }, true);
  }

  private async title(): Promise<string> {
    try {
      const t = await this.d.deviceTitle();
      return t.trim() !== "" ? t : FALLBACK_TITLE;
    } catch {
      return FALLBACK_TITLE;
    }
  }
}
