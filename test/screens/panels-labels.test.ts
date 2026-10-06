import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Audio } from "../../src/api/models.ts";
import { MODE_NAMES, audioName, countryName, folderName, subsName } from "../../src/screens/panels-labels.ts";

const audio = (o: Partial<Audio>): Audio => ({ id: 1, index: 1, codec: "aac", channels: 2, lang: "rus", ...o });
const DUB = { typeTitle: "Дубляж", authorTitle: "Студия Альфа" };

describe("panels-labels: voice-over rows (V-20)", () => {
  it("type · studio · channels, without language codes and codecs for Russian", () => {
    assert.equal(audioName(audio(DUB), false), "Дубляж · Студия Альфа · стерео");
    assert.equal(audioName(audio({ ...DUB, channels: 6 }), false), "Дубляж · Студия Альфа · 5.1");
    assert.equal(audioName(audio({ ...DUB, channels: 8 }), false), "Дубляж · Студия Альфа · 7.1");
    assert.equal(audioName(audio({ ...DUB, channels: 1 }), false), "Дубляж · Студия Альфа · моно");
    assert.equal(audioName(audio({ ...DUB, channels: 0 }), false), "Дубляж · Студия Альфа");
  });

  it("another language is named in Russian; a track without type and studio is its language", () => {
    assert.equal(audioName(audio({ typeTitle: "Оригинал", lang: "eng" }), false), "Оригинал · Английский · стерео");
    assert.equal(audioName(audio({ typeTitle: "Многоголосый", authorTitle: "Студия Эпсилон", lang: "UKR" }), false),
      "Многоголосый · Студия Эпсилон · Украинский · стерео");
    assert.equal(audioName(audio({}), false), "Русский · стерео");
    assert.equal(audioName(audio({ lang: "fre", channels: 6 }), false), "FRE · 5.1");
    assert.equal(audioName(audio({ lang: "", index: 3 }), false), "Дорожка 3 · стерео");
  });

  it("AC3 is marked; with «Разрешить AC3» off its rows are dimmed (msx-gray is the panel background)", () => {
    const ac3 = audio({ ...DUB, codec: "AC3", channels: 6 });
    assert.equal(audioName(ac3, true), "Дубляж · Студия Альфа · 5.1 AC3");
    assert.equal(audioName(ac3, false), "{txt:msx-white-soft:Дубляж · Студия Альфа · 5.1 AC3}");
  });
});

describe("panels-labels: subtitles, CDN, stream mode", () => {
  it("subtitles: «Русские», «Английские», «Украинские», other codes in capitals, forced — «только надписи»", () => {
    assert.equal(subsName({ lang: "rus", forced: false }), "Русские");
    assert.equal(subsName({ lang: "ENG", forced: false }), "Английские");
    assert.equal(subsName({ lang: "ukr", forced: false }), "Украинские");
    assert.equal(subsName({ lang: "eng", forced: true }), "Английские · только надписи");
    assert.equal(subsName({ lang: "fre", forced: false }), "FRE");
  });

  it("CDN countries by the location code in Russian; an unknown code keeps the KinoPub name", () => {
    assert.equal(countryName("nl", "Netherlands"), "Нидерланды");
    assert.equal(countryName("DE", "Germany"), "Германия");
    assert.equal(countryName("ru", "Russia"), "Россия");
    assert.equal(countryName("xx", "Atlantis"), "Atlantis");
    assert.equal(countryName("xx", ""), "xx");
    assert.equal(countryName("constructor", ""), "constructor");
  });

  it("bookmark folders say what OK does", () => {
    assert.equal(folderName("Избранное", true), "Избранное — убрать");
    assert.equal(folderName("Избранное", false), "☆ Избранное — добавить");
  });

  it("stream modes: «Способ 1 (HLS1)», «Способ 2 (HLS2)»", () => {
    assert.deepEqual(MODE_NAMES, { hls1: "Способ 1 (HLS1)", hls2: "Способ 2 (HLS2)" });
  });
});
