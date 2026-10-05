import type { KpApi, TokenSource } from "../api/client.ts";
import type { DeviceInfo, DeviceSettings, TokenPairRaw } from "../api/models.ts";
import type { Clock } from "../core/clock.ts";
import { KpError, isKpError, toKpError } from "../core/errors.ts";
import type { Logger } from "../core/log.ts";
import type { StoredDevice, StoredPair, TokenStore } from "./tokens.ts";

const TAG = "auth";
const HARDWARE = "Samsung Tizen";
const DEFAULT_TITLE = "MSX TV";
// Спец. §7.3: проактивный refresh после ready, если до истечения меньше 10 мин.
const READY_FRESH_SEC = 600;
// Plan B §6.2.1: SSL 1, HEVC 0, HDR 0, 4K 0, mixed 1 — h264-фолбэк в master HLS4.
const DEVICE_SETTINGS: DeviceSettings = { supportSsl: 1, supportHevc: 0, supportHdr: 0, support4k: 0, mixedPlaylist: 1 };
const SETTING_KEYS = Object.keys(DEVICE_SETTINGS) as (keyof DeviceSettings)[];

export type LogoutReason = "refresh-rejected" | "logout";

const errData = (e: unknown): Record<string, unknown> => {
  const k = toKpError(e);
  return { code: k.code, status: k.status, msg: k.message };
};

/**
 * Токены KinoPub (спец. §7.1–7.3): single-flight refresh, проактивное продление, регистрация устройства, выход.
 * Refresh ротирует пару и сразу убивает старую (research kinopub-api §4.5), поэтому он всегда один в полёте,
 * новая пара пишется в хранилище до того, как её увидят ждущие, и автоповтора нет (спец. §5.3, CM-01).
 */
export class AuthService implements TokenSource {
  onLoggedOut: ((reason: LogoutReason) => void) | undefined;

  private tokens: TokenStore;
  private clock: Clock;
  private log: Logger;
  private version: string;
  private api: KpApi | undefined;
  private inflight: Promise<void> | undefined;
  // Растёт при входе и выходе: результат refresh прежнего сеанса не записывается поверх нового состояния.
  private epoch = 0;

  constructor(deps: { tokens: TokenStore; clock: Clock; log: Logger; version: string }) {
    this.tokens = deps.tokens;
    this.clock = deps.clock;
    this.log = deps.log;
    this.version = deps.version;
  }

  bindApi(api: KpApi): void {
    this.api = api;
  }

  isLoggedIn(): boolean {
    return this.tokens.pair() !== undefined;
  }

  access(): { token: string; gen: number } | undefined {
    const p = this.tokens.pair();
    return p === undefined ? undefined : { token: p.access, gen: p.gen };
  }

  /**
   * Single-flight: идущий refresh общий для всех; пара новее `gen` — уже обновлена, запроса нет.
   * Отказ (`KP-AUTH`) — выход с `refresh-rejected`; иные ошибки пробрасываются, токены не трогаются.
   */
  refresh(gen: number): Promise<void> {
    if (this.inflight !== undefined) return this.inflight;
    const pair = this.tokens.pair();
    if (pair === undefined) return Promise.reject(new KpError("KP-AUTH", "no-token"));
    if (pair.gen > gen) return Promise.resolve();
    const p = this.rotate(pair).finally(() => {
      if (this.inflight === p) this.inflight = undefined;
    });
    this.inflight = p;
    return p;
  }

  /** Refresh, если access не переживёт `seconds`. Сетевой сбой не бросает (следующая попытка — по 401); отказ — `KP-AUTH`. */
  async ensureFreshFor(seconds: number): Promise<void> {
    const pair = this.tokens.pair();
    if (pair === undefined || pair.expiresAt - this.clock.now() >= seconds * 1000) return;
    try {
      await this.refresh(pair.gen);
    } catch (e) {
      if (isKpError(e) && e.code === "KP-AUTH") throw e;
      this.log.warn(TAG, "proactive_refresh_failed", errData(e));
    }
  }

  /** После `ready` (в фоне, не бросает): продлить токен; `device/notify` при смене версии; доделать устройство. */
  async onReady(): Promise<void> {
    if (!this.isLoggedIn()) return;
    try {
      await this.ensureFreshFor(READY_FRESH_SEC);
      const dev = this.tokens.device();
      const title = dev.title ?? DEFAULT_TITLE;
      if (dev.id === undefined) await this.setupDevice(title);
      else if (dev.notifiedVersion !== this.version) await this.notify(title, dev);
    } catch (e) {
      this.log.warn(TAG, "ready_failed", errData(e));
    }
  }

