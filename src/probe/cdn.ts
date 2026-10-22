import type { AppContext } from "../app/context.ts";
import type { DeviceInfo, FileInfo, ServerLocation } from "../api/models.ts";
import type { KvStore } from "../bridge/storage.ts";
import { sleep } from "../core/clock.ts";
import { KpError, toKpError } from "../core/errors.ts";
import { fmtDate, fmtTime } from "../core/format.ts";
import { chain, commitMsg } from "../msx/actions.ts";
import { gridEdges } from "../msx/edges.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { qualityOf, withLoc } from "../playback/url.ts";
import { ids, msgs } from "../router/ids.ts";
import { countryName } from "../screens/panels-labels.ts";
import { saveDevice } from "../screens/settings.ts";
import { cspAllows } from "./cdn-hosts.ts";
import { Meter } from "./cdn-measure.ts";
import type { Accuracy, Measure } from "./cdn-measure.ts";

// «Скорость серверов KinoPub» (спец. §11 S12, §16.7): строка «Настроек» открывает экран `probe:cdn` из probe.js. Тест
// по очереди меряет каждую локацию `/v1/references/server-location` на одном потоке, подменяя в ссылке только `loc`
// (настройку устройства для замера не трогает), — `cdn-measure.ts`. Выбор строки или «Выбрать самый быстрый» пишет
// `serverLocation` своего устройства KinoPub и сверяет его чтением, как 4K и HEVC в S12; ссылки на поток в кэше
// устаревают, ручной `loc` этого ТВ (панель CDN, §9) снимается — иначе он перекрыл бы выбор.

export interface CdnRow extends Measure { code: string }
/** Запуск теста: `at` — эпоха, мс; `ms` — длительность; `stopped` — прерван стартом видео. */
export interface CdnRun { at: number; ms: number; bytes: number; rows: CdnRow[]; stopped?: "video" }

const TAG = "probe";
const FLAG = "cdn";
const KEY = "probe.cdn";
const MB = 1024 * 1024;
/** До 3 МБ с локации (плейлисты и сегменты), запросы по одному и не чаще 5 в секунду. */
const CAP_BYTES = 3 * MB;
const METER = { capBytes: CAP_BYTES, gapMs: 200, textCap: 512 * 1024, maxSegments: 3 };
/** Весь тест — около 30 с: срок локации — доля от них, но 5–10 с. */
const perLocation = (n: number): number => Math.min(10_000, Math.max(5_000, Math.floor(30_000 / Math.max(1, n))));
/** Фильмов «Новых фильмов», у которых ищется поток для замера. */
const SOURCE_TRIES = 3;
/** Скорости в пределах 10 % — равные: выбор по задержке, а текущий сервер остаётся (нет смысла переключать). */
const NEAR = 0.9;
const LAT_SLACK_MS = 5;
const DEVICE_WAIT_MS = 1500;
const LOC_CODE = /^[a-z0-9_-]+$/i;
const CHECK = "{ico:check} ";
/**
 * Сжатый корень 16×8 (`compress`, как у сезонов): заголовок, 3 сервера и 2 действия — 6 строк — с обоими стражами краёв
 * помещаются на один экран (без сжатия строк 6, и последняя уходила бы на вторую страницу к стражу). Заголовок группы —
 * в нижней части своей строки (V-33); на половине сжатой строки его буквы обрезались.
 */
const GRID = { width: 16, height: 8, w: 16, h: 1 };
const ROW = "0,0,16,1";
const GROUP_OFFSET = "0,0.3,0,-0.3";

