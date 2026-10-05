import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import type { PlaybackSession } from "../../src/progress/session.ts";
import { chain, commitMsg, replaceContent, resolveAction } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { DEFAULT_PREFS } from "../../src/playback/prefs.ts";
import { withLoc } from "../../src/playback/url.ts";
import { encodeListKey, ids, listFlag, msgs } from "../../src/router/ids.ts";
import type { ListKey } from "../../src/router/ids.ts";
import { choicePanel, onPanelAct } from "../../src/screens/panels.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";

const P = TEST_P;
const A12 = FIX.MOVIE_AUDIO12;
const M12 = A12 * 1000 + 1;
const SIMPLE = FIX.MOVIE_SIMPLE;
const BIG = FIX.SERIAL_BIG;
const CHECK = "{ico:check} ";
const BACK_RELOAD = "[back|reload:content]";
const MOVIES: ListKey = { src: "catalog", type: "movie", sort: "-updated" };

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(): Promise<TestApp> {
  const t = await createTestApp({ loggedIn: true });
  apps.push(t);
  return t;
}

const panel = async (t: TestApp, type: string, ...args: (string | number)[]): Promise<MsxContentRoot> =>
  (await t.request(ids.panel(type, ...args))) as MsxContentRoot;
const rows = (s: MsxContentRoot): MsxContentItem[] => s.items ?? [];
const labels = (s: MsxContentRoot): (string | undefined)[] => rows(s).map((r) => r.label);
const row = (s: MsxContentRoot, label: string): MsxContentItem => {
  const found = rows(s).find((r) => r.label === label || r.label === CHECK + label);
  assert.ok(found, `no row ${label} in ${JSON.stringify(labels(s))}`);
  return found;
};
const current = (s: MsxContentRoot): (string | undefined)[] => labels(s).filter((l) => l?.startsWith(CHECK));
const act = (t: TestApp, name: string, ...args: (string | number)[]): Promise<void> =>
  t.run(onPanelAct(t.ctx, name, args.map(String)));
const actions = (t: TestApp): string[] => t.host.actions.map((a) => a.action);
const switchList = (k: ListKey, from: ListKey): string =>
  chain(["back", replaceContent(listFlag(encodeListKey(from)), P, ids.list(encodeListKey(k)))]);

