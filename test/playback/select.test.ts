import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Audio, FileInfo, Subtitle } from "../../src/api/models.ts";
import { DEFAULT_PREFS, type Prefs } from "../../src/playback/prefs.ts";
import { audioKey, pickAudio, pickFile, pickSubtitle, scoreAudio, selectPrefs, type SelectPrefs } from "../../src/playback/select.ts";

const BASE: SelectPrefs = { maxQuality: 1080, allowHevc: false, audioLang: "rus", audioAuthors: [], allowAc3: false, subsLang: "off" };

const QUALITY: Record<number, { w: number; h: number; quality: string }> = {
  1: { w: 720, h: 400, quality: "480p" },
  2: { w: 1280, h: 720, quality: "720p" },
  3: { w: 1920, h: 1080, quality: "1080p" },
  4: { w: 3840, h: 2160, quality: "2160p" },
};

let fileSeq = 0;
function file(qualityId: number, over: Partial<FileInfo> = {}): FileInfo {
  const n = ++fileSeq;
  return {
    codec: "h264",
    ...QUALITY[qualityId],
    qualityId,
    file: `/f/${n}.mp4`,
    urls: { hls: `https://cdn/hls/T/f/${n}.mp4/master-v1a1.m3u8?loc=nl`, hls2: "https://api/hls2/T/1.m3u8?loc=nl" },
    ...over,
  };
}

function audio(over: Partial<Audio>): Audio {
  return { id: 100 + (over.index ?? 1), index: 1, codec: "aac", channels: 2, lang: "rus", ...over };
}

function sub(lang: string, forced: boolean, n: number): Subtitle {
  return { lang, shift: 0, embed: false, forced, url: `https://cdn/pd/subtitle/T/${n}.srt` };
}

describe("selectPrefs", () => {
  it("takes global prefs and the per-title choices of this item only", () => {
    const p: Prefs = {
      ...DEFAULT_PREFS,
      audioType: 3,
      audioAuthors: [13, 51],
      subsLang: "rus",
      titleAudio: { "8632": "rus|3|13" },
      titleQuality: { "8632": 720 },
      titleSubs: { "8632": "eng" },
    };
    assert.deepEqual(selectPrefs(p, 8632), {
      maxQuality: 1080,
      allowHevc: false,
      audioLang: "rus",
      audioType: 3,
      audioAuthors: [13, 51],
      allowAc3: false,
      subsLang: "rus",
      titleAudioKey: "rus|3|13",
      titleQuality: 720,
      titleSubs: "eng",
    });
    assert.deepEqual(selectPrefs(p, 1), {
      maxQuality: 1080,
      allowHevc: false,
      audioLang: "rus",
      audioType: 3,
      audioAuthors: [13, 51],
      allowAc3: false,
      subsLang: "rus",
    });
  });

  it("does not share the authors array with prefs", () => {
    const p: Prefs = { ...DEFAULT_PREFS, audioAuthors: [13] };
    selectPrefs(p, 1).audioAuthors.push(99);
    assert.deepEqual(p.audioAuthors, [13]);
  });
});

describe("pickFile", () => {
  it("takes the highest quality at or below the 1080 ceiling", () => {
    const files = [file(1), file(2), file(3), file(4)];
    assert.equal(pickFile(files, BASE), files[2]);
    assert.equal(pickFile(files, { ...BASE, maxQuality: 720 }), files[1]);
    assert.equal(pickFile(files, { ...BASE, maxQuality: 2160 }), files[3]);
  });

  it("drops h265 when allowHevc is false", () => {
    const files = [file(3), file(4, { codec: "h265" })];
    assert.equal(pickFile(files, { ...BASE, maxQuality: 2160 }), files[0]);
    assert.equal(pickFile(files, { ...BASE, maxQuality: 2160, allowHevc: true }), files[1]);
  });

  it("falls back to h265 when there is no h264 file at all", () => {
    const files = [file(3, { codec: "h265" }), file(4, { codec: "h265" })];
    assert.equal(pickFile(files, BASE), files[0]);
  });

  it("treats anamorphic 1920x800 with quality_id 3 as 1080", () => {
    const files = [file(2, { w: 1280, h: 534 }), file(3, { w: 1920, h: 800 })];
    assert.equal(pickFile(files, BASE), files[1]);
    assert.equal(pickFile(files, { ...BASE, maxQuality: 720 }), files[0]);
  });

  it("skips files with an empty or missing url of the requested kind", () => {
    const files = [file(3, { urls: { hls: "", hls2: "https://api/hls2/T/1.m3u8" } }), file(2), file(1, { urls: { http: "https://cdn/pd/x.mp4" } })];
    assert.equal(pickFile(files, BASE), files[1]);
  });

  it("returns undefined when no file has a url of the requested kind", () => {
    const files = [file(3, { urls: { hls: "" } }), file(2, { urls: { http: "https://cdn/pd/x.mp4" } })];
    assert.equal(pickFile(files, BASE), undefined);
    assert.equal(pickFile([], BASE), undefined);
  });

  it("uses all files of a ladder from a card without links", () => {
    const files = [file(1, { urls: {} }), file(3, { urls: {} }), file(4, { urls: {} })];
    assert.equal(pickFile(files, BASE), files[1]);
  });

  it("selects by the requested kind", () => {
    const files = [file(3, { urls: { hls: "https://cdn/hls/a.m3u8" } }), file(2, { urls: { hls2: "https://api/hls2/T/1.m3u8" } })];
    assert.equal(pickFile(files, BASE, "hls2"), files[1]);
    assert.equal(pickFile(files, BASE, "hls"), files[0]);
  });

  it("takes the smallest quality when all files are above the ceiling", () => {
    const files = [file(4), file(3), file(2)];
    assert.equal(pickFile(files, { ...BASE, maxQuality: 480 }), files[2]);
  });

  it("lets the per-title quality override the ceiling", () => {
    const files = [file(1), file(2), file(3), file(4)];
    assert.equal(pickFile(files, { ...BASE, titleQuality: 720 }), files[1]);
    assert.equal(pickFile(files, { ...BASE, titleQuality: 2160, allowHevc: true }), files[3]);
  });

  it("prefers h264 over h265 at equal quality, then the first file", () => {
    const files = [file(3, { codec: "h265" }), file(3), file(3)];
    assert.equal(pickFile(files, { ...BASE, allowHevc: true }), files[1]);
  });
});

