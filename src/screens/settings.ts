import type { AppContext } from "../app/context.ts";
import type { DeviceInfo, DeviceSettings } from "../api/models.ts";
import { sleep } from "../core/clock.ts";
import { KpError, toKpError } from "../core/errors.ts";
import { fmtDate } from "../core/format.ts";
import { langName } from "../core/lang.ts";
import { chain, commitMsg, contentAction, panelAction } from "../msx/actions.ts";
import { gridEdges } from "../msx/edges.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import type { Prefs } from "../playback/prefs.ts";
import { ids, msgs } from "../router/ids.ts";
import { errorText } from "./error.ts";
import { menuSummary } from "./menu-edit.ts";
import { choicePanel } from "./panels.ts";
import { MODE_NAMES, countryName } from "./panels-labels.ts";

// S12 (спец. §11; Plan B S12): строка — текущее значение в `extensionLabel`, выбор — панелью `panel:setting:<ключ>`.
// 4K и HEVC — настройки своего устройства KinoPub у каждого ТВ (CD-04, Plan B §6.2.1): POST формой и сверка чтением.

const TAG = "settings";
const WAIT_MS = 3000;
const DASH = "—";
const SEC = " с";

const T = {
  headline: "Просмотр и аккаунт", play: "Воспроизведение", device: "Это устройство KinoPub", account: "Аккаунт",
  expert: "Для опытных", diag: "Диагностика", probe: "Проверки и журнал", name: "Название", sub: "Подписка",
  until: "До", left: "осталось", days: "дн.", inactive: "Не активна", authors: "Любимые студии",
  reset: "Сбросить любимые студии", noAuthors: "Студия добавляется, когда вы выбираете озвучку на карточке", none: "Нет",
  logout: "Выйти из KinoPub", confirm: "Выйти из KinoPub?", yes: "Выйти", cancel: "Отмена", mismatch: "device-settings-mismatch",
};
/** V-33: заголовок группы — в нижней половине своей строки, вплотную к её пунктам (проверено в web MSX). */
const GROUP_OFFSET = "0,0.5,0,-0.5";
/**
 * Строки 12×1 в сетке 12×6. Над первой строкой и под последней — стражи (`msx/edges.ts`): «вверх» и «вниз» на краю
 * списка не переносят фокус по кругу. Первая строка — заголовок группы, страж встаёт в его ячейку (`overlay`).
 */
const GRID = { width: 12, height: 6, w: 12, h: 1 };

type Val = string | number | boolean | undefined;
interface Opt { v: Val; label: string }
interface Def { label: string; field?: keyof Prefs; dev?: keyof DeviceSettings; opts: Opt[] | ((ctx: AppContext) => Promise<Opt[]>) }

const opt = (v: Val, label: string): Opt => ({ v, label });
const ON_OFF = [opt(1, "Вкл"), opt(0, "Выкл")];
const nums = (vs: number[], unit: string): Opt[] => vs.map((v) => opt(v, `${v}${unit}`));
const langs = (codes: string[], kind: 0 | 1): Opt[] => codes.map((c) => opt(c, langName(c, kind)));
/** «Авто», «Любой», «По умолчанию» — снятое поле `prefs`; в сообщении — `auto`. */
const enc = (v: Val): string => (v === undefined ? "auto" : String(v));

/** Справочник с первой строкой без значения; сбой или долгий ответ — только первая строка. */
const refs = (head: string, load: (ctx: AppContext) => Promise<Opt[]>) => async (ctx: AppContext): Promise<Opt[]> =>
  [opt(undefined, head), ...((await soft(ctx, load(ctx))) ?? [])];

const DEFS: Record<string, Def> = {
  quality: { label: "Максимальное качество", field: "maxQuality", opts: nums([2160, 1080, 720, 480], "p") },
  mode: { label: "Способ воспроизведения", field: "streamMode", opts: [opt(undefined, "Авто"), opt("hls1", MODE_NAMES.hls1), opt("hls2", MODE_NAMES.hls2)] },
  loc: {
    label: "CDN-сервер", field: "loc",
    opts: refs("По умолчанию", async (ctx) => (await ctx.repo.serverLocations()).value.map((l) => opt(l.location, countryName(l.location, l.name)))),
  },
  audioLang: { label: "Язык озвучки", field: "audioLang", opts: langs(["rus", "ukr", "eng"], 0) },
  audioType: {
    label: "Тип озвучки", field: "audioType",
    opts: refs("Любой", async (ctx) => (await ctx.repo.voiceoverTypes()).value.map((x) => opt(x.id, x.title))),
  },
  ac3: { label: "Разрешить AC3", field: "allowAc3", opts: [opt(true, "Да"), opt(false, "Нет")] },
  subs: { label: "Субтитры по умолчанию", field: "subsLang", opts: [opt("off", "Выключены"), ...langs(["rus", "eng"], 1)] },
  hevc: { label: "HEVC", dev: "supportHevc", opts: ON_OFF },
  uhd: { label: "4K", dev: "support4k", opts: ON_OFF },
  bufferInit: { label: "Буфер старта", field: "bufferInit", opts: nums([2, 4, 6, 8], SEC) },
  bufferResume: { label: "Буфер продолжения", field: "bufferResume", opts: nums([4, 6, 8, 10], SEC) },
  posterSize: { label: "Размер постеров", field: "posterSize", opts: [opt("small", "Маленькие"), opt("medium", "Средние")] },
  cardBackgrounds: { label: "Фоны карточек", field: "cardBackgrounds", opts: [opt(true, "Вкл"), opt(false, "Выкл")] },
};