/** Ошибка запроса `panel:` рисуется в панели: сетка 8, «Повторить» перезапрашивает панель (спец. §3.4, этап 17). */
function assertPanelError(s: MsxContentRoot, code: string): void {
  const items = s.pages?.[0]?.items ?? [];
  assert.equal(items[0]?.layout, "0,0,8,4");
  assert.match(String(items[0]?.text), new RegExp(code));
  assert.equal(items[1]?.action, "reload:panel");
  assert.equal(items[1]?.layout, "0,5,4,1");
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await realSleep(10);
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("choicePanel", () => {
  it("8×6 list of 8×1 buttons, not cached; the current row is marked and focused", async () => {
    const t = await make();
    const s = choicePanel(t.ctx, "Заголовок", [
      { label: "Один", action: "a1", current: false },
      { label: "Два", action: "a2", current: true },
    ]);
    assert.equal(s.type, "list");
    assert.equal(s.headline, "Заголовок");
    assert.equal(s.cache, false);
    assert.equal(s.reuse, false);
    assert.deepEqual(s.template, { type: "button", layout: "0,0,8,1" });
    assert.deepEqual(rows(s), [{ label: "Один", action: "a1" }, { label: `${CHECK}Два`, action: "a2", focus: true }]);
  });

  it("without rows — one «Назад», a page must have something to focus", async () => {
    const t = await make();
    assert.deepEqual(rows(choicePanel(t.ctx, "Пусто", [])), [{ label: "Нет вариантов", action: "back" }]);
  });
});

describe("panelScreen: sort and genre (S6)", () => {
  it("sort of «Фильмы»: six sorts, «Обновлённые» is current, «Рейтинг КП» replaces the list by its flag", async () => {
    const t = await make();
    const s = await panel(t, "sort", encodeListKey(MOVIES));
    assert.equal(s.headline, "Сортировка");
    assert.equal(rows(s).length, 6);
    assert.deepEqual(current(s), [`${CHECK}Обновлённые`]);
    const kp = row(s, "Рейтинг КП");
    assert.equal(kp.action, switchList({ ...MOVIES, sort: "-kinopoisk_rating" }, MOVIES));
    assert.equal(
      kp.action,
      `[back|replace:content:${listFlag(encodeListKey(MOVIES))}:request:interaction:list:${encodeListKey({ ...MOVIES, sort: "-kinopoisk_rating" })}@${P}]`,
    );
  });

  it("sort keeps the genre; a key without sort counts as «Обновлённые»", async () => {
    const t = await make();
    const from: ListKey = { src: "catalog", type: "serial", genre: "9" };
    const s = await panel(t, "sort", encodeListKey(from));
    assert.deepEqual(current(s), [`${CHECK}Обновлённые`]);
    assert.equal(row(s, "Год").action, switchList({ ...from, sort: "-year" }, from));
  });

  it("sort is only for the catalog: a shelf or a broken key is an error inside the panel", async () => {
    const t = await make();
    assertPanelError(await panel(t, "sort", encodeListKey({ src: "fresh", type: "movie" })), "KP-BAD");
    assertPanelError(await panel(t, "sort", "!!"), "KP-BAD");
  });

  it("genre: «Все жанры» (current) and /v1/genres of the key type; a choice keeps the sort", async () => {
    const t = await make();
    const s = await panel(t, "genre", encodeListKey(MOVIES));
    assert.equal(s.headline, "Жанр");
    assert.equal(rows(s).length, 31);
    assert.deepEqual(current(s), [`${CHECK}Все жанры`]);
    assert.equal(row(s, "Драма").action, switchList({ ...MOVIES, genre: "9" }, MOVIES));
    assert.ok(t.mock.calls().some((c) => c.path === "/v1/genres" && new URLSearchParams(c.query).get("type") === "movie"));
  });

  it("genre of a filtered shelf: the current genre is marked, «Все жанры» drops it", async () => {
    const t = await make();
    const from: ListKey = { src: "hot", type: "serial", genre: "23" };
    const s = await panel(t, "genre", encodeListKey(from));
    assert.deepEqual(current(s), [`${CHECK}Мультфильм`]);
    assert.equal(row(s, "Все жанры").action, switchList({ src: "hot", type: "serial" }, from));
  });

  it("genre when /v1/genres is down: the built-in movie list", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/genres$", drop: true }] });
    const s = await panel(t, "genre", encodeListKey(MOVIES));
    assert.equal(rows(s).length, 31);
    assert.equal(row(s, "Мультфильм").action, switchList({ ...MOVIES, genre: "23" }, MOVIES));
    assert.equal(labels(s)[1], "Аниме");
  });

  it("genre of documentaries without network: no built-in list — an error inside the panel", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: ".*", drop: true }] });
    assertPanelError(await panel(t, "genre", encodeListKey({ src: "catalog", type: "documovie,docuserial", sort: "-updated" })), "KP-NET");
  });
});