  /**
   * Спец. §7.1 п. 4: пара пишется первой, затем `notify` → `info` → настройки устройства → сверка.
   * Сбой шагов после записи пары логируется и не отменяет вход; `onReady` доделает недостающее.
   */
  async completeLogin(raw: TokenPairRaw, deviceTitle: string): Promise<void> {
    this.epoch += 1;
    const pair = this.tokens.save(raw);
    this.tokens.saveDevice({ title: deviceTitle });
    this.log.info(TAG, "login", { gen: pair.gen });
    await this.setupDevice(deviceTitle);
  }

  /** `device/unlink` (ошибка игнорируется) → удаление `kp.auth.*` → `onLoggedOut("logout")`. */
  async logout(): Promise<void> {
    if (this.isLoggedIn()) {
      try {
        await this.requireApi().deviceUnlink();
      } catch (e) {
        this.log.warn(TAG, "unlink_failed", errData(e));
      }
    }
    this.signOut("logout");
  }

  // --- Внутреннее ---

  private requireApi(): KpApi {
    if (this.api === undefined) throw new Error("AuthService: bindApi() was not called");
    return this.api;
  }

  private async rotate(pair: StoredPair): Promise<void> {
    const epoch = this.epoch;
    let raw: TokenPairRaw;
    try {
      raw = await this.requireApi().refreshToken(pair.refresh);
    } catch (e) {
      const err = toKpError(e);
      if (err.code === "KP-AUTH" && epoch === this.epoch) {
        this.log.warn(TAG, "refresh_rejected", errData(err));
        this.signOut("refresh-rejected");
      } else {
        this.log.warn(TAG, "refresh_failed", errData(err));
      }
      throw err;
    }
    if (epoch !== this.epoch) {
      this.log.info(TAG, "refresh_discarded", { gen: pair.gen });
      return;
    }
    const next = this.tokens.save(raw);
    this.log.info(TAG, "refreshed", { gen: next.gen });
  }

  private signOut(reason: LogoutReason): void {
    this.epoch += 1;
    this.tokens.removeAll();
    this.log.info(TAG, "logged_out", { reason });
    try {
      this.onLoggedOut?.(reason);
    } catch (e) {
      this.log.error(TAG, "on_logged_out_failed", errData(e));
    }
  }

  /** Записать устройство, только если сеанс не сменился (выход или новый вход во время запросов). */
  private saveDevice(epoch: number, d: StoredDevice): boolean {
    if (epoch !== this.epoch || !this.isLoggedIn()) return false;
    this.tokens.saveDevice(d);
    return true;
  }

  private async notify(title: string, dev: StoredDevice): Promise<void> {
    const epoch = this.epoch;
    try {
      await this.requireApi().deviceNotify(title, HARDWARE, `kpmsx-client/${this.version}`);
    } catch (e) {
      this.log.warn(TAG, "notify_failed", errData(e));
      return;
    }
    this.saveDevice(epoch, { ...dev, title, notifiedVersion: this.version });
  }

  private async setupDevice(title: string): Promise<void> {
    const api = this.requireApi();
    const epoch = this.epoch;
    const dev: StoredDevice = { title };
    try {
      await api.deviceNotify(title, HARDWARE, `kpmsx-client/${this.version}`);
      dev.notifiedVersion = this.version;
    } catch (e) {
      this.log.warn(TAG, "notify_failed", errData(e));
    }
    let info: DeviceInfo;
    try {
      info = await api.deviceInfo();
    } catch (e) {
      this.log.warn(TAG, "device_info_failed", errData(e));
      this.saveDevice(epoch, dev);
      return;
    }
    dev.id = info.id;
    if (!this.saveDevice(epoch, dev)) return;
    try {
      await api.deviceSettingsSave(info.id, DEVICE_SETTINGS);
      const check = await api.deviceInfo();
      const keys = SETTING_KEYS.filter((k) => check.settings[k] !== DEVICE_SETTINGS[k]);
      if (keys.length > 0) this.log.warn(TAG, "device_settings_mismatch", { keys });
      else this.log.info(TAG, "device_ready", { id: info.id });
    } catch (e) {
      this.log.warn(TAG, "device_settings_failed", errData(e));
    }
  }
}