/** V-33: способ воспроизведения, CDN, AC3 и HEVC — технические, они в «Для опытных». */
const GROUPS: [string, ...string[]][] = [
  [T.play, "quality", "audioLang", "audioType", "authors", "subs"],
  [T.device, "uhd", "device"],
  [T.account, "account", "logout"],
  ["Меню", "menu"],
  [T.expert, "mode", "loc", "ac3", "hevc", "bufferInit", "bufferResume", "posterSize", "cardBackgrounds"],
  [T.diag, "probe"],
];

const defOf = (key: string): Def | undefined => (Object.prototype.hasOwnProperty.call(DEFS, key) ? DEFS[key] : undefined);
const optsOf = (ctx: AppContext, d: Def): Opt[] | Promise<Opt[]> => (typeof d.opts === "function" ? d.opts(ctx) : d.opts);
const setMsg = (key: string, v?: string): string => commitMsg(v === undefined ? msgs.act("set", key) : msgs.act("set", key, v));
const current = (p: Prefs, d: Def, dev: DeviceInfo | undefined): Val => (d.field ? p[d.field] as Val : dev?.settings[d.dev!]);

/** Устройство KinoPub из кэша `device/info` (Plan B §7.2): повторное открытие экрана и панелей не ждёт API. */
const device = async (ctx: AppContext): Promise<DeviceInfo> => (await ctx.repo.deviceInfo()).value;

/** Экран и панели не ждут сеть дольше `WAIT_MS`; сбой части — прочерк в её строках. */
function soft<V>(ctx: AppContext, p: Promise<V>): Promise<V | undefined> {
  const failed = (e: unknown): undefined => void ctx.log.debug(TAG, "part_failed", { err: toKpError(e).code });
  return Promise.race([p.catch(failed), sleep(ctx.clock, WAIT_MS).then(() => undefined)]);
}

export async function settingsScreen(ctx: AppContext): Promise<MsxContentRoot> {
  const keys = Object.keys(DEFS);
  const [dev, user, lists] = await Promise.all([
    soft(ctx, device(ctx)), soft(ctx, ctx.repo.user()), Promise.all(keys.map((k) => optsOf(ctx, DEFS[k]!))),
  ]);
  const p = ctx.prefs.get();
  const s = user?.value.subscription;
  const items: MsxContentItem[] = [];
  const add = (key: string, label: string, ext: string, action?: string): void => {
    items.push({ id: `s_${key}`, label, extensionLabel: ext, ...(action === undefined ? { enable: false } : { action }) });
  };
  for (const [head, ...rows] of GROUPS) {
    items.push({ type: "space", layout: "0,0,12,1", offset: GROUP_OFFSET, headline: head });
    for (const key of rows) {
      const i = keys.indexOf(key);
      const d = DEFS[key];
      if (d !== undefined) {
        const cur = current(p, d, dev);
        const ext = lists[i]!.find((o) => o.v === cur)?.label ?? (cur === undefined ? DASH : String(cur));
        add(key, d.label, ext, panelAction(ctx.P, key === "loc" ? ids.panel("loc") : ids.panel("setting", key)));
      } else if (key === "authors") {
        add(key, T.authors, p.audioAuthors.length > 0 ? String(p.audioAuthors.length) : T.none, panelAction(ctx.P, ids.panel("setting", key)));
      } else if (key === "device") {
        add(key, T.name, dev?.title || DASH);
      } else if (key === "account") {
        add(key, T.sub, s === undefined ? DASH : s.active ? `${T.until} ${fmtDate(s.endTime)}, ${T.left} ${Math.floor(s.days)} ${T.days}` : T.inactive);
      } else if (key === "menu") {
        add(key, "Пункты меню", menuSummary(ctx), panelAction(ctx.P, ids.panel("menu")));
      } else if (key === "logout") {
        add(key, T.logout, "", panelAction(ctx.P, ids.panel("setting", "account")));
      } else {
        add(key, T.probe, "", contentAction(ctx.P, ids.probe()));
      }
    }
  }
  // Фокус при открытии — на первой настройке, а не на страже над ней.
  const first = items.findIndex((i) => i.type !== "space");
  if (first >= 0) items[first] = { ...items[first], focus: true };
  const framed = gridEdges(items, GRID, { top: "overlay", bottom: true });
  const root: MsxContentRoot = {
    type: "list", flag: "settings", cache: false, reuse: false, headline: T.headline, template: { type: "control", layout: "0,0,12,1" }, items: framed.items,
  };
  if (framed.inserts !== undefined) root.inserts = framed.inserts;
  return root;
}

