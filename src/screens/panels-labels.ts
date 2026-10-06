import type { Audio } from "../api/models.ts";
import { langName, subsLabel } from "../core/lang.ts";
import type { StreamMode, SubsChoice } from "../playback/prefs.ts";

// Подписи панелей S10 и строк S12 по-русски: дорожки, каналы, страны CDN, способы воспроизведения; языки — core/lang.ts.

type Dict = Readonly<Record<string, string>>;

const CHANNELS: Readonly<Record<number, string>> = { 1: "моно", 2: "стерео", 6: "5.1", 8: "7.1" };
/** `references/server-location` отдаёт английские названия (`{location:"nl", name:"Netherlands"}`, kinopub-api). */
const COUNTRY: Dict = {
  nl: "Нидерланды", de: "Германия", ru: "Россия", fr: "Франция", fi: "Финляндия", gb: "Великобритания", us: "США",
  ua: "Украина", kz: "Казахстан", lv: "Латвия", lt: "Литва", ee: "Эстония", pl: "Польша", se: "Швеция",
};
/** `msx-gray` в панели — цвет её фона (rgb 51,51,51): строка не видна. Приглушённая — полупрозрачная белая. */
export const dim = (s: string): string => `{txt:msx-white-soft:${s}}`;
const TRACK = "Дорожка";
const RUS = "rus";

export const MODE_NAMES: Readonly<Record<StreamMode, string>> = { hls1: "Способ 1 (HLS1)", hls2: "Способ 2 (HLS2)" };

const word = (d: Dict, code: string): string | undefined => {
  const k = code.toLowerCase();
  return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : undefined;
};

/**
 * «Дубляж · Студия Альфа · стерео»: язык — только не русский или без типа и студии; AC3 помечен, а при выключенном
 * «Разрешить AC3» строка приглушена — AVPlay части ТВ его не играет (Plan B F12).
 */
export function audioName(a: Audio, allowAc3: boolean): string {
  const parts = [a.typeTitle, a.authorTitle].filter((s): s is string => s !== undefined && s !== "");
  const lang = a.lang === "" ? undefined : a.lang;
  if (lang !== undefined && (parts.length === 0 || lang.toLowerCase() !== RUS)) parts.push(langName(lang, 0));
  if (parts.length === 0) parts.push(`${TRACK} ${a.index}`);
  const ac3 = a.codec.toLowerCase() === "ac3";
  const sound = [CHANNELS[a.channels] ?? "", ac3 ? "AC3" : ""].filter((s) => s !== "").join(" ");
  const out = sound === "" ? parts.join(" · ") : `${parts.join(" · ")} · ${sound}`;
  return ac3 && !allowAc3 ? dim(out) : out;
}

/** «Английские», «Английские · только надписи»; языки вне словаря — кодом заглавными. */
export const subsName: (c: SubsChoice) => string = subsLabel;

/** V-22: папка закладок говорит, что сделает OK; ✓ у папки с тайтлом ставит `choicePanel`. */
export const folderName = (title: string, has: boolean): string => (has ? `${title} — убрать` : `☆ ${title} — добавить`);

/** Страна CDN по коду `location`; неизвестный код — название KinoPub как есть. */
export const countryName = (code: string, name: string): string => word(COUNTRY, code) ?? (name || code);
