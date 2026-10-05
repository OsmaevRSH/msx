import type { Audio, FileInfo, StreamKind, Subtitle } from "../api/models.ts";
import type { Prefs } from "./prefs.ts";
import { qualityOf } from "./url.ts";

/** Срез настроек для выбора файла, озвучки и субтитров одного тайтла (Plan B §5.4–5.6). */
export interface SelectPrefs {
  maxQuality: number;
  allowHevc: boolean;
  audioLang: string;
  audioType?: number;
  audioAuthors: number[];
  allowAc3: boolean;
  titleAudioKey?: string;
  titleQuality?: number;
  subsLang: string;
  titleSubs?: string;
}

export function selectPrefs(p: Prefs, itemId: number): SelectPrefs {
  const id = String(itemId);
  const out: SelectPrefs = {
    maxQuality: p.maxQuality,
    allowHevc: p.allowHevc,
    audioLang: p.audioLang,
    audioAuthors: [...p.audioAuthors],
    allowAc3: p.allowAc3,
    subsLang: p.subsLang,
  };
  if (p.audioType !== undefined) out.audioType = p.audioType;
  const titleAudioKey = p.titleAudio[id];
  if (titleAudioKey !== undefined) out.titleAudioKey = titleAudioKey;
  const titleQuality = p.titleQuality[id];
  if (titleQuality !== undefined) out.titleQuality = titleQuality;
  const titleSubs = p.titleSubs[id];
  if (titleSubs !== undefined) out.titleSubs = titleSubs;
  return out;
}

/** Ключ озвучки без кодека: одна озвучка в строках AAC 2.0, AAC 5.1 и AC3 даёт один ключ (Plan B §5.5, F12). */
export function audioKey(a: Audio): string {
  return `${a.lang}|${a.typeId ?? ""}|${a.authorId ?? ""}`;
}

const sameLang = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const nonEmpty = (u: string | undefined): boolean => typeof u === "string" && u !== "";
const hasAnyUrl = (f: FileInfo): boolean => Object.values(f.urls ?? {}).some(nonEmpty);
const isH264 = (codec: string): boolean => {
  const c = codec.toLowerCase();
  return c === "h264" || c.startsWith("avc");
};

/**
 * Plan B §5.4. Лестница `files[]` из карточки `nolinks=1` приходит без ссылок — тогда кандидаты все файлы
 * (подпись качества до запроса `media-links`).
 */
export function pickFile(files: FileInfo[], p: SelectPrefs, kind: StreamKind = "hls"): FileInfo | undefined {
  let cands = files.some(hasAnyUrl) ? files.filter((f) => nonEmpty(f.urls[kind])) : files.slice();
  if (!p.allowHevc) {
    // Тайтл только в HEVC лучше попробовать, чем не запускать: Tizen 2025–2026 декодирует HEVC аппаратно.
    const avc = cands.filter((f) => isH264(f.codec));
    if (avc.length > 0) cands = avc;
  }
  if (cands.length === 0) return undefined;
  const cap = p.titleQuality ?? p.maxQuality;
  const qualities = cands.map(qualityOf);
  const fit = qualities.filter((q) => q <= cap);
  const target = fit.length > 0 ? Math.max(...fit) : Math.min(...qualities);
  let best: FileInfo | undefined;
  for (const f of cands) {
    if (qualityOf(f) !== target) continue;
    if (best === undefined || (isH264(f.codec) && !isH264(best.codec))) best = f;
  }
  return best;
}

/** Таблица скоринга Plan B §5.5. Строка, выбранная вручную, не штрафуется за AC3: пользователь знает, что делает. */
export function scoreAudio(a: Audio, p: SelectPrefs): number {
  const codec = a.codec.toLowerCase();
  const manual = p.titleAudioKey !== undefined && audioKey(a) === p.titleAudioKey;
  let s = manual ? 1000 : 0;
  if (a.authorId !== undefined) {
    const k = p.audioAuthors.indexOf(a.authorId);
    if (k >= 0) s += 500 - 10 * k;
  }
  if (p.audioType !== undefined && a.typeId === p.audioType) s += 100;
  if (sameLang(a.lang, p.audioLang)) s += 50;
  if (codec === "aac") s += 20;
  if (codec === "ac3" && !p.allowAc3 && !manual) s -= 300;
  return s;
}

/** Максимум баллов; при равенстве — меньший `index`. */
export function pickAudio(audios: Audio[], p: SelectPrefs): Audio | undefined {
  let best: Audio | undefined;
  let bestScore = 0;
  for (const a of audios) {
    const s = scoreAudio(a, p);
    if (best === undefined || s > bestScore || (s === bestScore && a.index < best.index)) {
      best = a;
      bestScore = s;
    }
  }
  return best;
}

/**
 * Plan B §5.6: выбор для тайтла (`"off"` — без субтитров вовсе), иначе `subsLang`; если озвучка не на `audioLang`,
 * а выбранной дорожки нет — форсированные субтитры на `audioLang` (надписи и вставки на чужом языке).
 */
export function pickSubtitle(subs: Subtitle[], p: SelectPrefs, audioLang?: string): Subtitle | undefined {
  if (p.titleSubs === "off") return undefined;
  const lang = p.titleSubs ?? p.subsLang;
  if (lang !== "off") {
    const s = subs.find((x) => !x.forced && sameLang(x.lang, lang));
    if (s) return s;
  }
  if (audioLang === undefined || sameLang(audioLang, p.audioLang)) return undefined;
  return subs.find((x) => x.forced && sameLang(x.lang, p.audioLang));
}
