import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as realSleep } from "node:timers/promises";
import type { PlaybackSession } from "../../src/progress/session.ts";
import { chain, commitMsg, replaceContent, replacePanel, resolveAction } from "../../src/msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { DEFAULT_PREFS } from "../../src/playback/prefs.ts";
import { withLoc } from "../../src/playback/url.ts";
import { encodeListKey, ids, listFlag, msgs } from "../../src/router/ids.ts";
import type { ListKey } from "../../src/router/ids.ts";
import { choicePanel, onPanelAct } from "../../src/screens/panels.ts";
import { FIX } from "../../tools/kpmock/fixtures.ts";
import { TEST_P, createTestApp } from "../helpers/harness.ts";
import type { TestApp } from "../helpers/harness.ts";
import { waitFor } from "../progress/progress-rig.ts";

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

  it("a layout of the rows: genres go in two columns of 4×1", async () => {
    const t = await make();
    const s = choicePanel(t.ctx, "Жанр", [{ label: "Один", action: "a1", current: false }], "0,0,4,1");
    assert.deepEqual(s.template, { type: "button", layout: "0,0,4,1" });
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

  it("genre: «Все жанры» (current) and /v1/genres of the key type in two columns; a choice keeps the sort", async () => {
    const t = await make();
    const s = await panel(t, "genre", encodeListKey(MOVIES));
    assert.equal(s.headline, "Жанр");
    assert.deepEqual(s.template, { type: "button", layout: "0,0,4,1" });
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

  it("genre when /v1/genres is down: the built-in movie list replaces the error panel", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/genres$", drop: true }] });
    // Повторы `TypeError` кончаются через 9 с, а ошибка в панели — через 6 с (V-40); встроенный список приходит заменой.
    assertPanelError(await panel(t, "genre", encodeListKey(MOVIES)), "KP-NET");
    await waitFor(t, () => actions(t).length > 0, "the late replace");
    assert.deepEqual(actions(t), [replacePanel("late_1", P, ids.panel("genre", encodeListKey(MOVIES)))]);
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
  it("audio of MOVIE_AUDIO12: a row per track «type · studio · channels», AC3 rows dimmed while AC3 is not allowed", async () => {
    const t = await make();
    let s = await panel(t, "audio", A12, M12, "c");
    assert.equal(s.headline, "Озвучка");
    assert.equal(rows(s).length, 12);
    assert.deepEqual(current(s), [`${CHECK}Дубляж · Студия Альфа · стерео`]);
    assert.equal(labels(s)[1], "Дубляж · Студия Альфа · 5.1");
    assert.equal(labels(s)[2], "{txt:msx-white-soft:Дубляж · Студия Альфа · 5.1 AC3}");
    assert.equal(labels(s)[8], "Многоголосый · Студия Эпсилон · Украинский · стерео");
    assert.equal(labels(s)[9], "Оригинал · Английский · стерео");
    assert.equal(labels(s).filter((l) => l?.startsWith("{txt:msx-white-soft:")).length, 3);
    assert.equal(rows(s)[3].action, commitMsg(msgs.act("panel", "audio", A12, M12, 4, "c")));
    t.ctx.prefs.update({ allowAc3: true });
    s = await panel(t, "audio", A12, M12, "c");
    assert.equal(labels(s)[2], "Дубляж · Студия Альфа · 5.1 AC3");
  });

  it("audio choice before start: kept for the title, the card reloads", async () => {
    const t = await make();
    await panel(t, "audio", A12, M12, "c");
    await act(t, "audio", A12, M12, 4, "c");
    const p = t.ctx.prefs.get();
    assert.equal(p.titleAudio[String(A12)], "rus|2|12");
    assert.deepEqual(p.audioAuthors, [12]);
    assert.deepEqual(actions(t), [BACK_RELOAD]);
    assert.deepEqual(current(await panel(t, "audio", A12, M12, "c")), [`${CHECK}Многоголосый · Студия Бета · стерео`]);
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

  it("a serial episode restarts with the label of resolve: «<title> · 1 сезон, 5 серия» (V-18)", async () => {
    const t = await make();
    t.host.responses.set("video", { video: { data: { position: 100 } } });
    await act(t, "quality", 2001, 2001005, 720, "p");
    assert.deepEqual(t.host.actions, [{
      action: chain(["cleanup", "player:eject", resolveAction(P, ids.playEp(2001, 2001005, 1, 5, { at: 100 }))]),
      data: { playerLabel: "Тестовый сериал «Большой» · 1 сезон, 5 серия" },
    }]);
  });

  it("in the player without video data — the last checked position of the tracker session", async () => {
    const t = await make();
    t.ctx.tracker.session = () => ({ mid: M12, lastPos: 77.9, peak: 90 }) as PlaybackSession;
    await act(t, "audio", A12, M12, 4, "p");
    assert.match(actions(t)[0], /:at77@/);
  });

  it("X-2: requestData fails — audio and quality restart from the session position, not from 0", async () => {
    const t = await make();
    t.host.responses.set("video", () => {
      throw new Error("no player data");
    });
    // «Продолжить»: проверенной позиции ещё нет, максимум сессии засеян `resume:position`.
    t.ctx.tracker.session = () => ({ mid: M12, peak: 1287 }) as PlaybackSession;
    await act(t, "audio", A12, M12, 4, "p");
    assert.match(actions(t)[0], /^\[cleanup\|player:eject\|video:resolve:.*play:2004:2004001:0:1:at1287@/);
    t.host.clearActions();
    t.ctx.tracker.session = () => ({ mid: M12, lastPos: 640.4, peak: 700 }) as PlaybackSession;
    await act(t, "quality", A12, M12, 720, "p");
    assert.match(actions(t)[0], /:at640@/);
  });

  it("X-2: the player answers 0 while «Продолжить» buffers — the session maximum, not 0", async () => {
    const t = await make();
    t.host.responses.set("video", { video: { data: { position: 0 } } });
    t.ctx.tracker.session = () => ({ mid: M12, peak: 1287 }) as PlaybackSession;
    await act(t, "audio", A12, M12, 4, "p");
    assert.match(actions(t)[0], /:at1287@/);
  });

  it("X-2: no session of this mid — the overlay position of this video", async () => {
    const t = await make();
    t.ctx.tracker.session = () => ({ mid: 1, lastPos: 500, peak: 500 }) as PlaybackSession;
    t.ctx.overlay.set(A12, 0, 1, { time: 912, status: 0 });
    await act(t, "audio", A12, M12, 4, "p");
    assert.match(actions(t)[0], /:at912@/);
  });

  it("X-2: no position at all — no restart from 0: the panel closes with a message, the choice is kept", async () => {
    const t = await make();
    t.ctx.tracker.session = () => undefined;
    t.ctx.overlay.set(A12, 0, 1, { time: 5900, status: 1 });
    await act(t, "audio", A12, M12, 4, "p");
    assert.equal(t.ctx.prefs.get().titleAudio[String(A12)], "rus|2|12");
    assert.deepEqual(actions(t), ["[back|info:Не удалось узнать позицию — выбор сработает при следующем запуске]"]);
    assert.ok(!actions(t)[0].includes("player:eject"));
  });

  it("in the player, the voice that already plays: only close the panel", async () => {
    const t = await make();
    await act(t, "audio", A12, M12, 1, "p");
    assert.deepEqual(actions(t), ["back"]);
    assert.equal(t.ctx.prefs.get().titleAudio[String(A12)], "rus|1|11");
  });

  it("quality: «Авто (до …p)» and the playable ladder, above the maximum — dimmed", async () => {
    const t = await make();
    let s = await panel(t, "quality", A12, M12, "c");
    assert.equal(s.headline, "Качество");
    // HEVC выключен: 2160p есть только в HEVC — её нет в лестнице; 1080p (два файла) — одна строка.
    assert.deepEqual(labels(s), [`${CHECK}Авто (до 1080p)`, "1080p", "720p", "480p"]);
    assert.equal(rows(s)[2].action, commitMsg(msgs.act("panel", "quality", A12, M12, 720, "c")));
    assert.equal(rows(s)[0].action, commitMsg(msgs.act("panel", "quality", A12, M12, 0, "c")));
    t.ctx.prefs.update({ allowHevc: true, maxQuality: 720 });
    s = await panel(t, "quality", A12, M12, "p");
    assert.deepEqual(labels(s), [`${CHECK}Авто (до 720p)`, "{txt:msx-white-soft:2160p}", "{txt:msx-white-soft:1080p}", "720p", "480p"]);
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

  it("subtitles: «Выключены» and languages of media-links in Russian, forced in a separate row", async () => {
    const t = await make();
    const s = await panel(t, "subs", A12, M12, "c");
    assert.equal(s.headline, "Субтитры");
    assert.deepEqual(labels(s), [`${CHECK}Выключены`, "Русские", "Английские", "Английские · только надписи", "Украинские", "FRE"]);
    assert.equal(rows(s)[0].action, commitMsg(msgs.act("panel", "subs", A12, M12, "off", "c")));
    assert.equal(rows(s)[2].action, commitMsg(msgs.act("panel", "subs", A12, M12, "eng", "c")));
    assert.equal(rows(s)[3].action, commitMsg(msgs.act("panel", "subs", A12, M12, "eng.forced", "c")));
  });

  it("subtitles choice before start: kept for the title, a forced track too", async () => {
    const t = await make();
    await act(t, "subs", A12, M12, "eng", "c");
    assert.equal(t.ctx.prefs.get().titleSubs[String(A12)], "eng");
    assert.deepEqual(actions(t), [BACK_RELOAD]);
    assert.deepEqual(current(await panel(t, "subs", A12, M12, "c")), [`${CHECK}Английские`]);
    await act(t, "subs", A12, M12, "eng.forced", "c");
    assert.deepEqual(current(await panel(t, "subs", A12, M12, "c")), [`${CHECK}Английские · только надписи`]);
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
  it("folders say what OK does: «✓ … — убрать» where the title is, «☆ … — добавить» elsewhere", async () => {
    const t = await make();
    let s = await panel(t, "bookmarks", SIMPLE);
    assert.equal(s.headline, "Закладки");
    assert.deepEqual(labels(s), [`${CHECK}Избранное — убрать`]);
    assert.equal(rows(s)[0].action, commitMsg(msgs.act("panel", "bm", SIMPLE, 1, "remove")));
    s = await panel(t, "bookmarks", A12);
    assert.deepEqual(labels(s), ["☆ Избранное — добавить"]);
    assert.equal(rows(s)[0].action, commitMsg(msgs.act("panel", "bm", A12, 1, "add")));
  });

  it("add: the folder in KinoPub has the title, panel and card reload, the panel shows the mark", async () => {
    const t = await make();
    await panel(t, "bookmarks", A12);
    await t.request(ids.item(A12));
    await act(t, "bm", A12, 1, "add");
    assert.ok(t.mock.state.folders.get(1)?.items.includes(A12));
    assert.deepEqual(actions(t), ["[reload:panel|reload:content]"]);
    assert.deepEqual(labels(await panel(t, "bookmarks", A12)), [`${CHECK}Избранное — убрать`]);
    assert.equal(t.ctx.repo.peekItem(A12)?.value.bookmarks.includes(1), true);
  });

  it("remove: the title leaves the folder", async () => {
    const t = await make();
    await act(t, "bm", SIMPLE, 1, "remove");
    assert.ok(!t.mock.state.folders.get(1)?.items.includes(SIMPLE));
    assert.deepEqual(labels(await panel(t, "bookmarks", SIMPLE)), ["☆ Избранное — добавить"]);
  });

  it("no folders: «Создать папку „MSX“ и добавить» creates the folder and adds the title", async () => {
    const t = await make();
    t.mock.state.folders.clear();
    await t.request(ids.item(A12));
    const s = await panel(t, "bookmarks", A12);
    assert.deepEqual(labels(s), ["Создать папку „MSX“ и добавить"]);
    assert.equal(rows(s)[0].action, commitMsg(msgs.act("panel", "bm", A12, 0, "create")));
    await act(t, "bm", A12, 0, "create");
    const folders = [...t.mock.state.folders.values()];
    assert.equal(folders.length, 1);
    assert.equal(folders[0].title, "MSX");
    assert.deepEqual(folders[0].items, [A12]);
    assert.deepEqual(actions(t), ["[reload:panel|reload:content]"]);
    assert.deepEqual(labels(await panel(t, "bookmarks", A12)), [`${CHECK}MSX — убрать`]);
  });

  it("the answer comes after the user left the card → the title is added, nothing is reloaded (spec §6.3)", async () => {
    const t = await make();
    await t.request(ids.item(A12));
    await panel(t, "bookmarks", A12);
    t.ctx.current.onRequest(ids.list("abc"));
    await act(t, "bm", A12, 1, "add");
    assert.ok(t.mock.state.folders.get(1)?.items.includes(A12));
    assert.deepEqual(actions(t), []);
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

  it("«Способ воспроизведения» of the title: «Авто», «Способ 1 (HLS1)», «Способ 2 (HLS2)»; a manual one is kept per title", async () => {
    const t = await make();
    let s = await panel(t, "mode", A12);
    assert.equal(s.headline, "Способ воспроизведения");
    assert.deepEqual(labels(s), [`${CHECK}Авто`, "Способ 1 (HLS1)", "Способ 2 (HLS2)"]);
    assert.equal(rows(s)[2].action, commitMsg(msgs.act("panel", "mode", A12, "hls2")));
    await act(t, "mode", A12, "hls2");
    assert.deepEqual(t.ctx.prefs.get().titleMode, { [String(A12)]: "hls2" });
    assert.deepEqual(actions(t), [BACK_RELOAD]);
    assert.deepEqual(current(await panel(t, "mode", A12)), [`${CHECK}Способ 2 (HLS2)`]);
    await act(t, "mode", A12, "auto");
    assert.deepEqual(t.ctx.prefs.get().titleMode, {});
    // Р-28: «Авто» тайтла — это способ из настроек ТВ, если он выбран вручную.
    t.ctx.prefs.update({ streamMode: "hls1" });
    s = await panel(t, "mode", A12);
    assert.equal(labels(s)[0], `${CHECK}Как в настройках: Способ 1 (HLS1)`);
  });

  it("CDN: «По умолчанию (<country of the KinoPub device>)», then the other countries in Russian", async () => {
    const t = await make();
    const s = await panel(t, "loc");
    assert.equal(s.headline, "CDN-сервер");
    assert.deepEqual(labels(s), [`${CHECK}По умолчанию (Нидерланды)`, "Германия", "Россия"]);
    assert.equal(rows(s)[0].action, commitMsg(msgs.act("panel", "loc", "default")));
    assert.equal(rows(s)[1].action, commitMsg(msgs.act("panel", "loc", "de")));
    await act(t, "loc", "de");
    assert.equal(t.ctx.prefs.get().loc, "de");
    assert.deepEqual(actions(t), [BACK_RELOAD]);
    assert.deepEqual(current(await panel(t, "loc")), [`${CHECK}Германия`]);
    await act(t, "loc", "default");
    assert.equal(t.ctx.prefs.get().loc, undefined);
  });

  it("CDN: the device country chosen by hand stays in the list with its mark", async () => {
    const t = await make();
    t.ctx.prefs.update({ loc: "nl" });
    assert.deepEqual(labels(await panel(t, "loc")), ["По умолчанию (Нидерланды)", `${CHECK}Нидерланды`, "Германия", "Россия"]);
  });

  it("CDN: the device location comes from the cached device info — opening the panel again does not wait for the API", async () => {
    const t = await make();
    await panel(t, "loc");
    t.mock.setScenario({ delayMs: 5_000 });
    assert.equal(labels(await panel(t, "loc"))[0], `${CHECK}По умолчанию (Нидерланды)`);
    assert.equal(t.mock.calls().filter((c) => c.path === "/v1/device/info").length, 1);
    t.mock.setScenario({ delayMs: 0 });
  });

  it("CDN without device info: plain «По умолчанию» and every country", async () => {
    const t = await make();
    t.mock.setScenario({ rules: [{ path: "^/v1/device/info$", status: 500 }] });
    assert.deepEqual(labels(await panel(t, "loc")), [`${CHECK}По умолчанию`, "Нидерланды", "Германия", "Россия"]);
  });

  it("setting:<key> is the settings panel (stage 31); an unknown type is an error inside the panel", async () => {
    const t = await make();
    assert.equal((await panel(t, "setting", "quality")).headline, "Максимальное качество");
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