const T = {
  headline: "Скорость серверов KinoPub", run: "Проверить", running: "Идёт проверка…",
  started: "Проверка серверов: 10–30 секунд", already: "Проверка уже идёт", stopVideo: "Сначала закройте видео",
  best: "Выбрать самый быстрый", noRun: "Сначала проверьте", isBest: "Текущий — самый быстрый",
  noCompare: "Без CORS не сравнить — выберите строку", noAnswers: "Нет ответов — проверьте VPN",
  fastest: " · самый быстрый", dash: "—", applied: "CDN-сервер", stopped: "Проверка прервана: началось видео",
  bestNow: "Быстрее всех", curBest: "Текущий сервер — самый быстрый", unknown: "Сравнить не удалось — см. таблицу",
  runFailed: "Проверка не удалась", setFailed: "Сервер не сменён",
  legend: "Серверы: задержка · скорость · первый сегмент",
  legendNode: "Серверы: ≈ задержка до CDN — без CORS скорость не измерить",
  legendFront: "Серверы: ≈ задержка до плейлистов — без CORS сам CDN не виден",
  noSpeed: "скорость не измерена", playlists: "до плейлистов", seg: "сегмент", noLocs: "KinoPub не отдал список серверов",
};
const ERRORS: Record<string, string> = { net: "нет ответа", timeout: "нет ответа за срок", csp: "хост не разрешён (CSP)", format: "не плейлист" };

const runs = new WeakMap<AppContext, Promise<CdnRun>>();

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const usable = (locs: ServerLocation[]): ServerLocation[] => locs.filter((l) => LOC_CODE.test(l.location));
const playing = (ctx: AppContext): boolean => ctx.tracker.session() !== undefined;
const dec = (n: number, d: number): string => n.toFixed(d).replace(".", ",");
const rowId = (code: string): string => `cdn_${code.replace(/[^A-Za-z0-9_]/g, "_")}`;
const setAct = (code: string): string => commitMsg(msgs.act("probe", "cdnSet", code));
const lat = (r: CdnRow): number => r.latencyMs ?? Number.POSITIVE_INFINITY;
/**
 * Сбой — уведомлением с кодом (§12): тексты S14 живут в модуле экрана ошибки app.js, а каждый модуль, который берёт
 * probe.js, остаётся в app.js целиком со всеми экспортами (+0,2 КБ gzip за этот).
 */
const failed = (what: string, e: unknown): string => `${what}: ${toKpError(e).code}`;

// --- Хранение: последний запуск в `kp.cfg.probe.cdn` ---

export function loadRun(store: KvStore): CdnRun | undefined {
  const raw = store.get<unknown>("cfg", KEY);
  return isObj(raw) && Array.isArray(raw.rows) && typeof raw.at === "number" ? (raw as unknown as CdnRun) : undefined;
}

// --- Метрики ---

/**
 * Самый быстрый сервер: по скорости, а у равных (±10 %) — по задержке; текущий среди равных остаётся. Без скорости —
 * по задержке до узла CDN. Задержка до фронт-хоста (`front`) — не о локации: такие строки не сравниваются.
 */
export function bestOf(rows: readonly CdnRow[], current?: string): string | undefined {
  const ok = rows.filter((r) => r.ok && r.acc !== "front" && r.latencyMs !== undefined);
  const fast = ok.filter((r) => r.mbps !== undefined);
  let near: CdnRow[];
  if (fast.length > 0) {
    const top = Math.max(...fast.map((r) => r.mbps as number));
    near = fast.filter((r) => (r.mbps as number) >= top * NEAR);
  } else {
    if (ok.length === 0) return undefined;
    const min = Math.min(...ok.map(lat));
    near = ok.filter((r) => lat(r) <= min / NEAR + LAT_SLACK_MS);
  }
  if (current !== undefined && near.some((r) => r.code === current)) return current;
  return near.reduce((a, b) => (lat(b) < lat(a) || (lat(b) === lat(a) && (b.mbps ?? 0) > (a.mbps ?? 0)) ? b : a)).code;
}

const fmtMb = (bytes: number): string => `${dec(bytes / MB, 1)} МБ`;
const fmtSec = (ms: number): string => `${dec(ms / 1000, 1)} с`;
const fmtMbps = (v: number): string => `${v < 10 ? dec(v, 1) : String(Math.round(v))} Мбит/с`;

