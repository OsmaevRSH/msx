import { FIX, findItem } from "./fixtures.ts";

// Состояние mock в памяти. Поля нужны этапам 6–8 и создаются здесь заранее, чтобы те этапы не правили этот файл.
// Времена, видимые в ответах API (created, updated, lastSeen), — Unix-секунды; expiresAt — мс эпохи.

export interface TokenRec { refresh: string; expiresAt: number; deviceId: number }
export interface DeviceCodeRec { userCode: string; polls: number; expiresAt: number }
export interface DeviceRec { title: string; hardware: string; software: string; settings: Record<string, number>; createdAt: number }
export interface WatchRec { time: number; status: -1 | 0 | 1; updated: number }
export interface HistoryRec { item: number; season: number; video: number; time: number; lastSeen: number }
export interface FolderRec { title: string; items: number[]; created: number }

export const DEFAULT_DEVICE_SETTINGS: Readonly<Record<string, number>> = {
  supportSsl: 1, supportHevc: 0, supportHdr: 0, support4k: 0, mixedPlaylist: 0,
};

/** Ключ `watching`: номера сезона и видео (не id); у фильма сезон 0. */
export function watchKey(item: number, season: number, video: number): string {
  return `${item}:${season}:${video}`;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

export class MockState {
  tokens = new Map<string, TokenRec>();          // access → запись
  refreshTokens = new Map<string, string>();     // refresh → access
  /** Монотонный счётчик id и имён токенов; reset() его не сбрасывает, чтобы старые токены не ожили. */
  seq = 100;
  deviceCodes = new Map<string, DeviceCodeRec>();
  devices = new Map<number, DeviceRec>();
  watching = new Map<string, WatchRec>();
  history: HistoryRec[] = [];
  folders = new Map<number, FolderRec>();
  newEpisodes = new Map<number, number>();

  constructor() {
    this.reset();
  }

  nextId(): number {
    this.seq += 1;
    return this.seq;
  }

  createDevice(d: { title: string; hardware: string; software: string }): number {
    const id = this.nextId();
    this.devices.set(id, { ...d, settings: { ...DEFAULT_DEVICE_SETTINGS }, createdAt: nowSec() });
    return id;
  }

  /** Новая пара синтетических токенов (короче 20 символов, правило §0.2 п. 5). */
  issueToken(deviceId: number, ttlSec: number): { access: string; refresh: string } {
    const n = this.nextId();
    const access = `mock-at-${n}`;
    const refresh = `mock-rt-${n}`;
    this.tokens.set(access, { refresh, expiresAt: Date.now() + ttlSec * 1000, deviceId });
    this.refreshTokens.set(refresh, access);
    return { access, refresh };
  }

  /** Действующий (известный и не просроченный) access или undefined. */
  tokenInfo(access: string): TokenRec | undefined {
    const rec = this.tokens.get(access);
    return rec && rec.expiresAt > Date.now() ? rec : undefined;
  }

  /** Все текущие access недействительны; refresh остаются рабочими. */
  expireAllAccess(): void {
    for (const rec of this.tokens.values()) rec.expiresAt = 0;
  }

  reset(): void {
    this.tokens.clear();
    this.refreshTokens.clear();
    this.deviceCodes.clear();
    this.devices.clear();
    this.watching.clear();
    this.history = [];
    this.folders.clear();
    this.newEpisodes.clear();

    const now = nowSec();
    const dur = (item: number, season: number, video: number): number => {
      const it = findItem(item);
      const unit = season === 0
        ? it?.videos?.find((v) => v.number === video)
        : it?.seasons?.find((s) => s.number === season)?.episodes.find((e) => e.number === video);
      if (!unit) throw new Error(`fixture unit ${item}:${season}:${video} not found`);
      return unit.duration;
    };
    const watched = (item: number, season: number, video: number, at: number): void => {
      this.watching.set(watchKey(item, season, video), { time: dur(item, season, video), status: 1, updated: at });
    };

    const big = FIX.SERIAL_BIG;
    for (const e of [1, 2, 3]) watched(big, 1, e, now - 3 * 86_400 + e * 3600);
    this.watching.set(watchKey(big, 1, 4), { time: 600, status: 0, updated: now - 3600 });
    this.watching.set(watchKey(FIX.MOVIE_SIMPLE, 0, 1), { time: 1200, status: 0, updated: now - 2 * 3600 });
    watched(FIX.SERIAL_SMALL, 1, 1, now - 3 * 3600);
    this.newEpisodes.set(big, 2);

    // Сначала самое свежее: SERIAL_BIG, MOVIE_SIMPLE, SERIAL_SMALL.
    this.history = [
      { item: big, season: 1, video: 4, time: 600, lastSeen: now - 3600 },
      { item: FIX.MOVIE_SIMPLE, season: 0, video: 1, time: 1200, lastSeen: now - 2 * 3600 },
      { item: FIX.SERIAL_SMALL, season: 1, video: 1, time: dur(FIX.SERIAL_SMALL, 1, 1), lastSeen: now - 3 * 3600 },
    ];
    this.folders.set(1, { title: "Избранное", items: [FIX.MOVIE_SIMPLE, big], created: now - 30 * 86_400 });
  }
}
