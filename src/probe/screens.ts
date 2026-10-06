import type { AppContext } from "../app/context.ts";
import type { MediaUnit } from "../api/models.ts";
import { KpError, toKpError } from "../core/errors.ts";
import { chain, commitMsg, contentAction, resolveAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot, MsxResolveResponse } from "../msx/types.ts";
import { findUnit, neighbours } from "../playback/episodes.ts";
import { resolveUnit } from "../playback/resolve.ts";
import type { ResolveOverrides } from "../playback/resolve.ts";
import { encodeListKey, ids, msgs } from "../router/ids.ts";
import type { ProbeVariant, Route } from "../router/ids.ts";
import { playerProps } from "../screens/player.ts";
import type { PlayerPropsInput } from "../screens/player.ts";
import { pickTestTitle } from "./checks-api.ts";
import { flagPanel, onFlagAct } from "./devflags.ts";
import { buildReport, checkLine, msxText, printReport, reportScreen } from "./report.ts";
import { API_CHECKS, CHECK_IDS } from "./runner.ts";
import type { CheckId, CheckResult } from "./runner.ts";
import type { TestTitle, UnitRef } from "./store.ts";
import { gridBegin, gridCheck } from "./tv-checks.ts";

// «Диагностика» (спец. §13, §16.2; решение Р-11): пробник Phase 0 одним экраном — строка на каждую CDG, кнопки
// проверок, плитки воспроизведения тестового тайтла, «Отчёт», «Отчёт в консоль», «Для разработчика», «Выйти».

export { devScreen } from "./devflags.ts";

const TAG = "probe";
const FLAG = "probe";
/** Без входа доступны только проверки без токена. */
const PUBLIC_CHECKS: readonly CheckId[] = ["CDG-01", "CDG-02", "CDG-09", "CDG-10"];
/** «Сетка 150» (CDG-12): обычный список «Фильмы» — догрузка порциями по 48 и префетч по фокусу. */
const gridKey = (): string => encodeListKey({ src: "catalog", type: "movie", sort: "-updated" });
/** CDG-07: 10 тиков вместо 60 — снимки идут чаще, проверка быстрее (спец. §16.2). */
const PROBE_TICKS = 10;
/** CDG-11: старт последней серии сезона за 20 с до конца. */
const AUTONEXT_LEAD_SEC = 20;

const T = {
  headline: "Диагностика",
  runApi: "Запустить проверки API",
  apiStarted: "Проверки API запущены",
  checkStarted: (id: string): string => `Проверка ${id} запущена`,
  persist: "Записать маркер хранилища",
  persisted: "Маркер записан: перезапустите MSX и откройте Диагностику",
  login: "Вход",
  report: "Отчёт",
  console: "Отчёт в консоль",
  consoleDone: "Отчёт выведен в консоль браузера",
  dev: "Для разработчика",
  logout: "Выйти из KinoPub (освободить слот)",
  a1: "a1",
  a2: "a2",
  hls2: "HLS2",
  props: "Свойства из resolve",
  ticks: "События и тики",
  autonext: "Автопереход",
  grid: "Сетка 150",
  title: (t: TestTitle): string =>
    `Тестовый тайтл: «${t.title}» S${t.s1e1.s}E${t.s1e1.e}; автопереход S${t.s1Last.s}E${t.s1Last.e} → S${t.s2e1.s}E${t.s2e1.e}`,
  noTitle: "Тестового тайтла нет: среди 10 свежих сериалов нет сериала с 2 сезонами и 2 озвучками",
  titleFailed: (code: string): string => `Тестовый тайтл не загружен: ${code}`,
  noSecondAudio: "У серии одна озвучка: плитке a2 нужна вторая",
};

/** Без `template` MSX не показывает `items` корня («Содержимое недоступно»); у элементов свои тип и раскладка. */
const ROW_TEMPLATE: MsxContentItem = { type: "control", layout: "0,0,12,1" };

