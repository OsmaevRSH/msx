import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Audio } from "../../src/api/models.ts";
import { KvStore } from "../../src/bridge/storage.ts";
import { DEFAULT_PREFS, PrefsStore, parseSubsValue, subsValue, type Prefs } from "../../src/playback/prefs.ts";
import { MemoryStorage } from "../helpers/memory-storage.ts";

function setup(): { mem: MemoryStorage; prefs: PrefsStore } {
  const mem = new MemoryStorage();
  return { mem, prefs: new PrefsStore(new KvStore(mem)) };
}

const stored = (mem: MemoryStorage): unknown => JSON.parse(mem.getItem("kp.cfg.prefs") ?? "null");

function audio(over: Partial<Audio>): Audio {
  return { id: 1, index: 1, codec: "aac", channels: 2, lang: "rus", ...over };
}

describe("DEFAULT_PREFS", () => {
  it("has the plan defaults: 1080p, no 4K/HEVC, Russian voice, subtitles off, automatic mode", () => {
    assert.deepEqual(DEFAULT_PREFS, {
      maxQuality: 1080,
      allowHevc: false,
      audioLang: "rus",
      audioAuthors: [],
      allowAc3: false,
      subsLang: "off",
      titleAudio: {},
      titleQuality: {},
      titleSubs: {},
      titleMode: {},
      bufferInit: 4,
      bufferResume: 6,
      posterSize: "medium",
      cardBackgrounds: false,
    });
  });

  it("cannot be mutated, nested values included", () => {
    assert.ok(Object.isFrozen(DEFAULT_PREFS));
    assert.ok(Object.isFrozen(DEFAULT_PREFS.audioAuthors));
    assert.ok(Object.isFrozen(DEFAULT_PREFS.titleAudio));
  });
});

describe("PrefsStore", () => {
  it("returns defaults on empty storage", () => {
    const { prefs, mem } = setup();
    assert.deepEqual(prefs.get(), DEFAULT_PREFS);
    assert.equal(mem.getItem("kp.cfg.prefs"), null);
  });

  it("update survives a new PrefsStore and stores only overrides in kp.cfg.prefs", () => {
    const { mem, prefs } = setup();
    prefs.update({ maxQuality: 720, loc: "nl", subsLang: "rus" });
    const again = new PrefsStore(new KvStore(mem));
    assert.deepEqual(again.get(), { ...DEFAULT_PREFS, maxQuality: 720, loc: "nl", subsLang: "rus" });
    assert.deepEqual(stored(mem), { maxQuality: 720, loc: "nl", subsLang: "rus" });
  });

  it("setting a default value drops the override; undefined clears an optional field", () => {
    const { mem, prefs } = setup();
    prefs.update({ maxQuality: 2160, audioType: 6, streamMode: "hls2" });
    prefs.update({ maxQuality: 1080, audioType: undefined });
    assert.deepEqual(stored(mem), { streamMode: "hls2" });
    prefs.update({ streamMode: undefined });
    assert.equal(mem.getItem("kp.cfg.prefs"), null);
    assert.deepEqual(prefs.get(), DEFAULT_PREFS);
  });

  it("ignores invalid values and keeps valid ones from the same patch", () => {
    const { prefs } = setup();
    prefs.update({
      maxQuality: 999 as Prefs["maxQuality"],
      bufferInit: 3 as Prefs["bufferInit"],
      subsLang: "fre" as Prefs["subsLang"],
      streamMode: "hls4" as Prefs["streamMode"],
      allowHevc: "yes" as unknown as boolean,
      audioLang: "",
      bufferResume: 10,
    });
    assert.deepEqual(prefs.get(), { ...DEFAULT_PREFS, bufferResume: 10 });
  });

  it("filters stored garbage", () => {
    const { mem, prefs } = setup();
    mem.setItem(
      "kp.cfg.prefs",
      JSON.stringify({
        maxQuality: 2160,
        posterSize: "huge",
        audioAuthors: [13, "x", 13, -1, 51],
        titleAudio: { "8632": "rus|3|13", "1": 5 },
        titleQuality: { "8632": 720, "2": 333 },
        titleMode: { "8632": "hls2", "3": "hls4" },
        bogus: true,
      }),
    );
    assert.deepEqual(prefs.get(), {
      ...DEFAULT_PREFS,
      maxQuality: 2160,
      audioAuthors: [13, 51],
      titleAudio: { "8632": "rus|3|13" },
      titleQuality: { "8632": 720 },
      titleMode: { "8632": "hls2" },
    });
    for (const raw of ["[1]", '"x"', "null", "{broken"]) {
      mem.setItem("kp.cfg.prefs", raw);
      assert.deepEqual(prefs.get(), DEFAULT_PREFS, raw);
    }
  });

  it("returns a fresh deep copy from get", () => {
    const { prefs } = setup();
    const a = prefs.get();
    a.audioAuthors.push(1);
    a.titleAudio["1"] = "x";
    a.maxQuality = 480;
    assert.deepEqual(prefs.get(), DEFAULT_PREFS);
  });
});