/** Ячейки строки: «42 мс · 38 Мбит/с · сегмент 0,7 с»; без CORS — «≈ 42 мс · …»; сбой — его причина. */
export function rowText(r: CdnRow | undefined): string {
  if (r === undefined) return T.dash;
  if (!r.ok) return r.err === undefined ? T.dash : ERRORS[r.err] ?? `ошибка ${r.err.replace("http-", "")}`;
  const ms = `${r.latencyMs ?? 0} мс`;
  if (r.acc === "full" && r.mbps !== undefined) {
    return [ms, fmtMbps(r.mbps), ...(r.segMs === undefined ? [] : [`${T.seg} ${fmtSec(r.segMs)}`])].join(" · ");
  }
  return `≈ ${ms} · ${r.acc === "front" ? T.playlists : T.noSpeed}`;
}

/** Худшая точность запуска — для подписи столбцов. */
function worst(run: CdnRun | undefined): Accuracy {
  const accs = (run?.rows ?? []).filter((r) => r.ok).map((r) => r.acc);
  return accs.includes("front") ? "front" : accs.includes("node") ? "node" : "full";
}

// --- Запуск ---

/** AVC ближе всего к 720p: 10-секундный сегмент (≈ 2,8 МБ) целиком укладывается в лимит. */
function pickFile(files: FileInfo[]): FileInfo | undefined {
  const avc = files.filter((f) => /^(h264|avc)/i.test(f.codec));
  return [...(avc.length > 0 ? avc : files)].sort((a, b) => Math.abs(qualityOf(a) - 720) - Math.abs(qualityOf(b) - 720))[0];
}

/** Поток для замера — фильм из «Новых фильмов» (полка обычно уже в кэше главной): `hls`, иначе `hls2`, иначе файл. */
async function testStream(ctx: AppContext): Promise<string> {
  for (const it of (await ctx.repo.shelf("fresh", "movie")).value.slice(0, SOURCE_TRIES)) {
    const unit = (await ctx.repo.item(it.id)).value.videos[0];
    if (unit === undefined) continue;
    const f = pickFile((await ctx.repo.links(unit.id, { cls: "fg" })).files);
    const url = f?.urls.hls || f?.urls.hls2 || f?.urls.http;
    if (url) return url;
  }
  throw new KpError("KP-404", "no-test-stream");
}

async function measureAll(ctx: AppContext): Promise<CdnRun> {
  const locs = usable((await ctx.repo.serverLocations()).value);
  if (locs.length === 0) throw new KpError("KP-404", "no-server-locations");
  const url = await testStream(ctx);
  const apis = [ctx.build.apiBase, ctx.build.apiFallbackBase];
  const meter = new Meter({ fetch: ctx.fetch, clock: ctx.clock, allow: (u) => cspAllows(u, apis) }, { ...METER, deadlineMs: perLocation(locs.length) });
  const t0 = ctx.clock.perf();
  const run: CdnRun = { at: ctx.clock.now(), ms: 0, bytes: 0, rows: [] };
  for (const l of locs) {
    // Видео не делит канал с тестом: начавшееся видео прерывает его.
    if (playing(ctx)) {
      run.stopped = "video";
      break;
    }
    const m = await meter.measure(withLoc(url, l.location));
    run.rows.push({ code: l.location, ...m });
    run.bytes += m.bytes;
    ctx.log.info(TAG, "cdn_loc", {
      loc: l.location, ok: m.ok, acc: m.acc, ms: m.latencyMs, mbps: m.mbps === undefined ? undefined : Math.round(m.mbps * 10) / 10,
      seg: m.segMs, kb: Math.round(m.bytes / 1024), host: m.host, err: m.err,
    });
  }
  run.ms = Math.round(ctx.clock.perf() - t0);
  ctx.store.set("cfg", KEY, run);
  return run;
}

/** Один запуск на приложение: повторный вызов, пока идёт прежний, получает его результат. */
export function runCdn(ctx: AppContext): Promise<CdnRun> {
  let p = runs.get(ctx);
  if (p === undefined) {
    p = measureAll(ctx).finally(() => runs.delete(ctx));
    runs.set(ctx, p);
  }
  return p;
}

// --- Выбор сервера ---