describe("panelScreen: audio, quality, subtitles (S10)", () => {
  it("audio of MOVIE_AUDIO12: 12 rows «type · author (LANG) · CODEC channels», AC3 may not play", async () => {
    const t = await make();
    const s = await panel(t, "audio", A12, M12, "c");
    assert.equal(s.headline, "Озвучка");
    assert.equal(rows(s).length, 12);
    assert.deepEqual(current(s), [`${CHECK}Дубляж · Студия Альфа (RUS) · AAC 2.0`]);
    assert.equal(labels(s)[1], "Дубляж · Студия Альфа (RUS) · AAC 5.1");
    assert.equal(labels(s)[2], "Дубляж · Студия Альфа (RUS) · AC3 5.1 · может не играть");
    assert.equal(labels(s)[9], "Оригинал (ENG) · AAC 2.0");
    assert.equal(labels(s).filter((l) => l?.endsWith("· может не играть")).length, 3);
    assert.equal(rows(s)[3].action, commitMsg(msgs.act("panel", "audio", A12, M12, 4, "c")));
  });

  it("audio choice before start: kept for the title, the card reloads", async () => {
    const t = await make();
    await panel(t, "audio", A12, M12, "c");
    await act(t, "audio", A12, M12, 4, "c");
    const p = t.ctx.prefs.get();
    assert.equal(p.titleAudio[String(A12)], "rus|2|12");
    assert.deepEqual(p.audioAuthors, [12]);
    assert.deepEqual(actions(t), [BACK_RELOAD]);
    assert.deepEqual(current(await panel(t, "audio", A12, M12, "c")), [`${CHECK}Многоголосый · Студия Бета (RUS) · AAC 2.0`]);
  });

  it("audio choice in the player: the same mid restarts from the player position", async () => {
    const t = await make();
    t.host.responses.set("video", { video: { data: { position: 321.7 } } });
    await act(t, "audio", A12, M12, 4, "p");
    assert.equal(t.ctx.prefs.get().titleAudio[String(A12)], "rus|2|12");
    assert.deepEqual(t.host.actions, [{
      action: chain(["cleanup", "player:eject", resolveAction(P, ids.playEp(A12, M12, 0, 1, { at: 321 }))]),
      data: { playerLabel: "Тестовый фильм «12 озвучек»" },
    }]);
    assert.match(actions(t)[0], /play:2004:2004001:0:1:at321@/);
  });

  it("in the player without video data — the last position of the tracker session, else 0", async () => {
    const t = await make();
    t.ctx.tracker.session = () => ({ mid: M12, lastPos: 77.9 }) as PlaybackSession;
    await act(t, "audio", A12, M12, 4, "p");
    assert.match(actions(t)[0], /:at77@/);
    t.host.clearActions();
    t.ctx.tracker.session = () => ({ mid: 1, lastPos: 500 }) as PlaybackSession;
    await act(t, "audio", A12, M12, 7, "p");
    assert.match(actions(t)[0], /:at0@/);
  });

  it("in the player, the voice that already plays: only close the panel", async () => {
    const t = await make();
    await act(t, "audio", A12, M12, 1, "p");
    assert.deepEqual(actions(t), ["back"]);
    assert.equal(t.ctx.prefs.get().titleAudio[String(A12)], "rus|1|11");
  });

  it("quality: «Авто (ceiling)» and the playable ladder, above the ceiling — gray", async () => {
    const t = await make();
    let s = await panel(t, "quality", A12, M12, "c");
    assert.equal(s.headline, "Качество");
    // HEVC выключен: 2160p есть только в HEVC — её нет в лестнице; 1080p (два файла) — одна строка.
    assert.deepEqual(labels(s), [`${CHECK}Авто (потолок 1080p)`, "1080p", "720p", "480p"]);
    assert.equal(rows(s)[2].action, commitMsg(msgs.act("panel", "quality", A12, M12, 720, "c")));
    assert.equal(rows(s)[0].action, commitMsg(msgs.act("panel", "quality", A12, M12, 0, "c")));
    t.ctx.prefs.update({ allowHevc: true, maxQuality: 720 });
    s = await panel(t, "quality", A12, M12, "p");
    assert.deepEqual(labels(s), [`${CHECK}Авто (потолок 720p)`, "{txt:msx-gray:2160p}", "{txt:msx-gray:1080p}", "720p", "480p"]);
  });

  it("quality choice: per title, «Авто» clears it; in the player — a restart only if the file changes", async () => {
    const t = await make();
    await act(t, "quality", A12, M12, 720, "c");
    assert.deepEqual(t.ctx.prefs.get().titleQuality, { [String(A12)]: 720 });
    assert.deepEqual(actions(t), [BACK_RELOAD]);
    assert.deepEqual(current(await panel(t, "quality", A12, M12, "c")), [`${CHECK}720p`]);
    t.host.clearActions();
    t.host.responses.set("video", { video: { data: { position: 10 } } });
    await act(t, "quality", A12, M12, 0, "p");
    assert.deepEqual(t.ctx.prefs.get().titleQuality, {});
    assert.match(actions(t)[0], /^\[cleanup\|player:eject\|video:resolve:.*play:2004:2004001:0:1:at10@/);
    t.host.clearActions();
    await act(t, "quality", A12, M12, 1080, "p");
    assert.deepEqual(actions(t), ["back"]);
  });

  it("subtitles: «Выключены» and languages of media-links, forced in a separate row", async () => {
    const t = await make();
    const s = await panel(t, "subs", A12, M12, "c");
    assert.equal(s.headline, "Субтитры");
    assert.deepEqual(labels(s), [`${CHECK}Выключены`, "RUS", "ENG", "ENG · форсированные", "UKR", "FRE"]);
    assert.equal(rows(s)[0].action, commitMsg(msgs.act("panel", "subs", A12, M12, "off", "c")));
    assert.equal(rows(s)[2].action, commitMsg(msgs.act("panel", "subs", A12, M12, "eng", "c")));
    assert.equal(rows(s)[3].action, commitMsg(msgs.act("panel", "subs", A12, M12, "eng.forced", "c")));
  });

  it("subtitles choice before start: kept for the title, a forced track too", async () => {
    const t = await make();
    await act(t, "subs", A12, M12, "eng", "c");
    assert.equal(t.ctx.prefs.get().titleSubs[String(A12)], "eng");
    assert.deepEqual(actions(t), [BACK_RELOAD]);
    assert.deepEqual(current(await panel(t, "subs", A12, M12, "c")), [`${CHECK}ENG`]);
    await act(t, "subs", A12, M12, "eng.forced", "c");
    assert.deepEqual(current(await panel(t, "subs", A12, M12, "c")), [`${CHECK}ENG · форсированные`]);
  });

  it("subtitles in the player: no restart — the track URL (with loc) goes to AVPlay", async () => {
    const t = await make();
    t.ctx.prefs.update({ loc: "de" });
    const links = await t.run(t.ctx.repo.links(M12, { cls: "fg" }));
    const url = (forced: boolean): string => {
      const sub = links.subtitles.find((x) => x.lang === "eng" && x.forced === forced);
      assert.ok(sub);
      return withLoc(sub.url, "de");
    };
    await act(t, "subs", A12, M12, "eng", "p");
    assert.deepEqual(actions(t), [chain([
      "back", "player:commit:message:tizen:subtitle:silent:false", `player:commit:message:tizen:subtitle:url:${url(false)}`,
    ])]);
    assert.ok(!actions(t)[0].includes("player:eject"));
    t.host.clearActions();
    await act(t, "subs", A12, M12, "eng.forced", "p");
    assert.ok(actions(t)[0].endsWith(`player:commit:message:tizen:subtitle:url:${url(true)}]`));
    t.host.clearActions();
    await act(t, "subs", A12, M12, "off", "p");
    assert.equal(t.ctx.prefs.get().titleSubs[String(A12)], "off");
    assert.deepEqual(actions(t), ["[back|player:commit:message:tizen:subtitle:silent:true]"]);
  });

  it("a unit of a removed title: an error inside the panel", async () => {
    const t = await make();
    assertPanelError(await panel(t, "audio", FIX.MOVIE_DELETED, FIX.MOVIE_DELETED * 1000 + 1, "c"), "KP-404");
    assertPanelError(await panel(t, "quality", A12, 1, "c"), "KP-404");
  });
});

describe("panelScreen: bookmarks (S10)", () => {
  it("folders with a mark where the title is; a marked folder removes, another adds", async () => {
    const t = await make();
    let s = await panel(t, "bookmarks", SIMPLE);
    assert.equal(s.headline, "Закладки");
    assert.deepEqual(labels(s), [`${CHECK}Избранное`]);
    assert.equal(rows(s)[0].action, commitMsg(msgs.act("panel", "bm", SIMPLE, 1, "remove")));
    s = await panel(t, "bookmarks", A12);
    assert.deepEqual(labels(s), ["Избранное"]);
    assert.equal(rows(s)[0].action, commitMsg(msgs.act("panel", "bm", A12, 1, "add")));
  });

  it("add: the folder in KinoPub has the title, panel and card reload, the panel shows the mark", async () => {
    const t = await make();
    await panel(t, "bookmarks", A12);
    await t.request(ids.item(A12));
    await act(t, "bm", A12, 1, "add");
    assert.ok(t.mock.state.folders.get(1)?.items.includes(A12));
    assert.deepEqual(actions(t), ["[reload:panel|reload:content]"]);
    assert.deepEqual(labels(await panel(t, "bookmarks", A12)), [`${CHECK}Избранное`]);
    assert.equal(t.ctx.repo.peekItem(A12)?.value.bookmarks.includes(1), true);
  });

  it("remove: the title leaves the folder", async () => {
    const t = await make();
    await act(t, "bm", SIMPLE, 1, "remove");
    assert.ok(!t.mock.state.folders.get(1)?.items.includes(SIMPLE));
    assert.deepEqual(labels(await panel(t, "bookmarks", SIMPLE)), ["Избранное"]);
  });

  it("no folders: «Создать папку „MSX“ и добавить» creates the folder and adds the title", async () => {
    const t = await make();
    t.mock.state.folders.clear();
    const s = await panel(t, "bookmarks", A12);
    assert.deepEqual(labels(s), ["Создать папку „MSX“ и добавить"]);
    assert.equal(rows(s)[0].action, commitMsg(msgs.act("panel", "bm", A12, 0, "create")));
    await act(t, "bm", A12, 0, "create");
    const folders = [...t.mock.state.folders.values()];
    assert.equal(folders.length, 1);
    assert.equal(folders[0].title, "MSX");
    assert.deepEqual(folders[0].items, [A12]);
    assert.deepEqual(actions(t), ["[reload:panel|reload:content]"]);
    assert.deepEqual(labels(await panel(t, "bookmarks", A12)), [`${CHECK}MSX`]);
  });

  it("a failed request: a message instead of reloads", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/bookmarks/add$", status: 500 }] });
    await act(t, "bm", A12, 1, "add");
    assert.equal(actions(t).length, 1);
    assert.match(actions(t)[0], /^info:/);
  });
});

