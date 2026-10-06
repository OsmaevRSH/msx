import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Flags } from "../../src/config/flags.ts";
import { resolveAction } from "../../src/msx/actions.ts";
import type { EpRef } from "../../src/playback/episodes.ts";
import { ids } from "../../src/router/ids.ts";
import {
  audioTitle,
  buildResolveResponse,
  contextFields,
  contextPlayerProps,
  dynamicProps,
  idleContextFields,
  playerProps,
  subsTitle,
} from "../../src/screens/player.ts";
import type { PlayerPropsInput, ResolvedPlay } from "../../src/screens/player.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

const P = TEST_P;
const ID = 8632;
const ep = (mid: number, season: number, video: number): EpRef => ({ itemId: ID, mid, season, video });
const S1E1 = ep(82468, 1, 1);
const S1E2 = ep(82469, 1, 2);
const S1E3 = ep(82470, 1, 3);

/** Эпизод S1E2 с соседями — как в примере спец. §9.2. */
const MIDDLE: PlayerPropsInput = { itemId: ID, ref: S1E2, duration: 3720, prev: S1E1, next: S1E3 };
const LAST: PlayerPropsInput = { itemId: ID, ref: S1E3, duration: 3720, prev: S1E2 };
const FIRST: PlayerPropsInput = { itemId: ID, ref: S1E1, duration: 3720, next: S1E2 };

const URL = "https://u.ams-static-14.cdntogo.net/hls/TOKEN/2/46/DBCtPgEVqLdlY5qQ5.mp4/master-v1a3.m3u8?loc=nl";

function resolved(over: Partial<ResolvedPlay> = {}): ResolvedPlay {
  return {
    url: URL, label: "Черное зеркало · 1 сезон, 2 серия", position: 1287, quality: "1080p", audio: "Кубик в Кубе",
    mode: "hls1", step: 1, props: MIDDLE, run: "r1", ...over,
  };
}

/**
 * Пример ответа спец. §9.2 с `@P` = адрес плагина. Отличие от примера — аргумент `p` у панелей плеера
 * (`panel:<тип>:<id>:<mid>:p`, план этапов 18 и 26: «в плеере» против «до старта»).
 */
const EXAMPLE: Record<string, string> = {
  "kp:i": "8632", "kp:m": "82469", "kp:s": "1", "kp:e": "2", "kp:d": "3720",
  "resume:position": "1287",
  "label:extension": "1080p · Кубик в Кубе",
  "control:type": "extended",
  "tizen:buffer:size:init": "4",
  "tizen:buffer:size:resume": "6",
  "tizen:buffer:timeout": "10",
  "button:content:icon": "audiotrack",
  "button:content:action": `panel:request:interaction:panel:audio:8632:82469:p@${P}`,
  "button:speed:icon": "subtitles",
  "button:speed:action": `panel:request:interaction:panel:subs:8632:82469:p@${P}`,
  "button:restart:icon": "hd",
  "button:restart:action": `panel:request:interaction:panel:quality:8632:82469:p@${P}`,
  "button:prev:icon": "default",
  "button:prev:action": `video:resolve:request:interaction:play:8632:82468:1:1@${P}`,
  "button:prev:key": "channel_down",
  "button:next:icon": "default",
  "button:next:action": `video:resolve:request:interaction:play:8632:82470:1:3@${P}`,
  "button:next:key": "channel_up",
  "trigger:complete": "player:button:next:execute",
  "trigger:back": "[interaction:commit:video|player:eject]",
  "trigger:60t": "[interaction:commit:video|player:ticking:restart]",
  "trigger:90%": "shot:interaction:commit:video",
};

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(flags: Partial<Flags> = {}): Promise<TestApp> {
  const t = await createTestApp({ loggedIn: true, flags });
  apps.push(t);
  return t;
}

const keys = (o: Record<string, string>, re: RegExp): string[] => Object.keys(o).filter((k) => re.test(k));
const PERCENT = /^trigger:\d+%$/;
const TICKS = /^trigger:\d+t$/;

describe("buildResolveResponse: example of spec §9.2 (S1E2 with neighbours)", () => {
  it("url, label and every key of the example with its value; plus only kp:n and the launch nonce kp:r", async () => {
    const t = await make();
    const res = buildResolveResponse(t.ctx, resolved());
    assert.equal(res.url, URL);
    assert.equal(res.label, "Черное зеркало · 1 сезон, 2 серия");
    assert.equal(res.error, undefined);
    const props = res.properties ?? {};
    for (const [k, v] of Object.entries(EXAMPLE)) assert.equal(props[k], v, k);
    assert.deepEqual(Object.keys(props).sort(), [...Object.keys(EXAMPLE), "kp:n", "kp:r"].sort());
    assert.equal(props["kp:n"], "1");
    assert.equal(props["kp:r"], "r1");
  });

  it("does not touch the mock: properties are built without network", async () => {
    const t = await make();
    buildResolveResponse(t.ctx, resolved());
    assert.equal(t.mock.calls().length, 0);
  });
});