describe("audioKey", () => {
  it("is lang|typeId|authorId with empty parts for missing ids", () => {
    assert.equal(audioKey(audio({ lang: "rus", typeId: 3, authorId: 13 })), "rus|3|13");
    assert.equal(audioKey(audio({ lang: "eng", typeId: 6 })), "eng|6|");
    assert.equal(audioKey(audio({ lang: "rus" })), "rus||");
  });
});

describe("scoreAudio", () => {
  // Нейтральная строка: язык не совпадает, кодек не aac/ac3 — 0 баллов.
  const neutral = audio({ lang: "ukr", codec: "eac3", typeId: 4, authorId: 77 });

  it("gives zero to a row that matches nothing", () => {
    assert.equal(scoreAudio(neutral, BASE), 0);
    assert.equal(scoreAudio(audio({ lang: "ukr", codec: "eac3" }), BASE), 0);
  });

  it("+1000 for the per-title choice", () => {
    assert.equal(scoreAudio(neutral, { ...BASE, titleAudioKey: "ukr|4|77" }), 1000);
    assert.equal(scoreAudio(neutral, { ...BASE, titleAudioKey: "ukr|4|" }), 0);
  });

  it("+500 − 10·k for the author at position k", () => {
    assert.equal(scoreAudio(neutral, { ...BASE, audioAuthors: [77] }), 500);
    assert.equal(scoreAudio(neutral, { ...BASE, audioAuthors: [13, 77] }), 490);
    assert.equal(scoreAudio(neutral, { ...BASE, audioAuthors: [1, 2, 3, 4, 5, 6, 7, 8, 9, 77] }), 410);
    assert.equal(scoreAudio(audio({ lang: "ukr", codec: "eac3" }), { ...BASE, audioAuthors: [77] }), 0);
  });

  it("+100 for the preferred voiceover type", () => {
    assert.equal(scoreAudio(neutral, { ...BASE, audioType: 4 }), 100);
    assert.equal(scoreAudio(neutral, { ...BASE, audioType: 3 }), 0);
  });

  it("does not match a missing type against a missing preference", () => {
    assert.equal(scoreAudio(audio({ lang: "ukr", codec: "eac3" }), BASE), 0);
  });

  it("+50 for the preferred language", () => {
    assert.equal(scoreAudio(neutral, { ...BASE, audioLang: "ukr" }), 50);
  });

  it("+20 for aac", () => {
    assert.equal(scoreAudio({ ...neutral, codec: "aac" }, BASE), 20);
  });

  it("−300 for ac3 unless allowed", () => {
    assert.equal(scoreAudio({ ...neutral, codec: "ac3" }, BASE), -300);
    assert.equal(scoreAudio({ ...neutral, codec: "ac3" }, { ...BASE, allowAc3: true }), 0);
  });

  it("adds all rows up", () => {
    const a = audio({ lang: "rus", codec: "aac", typeId: 3, authorId: 13 });
    assert.equal(scoreAudio(a, { ...BASE, audioType: 3, audioAuthors: [13], titleAudioKey: "rus|3|13" }), 1000 + 500 + 100 + 50 + 20);
  });

  it("does not penalize a manually chosen ac3 row", () => {
    const a = audio({ lang: "eng", codec: "ac3", typeId: 6 });
    assert.equal(scoreAudio(a, { ...BASE, titleAudioKey: "eng|6|" }), 1000);
  });
});