const row = (text: string): MsxContentItem => ({ type: "space", layout: "0,0,12,1", text: msxText(text) });

function button(id: string, label: string, action: string, w = 4): MsxContentItem {
  return { id, type: "button", layout: `0,0,${w},1`, label, action };
}

/** Строка CDG; у проверок уровня API — запуск по нажатию. */
function checkRow(id: CheckId, r: CheckResult | undefined): MsxContentItem {
  const item: MsxContentItem = { id: `c_${id}`, type: "control", layout: "0,0,12,1", label: msxText(checkLine(id, r)) };
  if (API_CHECKS.includes(id)) item.action = chain([`info:${T.checkStarted(id)}`, commitMsg(msgs.act("probe", "run", id))]);
  return item;
}

async function playTiles(ctx: AppContext): Promise<MsxContentItem[]> {
  const grid = button("p_grid", T.grid, chain([commitMsg(msgs.act("probe", "grid")), contentAction(ctx.P, ids.list(gridKey()))]), 3);
  let title: TestTitle | undefined;
  try {
    title = await pickTestTitle(ctx);
  } catch (e) {
    const err = toKpError(e);
    ctx.log.warn(TAG, "test_title_failed", { err: err.code, msg: err.message });
    return [row(T.titleFailed(err.code)), grid];
  }
  if (title === undefined) return [row(T.noTitle), grid];
  const id = title.id;
  const play = (v: string, u: UnitRef): string => resolveAction(ctx.P, ids.probePlay(v, id, u.mid, u.s, u.e));
  const { s1e1, s1Last } = title;
  return [
    row(T.title(title)),
    button("p_a1", T.a1, play("a1", s1e1), 3),
    button("p_a2", T.a2, play("a2", s1e1), 3),
    button("p_hls2", T.hls2, play("hls2", s1e1), 3),
    button("p_props", T.props, play("props", s1e1), 3),
    button("p_ticks", T.ticks, play("ticks", s1e1), 3),
    button("p_autonext", T.autonext, play("autonext", s1Last), 3),
    grid,
  ];
}

/** `probe` — экран пробника; `probe:report:<n>` — страница отчёта; `probe:flag:<имя>` — панель переключателя. */
export async function probeScreen(ctx: AppContext, page?: string): Promise<MsxContentRoot> {
  gridCheck(ctx);
  const report = /^report:(\d+)$/.exec(page ?? "");
  if (report !== null) return reportScreen(ctx, Number(report[1]));
  if (page?.startsWith("flag:") === true) return flagPanel(ctx, page.slice("flag:".length));

  const logged = ctx.auth.isLoggedIn();
  const byId = new Map(ctx.probe!.results().map((r) => [r.id, r]));
  const items: MsxContentItem[] = (logged ? CHECK_IDS : PUBLIC_CHECKS).map((id) => checkRow(id, byId.get(id)));
  items.push(
    button("b_runApi", T.runApi, chain([`info:${T.apiStarted}`, commitMsg(msgs.act("probe", "runApi"))]), 6),
    button("b_persist", T.persist, commitMsg(msgs.act("probe", "persistWrite")), 6),
  );
  if (logged) items.push(...(await playTiles(ctx)));
  else items.push(button("b_login", T.login, contentAction(ctx.P, ids.login())));
  items.push(
    button("b_report", T.report, contentAction(ctx.P, ids.probe("report:1")), 3),
    button("b_console", T.console, commitMsg(msgs.act("probe", "console")), 3),
    button("b_dev", T.dev, contentAction(ctx.P, ids.dev()), 3),
  );
  if (logged) items.push(button("b_logout", T.logout, commitMsg(msgs.act("probe", "logout")), 6));
  return { type: "list", flag: FLAG, cache: false, reuse: false, headline: T.headline, extension: ctx.build.version, template: ROW_TEMPLATE, items };
}

