// Языки дорожек по-русски (V-20) — один словарь для карточки, плеера, панелей S10 и настроек.

/** Код KinoPub → [озвучка, субтитры]: «Русский» / «Русские». */
const LANGS: Readonly<Record<string, readonly [string, string]>> = {
  rus: ["Русский", "Русские"], eng: ["Английский", "Английские"], ukr: ["Украинский", "Украинские"],
};
const FORCED = "только надписи";

/** Язык по коду в любом регистре: `0` — озвучки, `1` — субтитров; код вне словаря — заглавными. */
export function langName(code: string, kind: 0 | 1): string {
  const k = code.toLowerCase();
  return Object.prototype.hasOwnProperty.call(LANGS, k) ? (LANGS[k] as readonly [string, string])[kind] : code.toUpperCase();
}

/** «Английские», «Английские · только надписи». */
export function subsLabel(c: { lang: string; forced: boolean }): string {
  const name = langName(c.lang, 1);
  return c.forced ? `${name} · ${FORCED}` : name;
}