describe("PrefsStore.chooseAudio", () => {
  it("stores the audio key for the title and moves the author to the front", () => {
    const { prefs } = setup();
    prefs.chooseAudio(8632, audio({ lang: "rus", typeId: 3, authorId: 13 }));
    prefs.chooseAudio(100, audio({ lang: "rus", typeId: 4, authorId: 51 }));
    prefs.chooseAudio(200, audio({ lang: "rus", typeId: 3, authorId: 13 }));
    const p = prefs.get();
    assert.deepEqual(p.titleAudio, { "8632": "rus|3|13", "100": "rus|4|51", "200": "rus|3|13" });
    assert.deepEqual(p.audioAuthors, [13, 51]);
  });

  it("keeps at most 10 authors without repeats", () => {
    const { prefs } = setup();
    for (let id = 1; id <= 12; id++) prefs.chooseAudio(id, audio({ authorId: id }));
    prefs.chooseAudio(50, audio({ authorId: 5 }));
    assert.deepEqual(prefs.get().audioAuthors, [5, 12, 11, 10, 9, 8, 7, 6, 4, 3]);
  });

  it("keeps the authors list for a voice without an author", () => {
    const { prefs } = setup();
    prefs.chooseAudio(1, audio({ authorId: 13 }));
    prefs.chooseAudio(2, audio({ lang: "eng", typeId: 6 }));
    assert.deepEqual(prefs.get().audioAuthors, [13]);
    assert.equal(prefs.get().titleAudio["2"], "eng|6|");
  });

  it("survives a new PrefsStore", () => {
    const { mem, prefs } = setup();
    prefs.chooseAudio(8632, audio({ lang: "rus", typeId: 3, authorId: 13 }));
    const p = new PrefsStore(new KvStore(mem)).get();
    assert.equal(p.titleAudio["8632"], "rus|3|13");
    assert.deepEqual(p.audioAuthors, [13]);
  });
});

describe("PrefsStore.setTitle", () => {
  it("sets and clears quality, subtitles and mode per title", () => {
    const { mem, prefs } = setup();
    prefs.setTitle("quality", 8632, 720);
    prefs.setTitle("subs", 8632, "off");
    prefs.setTitle("mode", 8632, "hls2");
    prefs.setTitle("subs", 77, "eng");
    let p = new PrefsStore(new KvStore(mem)).get();
    assert.deepEqual(p.titleQuality, { "8632": 720 });
    assert.deepEqual(p.titleSubs, { "8632": "off", "77": "eng" });
    assert.deepEqual(p.titleMode, { "8632": "hls2" });

    prefs.setTitle("quality", 8632, undefined);
    prefs.setTitle("subs", 8632, undefined);
    prefs.setTitle("mode", 8632, undefined);
    p = prefs.get();
    assert.deepEqual(p.titleQuality, {});
    assert.deepEqual(p.titleSubs, { "77": "eng" });
    assert.deepEqual(p.titleMode, {});
  });

  it("ignores invalid values", () => {
    const { prefs } = setup();
    prefs.setTitle("quality", 1, 1000);
    prefs.setTitle("quality", 2, "720");
    prefs.setTitle("mode", 1, "hls4");
    prefs.setTitle("subs", 1, 5);
    prefs.setTitle("subs", 3, "");
    assert.deepEqual(prefs.get(), DEFAULT_PREFS);
  });
});

describe("titleSubs: a forced track of a language (stage 26)", () => {
  it("is the language code with the .forced suffix; a plain code and off keep their meaning", () => {
    assert.equal(subsValue({ lang: "eng", forced: true }), "eng.forced");
    assert.equal(subsValue({ lang: "rus", forced: false }), "rus");
    assert.deepEqual(parseSubsValue("eng.forced"), { lang: "eng", forced: true });
    assert.deepEqual(parseSubsValue("rus"), { lang: "rus", forced: false });
    assert.equal(parseSubsValue("off"), "off");
  });

  it("is stored per title like any other choice", () => {
    const { mem, prefs } = setup();
    prefs.setTitle("subs", 2004, subsValue({ lang: "eng", forced: true }));
    assert.deepEqual(new PrefsStore(new KvStore(mem)).get().titleSubs, { "2004": "eng.forced" });
  });
});