describe("panelScreen: seasons, stream mode, CDN, settings", () => {
  it("seasons of SERIAL_BIG: «Сезон N · watched/total», the tab replaces by the current season flag", async () => {
    const t = await make();
    const s = await panel(t, "seasons", BIG, 1);
    assert.equal(s.headline, "Сезоны");
    assert.equal(rows(s).length, 10);
    assert.deepEqual(current(s), [`${CHECK}Сезон 1 · 3/20`]);
    assert.equal(labels(s)[2], "Сезон 3 · 0/20");
    assert.equal(rows(s)[2].action, chain(["back", replaceContent("ep_2001_1", P, ids.season(BIG, 3))]));
    const from5 = await panel(t, "seasons", BIG, 5);
    assert.equal(rows(from5)[0].action, `[back|replace:content:ep_2001_5:request:interaction:season:2001:1@${P}]`);
  });

  it("stream mode of the title: «Авто», «HLS1», «HLS2»; a manual mode is kept per title", async () => {
    const t = await make();
    let s = await panel(t, "mode", A12);
    assert.equal(s.headline, "Режим потока");
    assert.deepEqual(labels(s), [`${CHECK}Авто`, "HLS1", "HLS2"]);
    assert.equal(rows(s)[2].action, commitMsg(msgs.act("panel", "mode", A12, "hls2")));
    await act(t, "mode", A12, "hls2");
    assert.deepEqual(t.ctx.prefs.get().titleMode, { [String(A12)]: "hls2" });
    assert.deepEqual(actions(t), [BACK_RELOAD]);
    assert.deepEqual(current(await panel(t, "mode", A12)), [`${CHECK}HLS2`]);
    await act(t, "mode", A12, "auto");
    assert.deepEqual(t.ctx.prefs.get().titleMode, {});
    // Р-28: «Авто» тайтла — это настройка ТВ «Тип потока», если она выбрана вручную.
    t.ctx.prefs.update({ streamMode: "hls1" });
    s = await panel(t, "mode", A12);
    assert.equal(labels(s)[0], `${CHECK}Авто (настройка ТВ: HLS1)`);
  });

  it("CDN: «По умолчанию» names the location of the KinoPub device, then the reference list", async () => {
    const t = await make();
    const s = await panel(t, "loc");
    assert.equal(s.headline, "CDN-сервер");
    assert.deepEqual(labels(s), [`${CHECK}По умолчанию · Netherlands`, "Netherlands", "Germany", "Russia"]);
    assert.equal(rows(s)[0].action, commitMsg(msgs.act("panel", "loc", "default")));
    assert.equal(rows(s)[2].action, commitMsg(msgs.act("panel", "loc", "de")));
    await act(t, "loc", "de");
    assert.equal(t.ctx.prefs.get().loc, "de");
    assert.deepEqual(actions(t), [BACK_RELOAD]);
    assert.deepEqual(current(await panel(t, "loc")), [`${CHECK}Germany`]);
    await act(t, "loc", "default");
    assert.equal(t.ctx.prefs.get().loc, undefined);
  });

  it("CDN without device info: plain «По умолчанию»", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/device/info$", status: 500 }] });
    assert.equal(labels(await panel(t, "loc"))[0], `${CHECK}По умолчанию`);
  });

  it("setting:<key> is the settings panel (stage 31); an unknown type is an error inside the panel", async () => {
    const t = await make();
    assert.equal((await panel(t, "setting", "maxQuality")).headline, "Настройка");
    assertPanelError(await panel(t, "nope", 1), "KP-BAD");
  });
});

describe("onPanelAct: messages", () => {
  it("bad arguments and unknown names: a warning, nothing changes", async () => {
    const t = await make();
    await act(t, "audio", A12, M12, 99, "c");
    await act(t, "audio", "x", M12, 1, "c");
    await act(t, "quality", A12, M12, 720, "z");
    await act(t, "subs", A12, M12, "e:n", "c");
    await act(t, "mode", A12, "hls4");
    await act(t, "loc", "");
    await act(t, "bm", A12, 1, "toggle");
    await act(t, "nope");
    assert.deepEqual(actions(t), []);
    assert.deepEqual(t.ctx.prefs.get(), DEFAULT_PREFS);
    assert.ok(t.ctx.log.entries().filter((e) => e.tag === "panels" && e.level === "warn").length >= 8);
  });

  it("reaches the panel module through the router", async () => {
    const t = await make();
    t.app.handleData({ message: msgs.act("panel", "mode", A12, "hls1") });
    await until(() => t.host.actions.length > 0, "mode applied");
    assert.deepEqual(t.ctx.prefs.get().titleMode, { [String(A12)]: "hls1" });
  });
});