/** Перерисовать «Диагностику», только если она всё ещё текущий экран (спец. §6.3, CD-16). */
function refresh(ctx: AppContext, toast?: string): void {
  const current = ctx.current.isCurrent(ids.probe());
  if (toast !== undefined) ctx.host.executeAction(current ? chain([`info:${toast}`, "reload:content"]) : `info:${toast}`);
  else if (current) ctx.host.executeAction("reload:content");
}

/** `act:probe:<name>:<args…>`. */
export async function onProbeAct(ctx: AppContext, name: string, args: string[]): Promise<void> {
  switch (name) {
    case "runApi":
      await ctx.probe!.runApi();
      refresh(ctx);
      return;
    case "run": {
      const id = API_CHECKS.find((c) => c === args[0]);
      if (id === undefined) break;
      await ctx.probe!.run(id);
      refresh(ctx);
      return;
    }
    case "persistWrite":
      ctx.probe!.persistWrite();
      refresh(ctx, T.persisted);
      return;
    case "console":
      gridCheck(ctx);
      printReport(buildReport(ctx));
      ctx.host.executeAction(`info:${T.consoleDone}`);
      return;
    case "grid":
      gridBegin(ctx);
      return;
    case "flag":
    case "flagsReset":
      onFlagAct(ctx, name, args);
      return;
    case "logout":
      // `device/unlink` и удаление токенов; меню перерисовывает обработчик выхода (`replace:menu`).
      await ctx.auth.logout();
      return;
  }
  ctx.log.warn(TAG, "unknown_act", { name, args });
}

type Forced = { o: ResolveOverrides; position: number | "none" } | { error: string };

/** Принудительные параметры плиток пробника поверх обычного resolve (спец. §16.2). */
function forced(unit: MediaUnit, variant: ProbeVariant): Forced {
  const audios = [...unit.audios].sort((a, b) => a.index - b.index);
  const o: ResolveOverrides = { probe: variant };
  switch (variant) {
    case "a1":
    case "props": {
      o.manual = "hls1";
      const first = audios[0];
      if (first !== undefined) o.audio = first;
      return { o, position: "none" };
    }
    case "a2": {
      const second = audios[1];
      if (second === undefined) return { error: T.noSecondAudio };
      o.manual = "hls1";
      o.audio = second;
      return { o, position: "none" };
    }
    case "hls2":
      o.manual = "hls2";
      return { o, position: "none" };
    case "ticks":
      o.ticks = PROBE_TICKS;
      return { o, position: "none" };
    case "autonext":
      return { o, position: Math.max(0, unit.duration - AUTONEXT_LEAD_SEC) };
  }
}

/**
 * `play:probe:<вариант>:…`: тот же resolve, что у обычного запуска, с параметрами варианта и `kp:p`. У плиток пробника
 * нет `properties`, поэтому при `playerPropsIn: item` статические свойства всё равно идут в ответе resolve.
 */
export async function probeResolve(ctx: AppContext, r: Route & { k: "probePlay" }): Promise<MsxResolveResponse> {
  const t0 = ctx.clock.perf();
  const item = (await ctx.repo.item(r.id)).value;
  const hit = findUnit(item, r.mid);
  if (hit === undefined) throw new KpError("KP-404", "unit-not-found", undefined, `mid ${r.mid}`);
  const f = forced(hit.unit, r.variant);
  if ("error" in f) return { error: f.error };
  const { o, position } = f;
  const res = await resolveUnit(ctx, item, hit.ref, position, { ...o, t0 });
  if (res.error !== undefined || ctx.flags.get().playerPropsIn === "resolve") return res;
  const input: PlayerPropsInput = { itemId: item.id, ref: hit.ref, duration: hit.unit.duration, probe: r.variant };
  const { prev, next } = neighbours(item, r.mid);
  if (prev !== undefined) input.prev = prev;
  if (next !== undefined) input.next = next;
  if (o.ticks !== undefined) input.ticks = o.ticks;
  return { ...res, properties: { ...playerProps(ctx, input), ...res.properties } };
}