/**
 * Панель `panel:setting:<key>` (её вызывает `panelScreen`); CDN-сервер — панель `panel:loc` (S10). `account` —
 * подтверждение выхода (V-34; её открывает и «Диагностика»): фокус на «Отмена», «Выйти» сначала закрывает панель.
 */
export async function settingPanel(ctx: AppContext, key: string): Promise<MsxContentRoot> {
  if (key === "account") {
    const p = choicePanel(ctx, T.confirm, [{ label: T.yes, action: chain(["back", setMsg("logout")]), current: false }]);
    return { ...p, items: [...(p.items ?? []), { label: T.cancel, action: "back", focus: true }] };
  }
  if (key === "authors") {
    // V-36: сбрасывать нечего — строка объясняет, откуда берутся любимые студии.
    const n = ctx.prefs.get().audioAuthors.length;
    const row = n > 0 ? { label: `${T.reset} (${n})`, action: setMsg(key, "reset") } : { label: T.noAuthors, action: "back" };
    return choicePanel(ctx, T.authors, [{ ...row, current: false }]);
  }
  const d = defOf(key);
  if (d === undefined) throw new KpError("KP-BAD", "bad setting", undefined, key);
  const [opts, dev] = await Promise.all([optsOf(ctx, d), d.dev ? soft(ctx, device(ctx)) : undefined]);
  const cur = current(ctx.prefs.get(), d, dev);
  return choicePanel(ctx, d.label, opts.map((o) => ({ label: o.label, action: setMsg(key, enc(o.v)), current: o.v === cur })));
}

/**
 * POST настроек своего устройства и сверка свежим чтением (Plan B §6.2.1): оно же обновляет кэш устройства, ссылки на
 * поток устаревают (Plan B §7.3). Чтение не удалось — ошибка сети, а не сверка с прежним значением из кэша.
 */
async function saveDevice(ctx: AppContext, s: Partial<DeviceSettings>): Promise<void> {
  await ctx.api.deviceSettingsSave((await device(ctx)).id, s);
  ctx.repo.invalidateAfterDevice();
  const got = await ctx.repo.deviceInfo({ fresh: true });
  if (got.offline !== undefined) throw new KpError(got.offline, "device-reread-failed");
  const now = got.value.settings;
  const keys = (Object.keys(s) as (keyof DeviceSettings)[]).filter((k) => now[k] !== s[k]);
  if (keys.length > 0) throw new KpError("KP-BAD", T.mismatch, undefined, keys.join(","));
}

/**
 * `act:set:<key>:<value>` → `prefs` или настройки устройства → `[back|reload:content]` (сбой устройства — ещё `info:`);
 * потолок 2160p включает 4K устройства; `act:set:logout` — выход, `replace:menu` даёт `onLoggedOut` (create-app).
 */
export async function onSettingsAct(ctx: AppContext, name: string, args: string[]): Promise<void> {
  if (name === "logout") return ctx.auth.logout();
  const v = args[0] ?? "";
  const d = defOf(name);
  const o = d === undefined ? undefined : (await optsOf(ctx, d)).find((x) => enc(x.v) === v);
  if (!(name === "authors" && v === "reset") && (d === undefined || o === undefined)) {
    ctx.log.warn(TAG, "bad_act", { name, args });
    return;
  }
  const tail: string[] = [];
  try {
    if (name === "authors") ctx.prefs.update({ audioAuthors: [] });
    if (d?.field) ctx.prefs.update({ [d.field]: o?.v } as Partial<Prefs>);
    const dev = d?.dev ? { [d.dev]: o?.v } : name === "quality" && o?.v === 2160 ? { support4k: 1 } : undefined;
    if (dev !== undefined) await saveDevice(ctx, dev as Partial<DeviceSettings>);
    if (d?.dev === "supportHevc") ctx.prefs.update({ allowHevc: o?.v === 1 });
  } catch (e) {
    ctx.log.warn(TAG, "device_failed", { name, err: toKpError(e).code });
    tail.push(`info:${errorText(e).text}`);
  }
  ctx.host.executeAction(chain(["back", "reload:content", ...tail]));
}