describe("playerProps", () => {
  it("last episode: no button:next:*, trigger:complete is player:eject, kp:n 0", async () => {
    const t = await make();
    const p = playerProps(t.ctx, LAST);
    assert.deepEqual(keys(p, /^button:next:/), []);
    assert.equal(p["trigger:complete"], "player:eject");
    assert.equal(p["kp:n"], "0");
    assert.equal(p["button:prev:action"], resolveAction(P, ids.playEp(ID, S1E2.mid, 1, 2)));
  });

  it("first episode: no button:prev:*", async () => {
    const t = await make();
    const p = playerProps(t.ctx, FIRST);
    assert.deepEqual(keys(p, /^button:prev:/), []);
    assert.equal(p["button:next:key"], "channel_up");
  });

  it("a movie: season 0, no neighbours", async () => {
    const t = await make();
    const p = playerProps(t.ctx, { itemId: 2006, ref: { itemId: 2006, mid: 2006001, season: 0, video: 1 }, duration: 5400 });
    assert.equal(p["kp:s"], "0");
    assert.equal(p["kp:e"], "1");
    assert.deepEqual(keys(p, /^button:(next|prev):/), []);
    assert.equal(p["trigger:complete"], "player:eject");
    assert.equal(p["button:content:action"], `panel:request:interaction:panel:audio:2006:2006001:p@${P}`);
  });

  it("autonext resolve → trigger:complete resolves the next episode directly", async () => {
    const t = await make({ autonext: "resolve" });
    const p = playerProps(t.ctx, MIDDLE);
    assert.ok(p["trigger:complete"]?.startsWith("video:resolve:request:interaction:play:"));
    assert.equal(p["trigger:complete"], resolveAction(P, ids.playEp(ID, S1E3.mid, 1, 3)));
    assert.equal(p["button:next:action"], p["trigger:complete"]);
    assert.equal(playerProps(t.ctx, LAST)["trigger:complete"], "player:eject");
  });

  it("heartbeat timer → no tick and no percent heartbeat triggers", async () => {
    const t = await make({ heartbeat: "timer" });
    const p = playerProps(t.ctx, MIDDLE);
    assert.equal(p["trigger:60t"], undefined);
    assert.deepEqual(keys(p, TICKS), []);
    assert.deepEqual(keys(p, PERCENT), ["trigger:90%"]);
  });

  it("heartbeat percent → 19 percent triggers 5 %…95 %, no ticks", async () => {
    const t = await make({ heartbeat: "percent" });
    const p = playerProps(t.ctx, MIDDLE);
    const pct = keys(p, PERCENT);
    assert.equal(pct.length, 19);
    for (let n = 5; n <= 95; n += 5) assert.ok(p[`trigger:${n}%`]?.endsWith("interaction:commit:video"), `trigger:${n}%`);
    assert.equal(p["trigger:50%"], "interaction:commit:video");
    assert.equal(p["trigger:90%"], "shot:interaction:commit:video");
    assert.deepEqual(keys(p, TICKS), []);
  });

  it("ticks: 10 → trigger:10t instead of trigger:60t", async () => {
    const t = await make();
    const p = playerProps(t.ctx, { ...MIDDLE, ticks: 10 });
    assert.equal(p["trigger:10t"], "[interaction:commit:video|player:ticking:restart]");
    assert.equal(p["trigger:60t"], undefined);
  });

  it("tick count comes from the build (HEARTBEAT_TICKS, decision Р-26)", async () => {
    const t = await make();
    t.ctx.build.heartbeatTicks = 10;
    assert.deepEqual(keys(playerProps(t.ctx, MIDDLE), TICKS), ["trigger:10t"]);
  });

  it("events triggers → trigger:pause and trigger:stop send a snapshot; handleEvent → none", async () => {
    const t = await make({ events: "triggers" });
    const p = playerProps(t.ctx, MIDDLE);
    assert.equal(p["trigger:pause"], "interaction:commit:video");
    assert.equal(p["trigger:stop"], "interaction:commit:video");
    const d = playerProps((await make()).ctx, MIDDLE);
    assert.equal(d["trigger:pause"], undefined);
    assert.equal(d["trigger:stop"], undefined);
  });

  it("probe variant → kp:p", async () => {
    const t = await make();
    assert.equal(playerProps(t.ctx, { ...MIDDLE, probe: "ticks" })["kp:p"], "ticks");
    assert.equal(playerProps(t.ctx, MIDDLE)["kp:p"], undefined);
  });

  it("buffer sizes come from TV settings", async () => {
    const t = await make();
    t.ctx.prefs.update({ bufferInit: 2, bufferResume: 10 });
    const p = playerProps(t.ctx, MIDDLE);
    assert.equal(p["tizen:buffer:size:init"], "2");
    assert.equal(p["tizen:buffer:size:resume"], "10");
    assert.equal(p["tizen:buffer:timeout"], "10");
  });
});