/**
 * `serverLocation` своего устройства KinoPub — полной формой настроек, как 4K и HEVC (`saveDevice`, SET-3): ссылки на
 * поток в кэше устаревают (Plan B §7.3), сверка свежим чтением (Plan B §6.2.1). Ручной `loc` этого ТВ снимается.
 */
export async function applyLocation(ctx: AppContext, code: string): Promise<ServerLocation> {
  const l = usable((await ctx.repo.serverLocations()).value).find((x) => x.location === code);
  if (l === undefined) throw new KpError("KP-BAD", "unknown-location", undefined, code);
  if ((await ctx.repo.deviceInfo()).value.location?.id !== l.id) await saveDevice(ctx, { serverLocation: l.id });
  if (ctx.prefs.get().loc !== undefined) {
    ctx.prefs.update({ loc: undefined });
    ctx.repo.invalidateAfterDevice();
  }
  ctx.log.info(TAG, "cdn_applied", { loc: code, id: l.id });
  return l;
}

// --- Экран и сообщения ---

/** Устройство из кэша `device/info`; сбой или долгий ответ — без отметки текущего сервера. */
function softDevice(ctx: AppContext): Promise<DeviceInfo | undefined> {
  const dev = ctx.repo.deviceInfo().then((g) => g.value, (e: unknown) => {
    ctx.log.debug(TAG, "cdn_device_failed", { err: toKpError(e).code });
    return undefined;
  });
  return Promise.race([dev, sleep(ctx.clock, DEVICE_WAIT_MS).then(() => undefined)]);
}

/** Текущий сервер ссылок: ручной `loc` этого ТВ, иначе `serverLocation` устройства. */
function currentCode(ctx: AppContext, locs: ServerLocation[], dev: DeviceInfo | undefined): string | undefined {
  return ctx.prefs.get().loc ?? locs.find((l) => l.id === dev?.location?.id)?.location;
}

function bestLabel(run: CdnRun | undefined, best: string | undefined, cur: string | undefined, name: (c: string) => string): string {
  if (run === undefined) return T.noRun;
  if (best !== undefined) return best === cur ? T.isBest : name(best);
  return run.rows.some((r) => r.ok) ? T.noCompare : T.noAnswers;
}

/**
 * `probe:cdn`: строка на сервер (выбор строки — этот сервер), под ними «Выбрать самый быстрый» и «Проверить»;
 * `enumerate: false` — без счётчика MSX «(1/6)» в заголовке.
 */
export async function cdnScreen(ctx: AppContext): Promise<MsxContentRoot> {
  if (!ctx.auth.isLoggedIn()) throw new KpError("KP-AUTH", "login required");
  const [got, dev] = await Promise.all([ctx.repo.serverLocations(), softDevice(ctx)]);
  const locs = usable(got.value);
  const run = loadRun(ctx.store);
  const busy = runs.has(ctx);
  const cur = currentCode(ctx, locs, dev);
  const best = run === undefined ? undefined : bestOf(run.rows, cur);
  const name = (code: string): string => {
    const l = locs.find((x) => x.location === code);
    return countryName(code, l?.name ?? "");
  };
  const byCode = new Map((run?.rows ?? []).map((r) => [r.code, r]));
  const head = (headline: string): MsxContentItem => ({ type: "space", layout: ROW, offset: GROUP_OFFSET, headline });
  const last = run === undefined ? `≈ 10–30 с, до ${locs.length * (CAP_BYTES / MB)} МБ`
    : `${fmtDate(run.at / 1000)} ${fmtTime(run.at)} · ${fmtMb(run.bytes)} за ${fmtSec(run.ms)}${run.stopped ? " · прервана" : ""}`;
  const pick = best !== undefined && best !== cur && !busy;
  // Таблица, под ней действия: при 3 серверах экран — ровно 6 строк, всё видно без прокрутки. «Проверить» — последней:
  // нижний страж ведёт на неё, а «Выбрать самый быстрый» бывает выключена.
  const items: MsxContentItem[] = [
    head({ full: T.legend, node: T.legendNode, front: T.legendFront }[worst(run)]),
    ...locs.map((l): MsxContentItem => ({
      id: rowId(l.location), label: `${l.location === cur ? CHECK : ""}${name(l.location)}${l.location === best ? T.fastest : ""}`,
      extensionLabel: rowText(byCode.get(l.location)), action: setAct(l.location),
    })),
    ...(locs.length === 0 ? [{ id: "cdn_none", label: T.noLocs, enable: false }] : []),
    { id: "cdn_best", label: T.best, extensionLabel: bestLabel(run, best, cur, name), ...(pick ? { action: setAct(best) } : { enable: false }) },
    {
      id: "cdn_run", label: T.run, extensionLabel: busy ? T.running : last,
      action: busy ? `info:${T.already}` : chain([`info:${T.started}`, commitMsg(msgs.act("probe", "cdnRun"))]),
    },
  ];
  // После проверки фокус — на «Выбрать самый быстрый», если есть что выбирать.
  const focus = items.findIndex((i) => i.id === (pick ? "cdn_best" : "cdn_run"));
  items[focus] = { ...items[focus], focus: true };
  const framed = gridEdges(items, GRID, { top: "overlay", bottom: true });
  const root: MsxContentRoot = {
    type: "list", compress: true, flag: FLAG, cache: false, reuse: false, headline: T.headline,
    template: { type: "control", layout: ROW, enumerate: false }, items: framed.items,
  };
  if (framed.inserts !== undefined) root.inserts = framed.inserts;
  return root;
}