describe("pickAudio", () => {
  it("returns undefined for no audios", () => {
    assert.equal(pickAudio([], BASE), undefined);
  });

  it("ac3 with the penalty loses to aac", () => {
    const audios = [audio({ index: 1, codec: "ac3", channels: 6 }), audio({ index: 2, codec: "aac" })];
    assert.equal(pickAudio(audios, BASE)?.index, 2);
    assert.equal(pickAudio([audios[0]!, { ...audios[1]!, codec: "mp3" }], { ...BASE, allowAc3: true })?.index, 1);
  });

  it("takes a manually chosen ac3 row", () => {
    const audios = [
      audio({ index: 1, codec: "aac", lang: "rus", typeId: 3, authorId: 13 }),
      audio({ index: 2, codec: "ac3", channels: 6, lang: "eng", typeId: 6 }),
    ];
    const p: SelectPrefs = { ...BASE, audioType: 3, audioAuthors: [13], titleAudioKey: "eng|6|" };
    assert.equal(pickAudio(audios, p)?.index, 2);
  });

  it("takes aac 2.0 with the smaller index when one voice comes in three rows", () => {
    const voice = { lang: "rus", typeId: 3, authorId: 13 };
    const audios = [
      audio({ index: 1, lang: "eng", typeId: 6 }),
      audio({ index: 4, codec: "ac3", channels: 6, ...voice }),
      audio({ index: 3, codec: "aac", channels: 6, ...voice }),
      audio({ index: 2, codec: "aac", channels: 2, ...voice }),
    ];
    for (const p of [{ ...BASE, audioAuthors: [13] }, { ...BASE, titleAudioKey: "rus|3|13" }]) {
      const a = pickAudio(audios, p);
      assert.equal(a?.index, 2);
      assert.equal(a?.channels, 2);
    }
  });

  it("prefers the author higher in the list", () => {
    const audios = [audio({ index: 1, authorId: 51 }), audio({ index: 2, authorId: 13 })];
    assert.equal(pickAudio(audios, { ...BASE, audioAuthors: [13, 51] })?.index, 2);
    assert.equal(pickAudio(audios, { ...BASE, audioAuthors: [51, 13] })?.index, 1);
  });

  it("breaks ties by the smaller index regardless of order", () => {
    const audios = [audio({ index: 7 }), audio({ index: 3 }), audio({ index: 5 })];
    assert.equal(pickAudio(audios, BASE)?.index, 3);
  });
});

describe("pickSubtitle", () => {
  const subs = [sub("eng", false, 1), sub("rus", true, 2), sub("rus", false, 3)];

  it("is off by default", () => {
    assert.equal(pickSubtitle(subs, BASE, "rus"), undefined);
    assert.equal(pickSubtitle(subs, BASE), undefined);
  });

  it("takes the non-forced row of subsLang", () => {
    assert.equal(pickSubtitle(subs, { ...BASE, subsLang: "rus" }, "rus"), subs[2]);
    assert.equal(pickSubtitle(subs, { ...BASE, subsLang: "eng" }, "rus"), subs[0]);
  });

  it("returns undefined when subsLang has no row", () => {
    assert.equal(pickSubtitle([sub("eng", false, 1)], { ...BASE, subsLang: "rus" }, "rus"), undefined);
  });

  it("per-title off wins over subsLang and forced rows", () => {
    assert.equal(pickSubtitle(subs, { ...BASE, subsLang: "rus", titleSubs: "off" }, "eng"), undefined);
  });

  it("per-title language wins over subsLang", () => {
    assert.equal(pickSubtitle(subs, { ...BASE, subsLang: "rus", titleSubs: "eng" }, "rus"), subs[0]);
  });

  it("takes the forced row of audioLang when the voice is in another language", () => {
    assert.equal(pickSubtitle(subs, BASE, "eng"), subs[1]);
    assert.equal(pickSubtitle([sub("eng", false, 1)], BASE, "eng"), undefined);
  });

  it("prefers the chosen language over forced rows", () => {
    assert.equal(pickSubtitle(subs, { ...BASE, subsLang: "eng" }, "eng"), subs[0]);
  });

  it("per-title <lang>.forced (panel S10) takes the forced row of that language, plain <lang> — the non-forced one", () => {
    const both = [sub("eng", false, 1), sub("eng", true, 2), sub("rus", false, 3)];
    assert.equal(pickSubtitle(both, { ...BASE, titleSubs: "eng.forced" }, "rus"), both[1]);
    assert.equal(pickSubtitle(both, { ...BASE, titleSubs: "eng" }, "rus"), both[0]);
    assert.equal(pickSubtitle(both, { ...BASE, subsLang: "rus", titleSubs: "ENG.forced" }, "rus"), both[1]);
  });

  it("per-title <lang>.forced without such a row falls back like a missing language", () => {
    const plain = [sub("eng", false, 1), sub("rus", true, 2)];
    assert.equal(pickSubtitle(plain, { ...BASE, titleSubs: "eng.forced" }, "rus"), undefined);
    assert.equal(pickSubtitle(plain, { ...BASE, titleSubs: "eng.forced" }, "eng"), plain[1]);
  });
});