describe("contextPlayerProps and contextFields (CDG-06, decision Р-18)", () => {
  it("the same keys as playerProps of an episode with both neighbours, values from {context:…}", async () => {
    const t = await make();
    const c = contextPlayerProps(t.ctx);
    assert.deepEqual(Object.keys(c).sort(), Object.keys(playerProps(t.ctx, MIDDLE)).sort());
    assert.equal(c["kp:i"], "{context:kid}");
    assert.equal(c["kp:m"], "{context:kmid}");
    assert.equal(c["kp:s"], "{context:ks}");
    assert.equal(c["kp:e"], "{context:ke}");
    assert.equal(c["kp:d"], "{context:kd}");
    assert.equal(c["kp:n"], "{context:kn}");
    assert.equal(c["kp:r"], undefined, "the launch nonce comes only from resolve (fix 34b)");
    assert.equal(c["button:next:action"], "{context:knextAction}");
    assert.equal(c["button:prev:action"], "{context:kprevAction}");
    assert.equal(c["trigger:complete"], "{context:kcomplete}");
    assert.equal(c["button:content:action"], `panel:request:interaction:panel:audio:{context:kid}:{context:kmid}:p@${P}`);
    assert.equal(c["trigger:back"], EXAMPLE["trigger:back"]);
    assert.equal(c["trigger:60t"], EXAMPLE["trigger:60t"]);
  });

  it("fields of the middle episode: neighbours' resolve actions and trigger:complete", async () => {
    const t = await make();
    assert.deepEqual(contextFields(t.ctx, MIDDLE), {
      kid: "8632", kmid: "82469", ks: "1", ke: "2", kd: "3720", kn: "1",
      knextAction: EXAMPLE["button:next:action"], kprevAction: EXAMPLE["button:prev:action"],
      kcomplete: "player:button:next:execute",
    });
  });

  it("a season tile that plays nothing (a way between parts): the same fields, actions are no-op [] (CNFR-16, Р-36)", async () => {
    const t = await make();
    const idle = idleContextFields();
    assert.deepEqual(Object.keys(idle).sort(), Object.keys(contextFields(t.ctx, MIDDLE)).sort());
    assert.ok(Object.values(idle).every((v) => typeof v === "string"));
    assert.deepEqual([idle.knextAction, idle.kprevAction, idle.kcomplete], ["[]", "[]", "[]"]);
  });

  it("the last episode gets knextAction [] (no-op) and kcomplete player:eject", async () => {
    const t = await make();
    const f = contextFields(t.ctx, LAST);
    assert.equal(f.knextAction, "[]");
    assert.equal(f.kcomplete, "player:eject");
    assert.equal(f.kn, "0");
    assert.equal(contextFields(t.ctx, FIRST).kprevAction, "[]");
  });

  it("substituting the fields gives the same values as playerProps", async () => {
    const t = await make({ autonext: "resolve" });
    for (const p of [MIDDLE, LAST, FIRST]) {
      const f = contextFields(t.ctx, p);
      const direct = playerProps(t.ctx, p);
      for (const [k, v] of Object.entries(contextPlayerProps(t.ctx))) {
        const filled = v.replace(/\{context:(\w+)\}/g, (_, name: string) => f[name] ?? "");
        if (direct[k] !== undefined) assert.equal(filled, direct[k], k);
        // Иконка и клавиша кнопки без соседа остаются в шаблоне, а её действие — пустое.
        else if (v.includes("{context:")) assert.equal(filled, "[]", `${k}: a missing neighbour is a no-op`);
      }
    }
  });
});