/** Экран теста перерисовывается, только если он всё ещё текущий (спец. §6.3). */
function refresh(ctx: AppContext, toast?: string): void {
  const shown = ctx.current.isCurrent(ids.probe("cdn"));
  if (toast !== undefined) ctx.host.executeAction(shown ? chain([`info:${toast}`, "reload:content"]) : `info:${toast}`);
  else if (shown) ctx.host.executeAction("reload:content");
}

function summary(ctx: AppContext, run: CdnRun, locs: ServerLocation[], dev: DeviceInfo | undefined): string {
  if (run.stopped !== undefined) return T.stopped;
  const cur = currentCode(ctx, locs, dev);
  const best = bestOf(run.rows, cur);
  if (best === undefined) return T.unknown;
  if (best === cur) return T.curBest;
  const l = locs.find((x) => x.location === best);
  return `${T.bestNow} — ${countryName(best, l?.name ?? "")}`;
}

/** `act:probe:cdnRun`: тест в фоне; экран сразу показывает «Идёт проверка…», в конце — итог уведомлением. */
export async function onCdnRun(ctx: AppContext): Promise<void> {
  if (runs.has(ctx)) return ctx.host.executeAction(`info:${T.already}`);
  if (playing(ctx)) return ctx.host.executeAction(`info:${T.stopVideo}`);
  const p = runCdn(ctx);
  refresh(ctx);
  let toast: string;
  try {
    const run = await p;
    const [locs, dev] = await Promise.all([ctx.repo.serverLocations(), softDevice(ctx)]);
    toast = summary(ctx, run, usable(locs.value), dev);
  } catch (e) {
    const err = toKpError(e);
    ctx.log.warn(TAG, "cdn_failed", { err: err.code, msg: err.message });
    toast = failed(T.runFailed, err);
  }
  refresh(ctx, toast);
}

/** `act:probe:cdnSet:<код>`: сервер устройства и сверка; итог — уведомлением, экран теста — с новой отметкой. */
export async function onCdnSet(ctx: AppContext, code: string): Promise<void> {
  if (!LOC_CODE.test(code)) {
    ctx.log.warn(TAG, "cdn_bad_code", { code });
    return;
  }
  let toast: string;
  try {
    const l = await applyLocation(ctx, code);
    toast = `${T.applied}: ${countryName(l.location, l.name)}`;
  } catch (e) {
    const err = toKpError(e);
    ctx.log.warn(TAG, "cdn_apply_failed", { loc: code, err: err.code, msg: err.message });
    toast = failed(T.setFailed, err);
  }
  refresh(ctx, toast);
}