describe("dynamicProps", () => {
  const RETRY = "info:Предыдущий запуск не удался — пробую другой способ воспроизведения";

  it("step 1 hls1: position and label «quality · audio» without the stream mode (V-27)", async () => {
    const t = await make();
    const d = dynamicProps(t.ctx, resolved());
    assert.deepEqual(d, { "resume:position": "1287", "label:extension": "1080p · Кубик в Кубе", "kp:r": "r1" });
  });

  it("position none → \"none\"", async () => {
    const t = await make();
    assert.equal(dynamicProps(t.ctx, resolved({ position: "none" }))["resume:position"], "none");
  });

  it("step 2 → the same label, a toast without HLS1/HLS2", async () => {
    const t = await make();
    const d = dynamicProps(t.ctx, resolved({ step: 2 }));
    assert.equal(d["label:extension"], "1080p · Кубик в Кубе");
    assert.equal(d["trigger:load"], RETRY);
  });

  it("step 3 hls2 → «Авто», ADAPTIVE_INFO, toast", async () => {
    const t = await make();
    const d = dynamicProps(t.ctx, resolved({ step: 3, mode: "hls2", quality: "Авто", audio: "" }));
    assert.equal(d["label:extension"], "Авто");
    assert.equal(d["tizen:stream:ADAPTIVE_INFO"], "STARTBITRATE=HIGHEST");
    assert.equal(d["trigger:load"], RETRY);
  });

  it("hls2 on step 1 (flag or manual mode) → ADAPTIVE_INFO without a toast", async () => {
    const t = await make();
    const d = dynamicProps(t.ctx, resolved({ mode: "hls2", quality: "Авто", audio: "" }));
    assert.equal(d["label:extension"], "Авто");
    assert.equal(d["tizen:stream:ADAPTIVE_INFO"], "STARTBITRATE=HIGHEST");
    assert.equal(d["trigger:load"], undefined);
  });

  it("a «Диагностика» play (kp:p) keeps the stream mode in the label: it is a technical check", async () => {
    const t = await make();
    const d = dynamicProps(t.ctx, resolved({ mode: "hls2", quality: "Авто", audio: "", props: { ...MIDDLE, probe: "hls2" } }));
    assert.equal(d["label:extension"], "Авто · HLS2");
  });

  it("subtitles: url; delay in ms only when shift ≠ 0", async () => {
    const t = await make();
    const sub = { lang: "rus", shift: 0, embed: false, forced: false, url: "https://cdn.example/s/1.srt?loc=nl" };
    const d0 = dynamicProps(t.ctx, resolved({ subtitle: sub }));
    assert.equal(d0["tizen:subtitle:url"], sub.url);
    assert.equal(d0["tizen:subtitle:delay"], undefined);
    const d1 = dynamicProps(t.ctx, resolved({ subtitle: { ...sub, shift: -1.5 } }));
    assert.equal(d1["tizen:subtitle:delay"], "-1500");
  });
});

describe("buildResolveResponse and playerPropsIn", () => {
  it("resolve → static and dynamic properties together", async () => {
    const t = await make();
    const props = buildResolveResponse(t.ctx, resolved({ step: 2 })).properties ?? {};
    assert.equal(props["button:next:key"], "channel_up");
    assert.equal(props["trigger:load"], "info:Предыдущий запуск не удался — пробую другой способ воспроизведения");
  });

  it("item → only dynamic properties: no button:*, of kp:* only the launch nonce, no triggers but trigger:load", async () => {
    const t = await make({ playerPropsIn: "item" });
    const res = buildResolveResponse(t.ctx, resolved({ step: 2 }));
    const props = res.properties ?? {};
    assert.deepEqual(keys(props, /^button:/), []);
    // Nonce знает только resolve; не применит MSX свойства resolve — трекер возьмёт окно 10 с (фикс 34b).
    assert.deepEqual(keys(props, /^kp:/), ["kp:r"]);
    assert.deepEqual(keys(props, /^trigger:/), ["trigger:load"]);
    assert.equal(props["resume:position"], "1287");
    assert.equal(res.url, URL);
    assert.equal(res.label, "Черное зеркало · 1 сезон, 2 серия");
  });
});

describe("track names on the card and in the player (V-20)", () => {
  const audio = (lang: string, extra: { typeTitle?: string; authorTitle?: string } = {}) =>
    ({ id: 1, index: 1, codec: "aac", channels: 2, lang, ...extra });

  it("audio: studio, otherwise its type, otherwise the language in Russian; an unknown code in capitals", () => {
    assert.equal(audioTitle(audio("rus", { typeTitle: "Дубляж", authorTitle: "Студия Альфа" })), "Студия Альфа");
    assert.equal(audioTitle(audio("eng", { typeTitle: "Оригинал" })), "Оригинал");
    assert.deepEqual(["rus", "ENG", "ukr", "fre"].map((l) => audioTitle(audio(l))), ["Русский", "Английский", "Украинский", "FRE"]);
  });

  it("subtitles: plural language names, forced as «только надписи», off as «Выключены»", () => {
    assert.deepEqual(
      ["rus", "eng", "ukr", "fre"].map((lang) => subsTitle({ lang, forced: false })),
      ["Русские", "Английские", "Украинские", "FRE"],
    );
    assert.equal(subsTitle({ lang: "eng", forced: true }), "Английские · только надписи");
    assert.equal(subsTitle("off"), "Выключены");
  });
});
