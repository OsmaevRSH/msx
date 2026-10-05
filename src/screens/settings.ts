import type { AppContext } from "../app/context.ts";
import type { DeviceInfo, DeviceSettings } from "../api/models.ts";
import { sleep } from "../core/clock.ts";
import { KpError, toKpError } from "../core/errors.ts";
import { fmtDate } from "../core/format.ts";
import { chain, commitMsg, contentAction, panelAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import type { Prefs } from "../playback/prefs.ts";
import { ids, msgs } from "../router/ids.ts";
import { errorText } from "./error.ts";
import { choicePanel } from "./panels.ts";

// S12 (спец. §11; Plan B S12): строка — текущее значение в `extensionLabel`, выбор — панелью `panel:setting:<ключ>`.
// 4K и HEVC — настройки своего устройства KinoPub у каждого ТВ (CD-04, Plan B §6.2.1): POST формой и сверка чтением.

const TAG = "settings";
const WAIT_MS = 3000;
const DASH = "—";
const SEC = " с";

const T = {
  headline: "Настройки KinoPub", play: "Воспроизведение", device: "Это устройство KinoPub", account: "Аккаунт",
  expert: "Для опытных", diag: "Диагностика", probe: "Проверки и журнал", name: "Название", sub: "Подписка",
  until: "до", left: "осталось", days: "дн.", inactive: "не активна", authors: "Любимые студии",
  reset: "Сбросить любимые студии", none: "нет", logout: "Выйти из KinoPub", mismatch: "device-settings-mismatch",
};

type Val = string | number | boolean | undefined;
interface Opt { v: Val; label: string }
interface Def { label: string; field?: keyof Prefs; dev?: keyof DeviceSettings; opts: Opt[] | ((ctx: AppContext) => Promise<Opt[]>) }

const opt = (v: Val, label: string): Opt => ({ v, label });
const ON_OFF = [opt(1, "вкл"), opt(0, "выкл")];
const nums = (vs: number[], unit: string): Opt[] => vs.map((v) => opt(v, `${v}${unit}`));
/** «Авто», «Любой», «По умолчанию» — снятое поле `prefs`; в сообщении — `auto`. */
const enc = (v: Val): string => (v === undefined ? "auto" : String(v));

/** Справочник с первой строкой без значения; сбой или долгий ответ — только первая строка. */
const refs = (head: string, load: (ctx: AppContext) => Promise<Opt[]>) => async (ctx: AppContext): Promise<Opt[]> =>
  [opt(undefined, head), ...((await soft(ctx, load(ctx))) ?? [])];

const DEFS: Record<string, Def> = {
  quality: { label: "Качество (потолок)", field: "maxQuality", opts: nums([2160, 1080, 720, 480], "p") },
  mode: { label: "Тип потока", field: "streamMode", opts: [opt(undefined, "Авто"), opt("hls1", "HLS1"), opt("hls2", "HLS2")] },
  loc: {
    label: "CDN-сервер", field: "loc",
    opts: refs("По умолчанию", async (ctx) => (await ctx.repo.serverLocations()).value.map((l) => opt(l.location, l.name || l.location))),
  },
  audioLang: { label: "Язык озвучки", field: "audioLang", opts: [opt("rus", "Русский"), opt("ukr", "Украинский"), opt("eng", "Английский")] },
  audioType: {
    label: "Тип озвучки", field: "audioType",
    opts: refs("Любой", async (ctx) => (await ctx.repo.voiceoverTypes()).value.map((x) => opt(x.id, x.title))),
  },
  ac3: { label: "Разрешить AC3", field: "allowAc3", opts: [opt(true, "да"), opt(false, "нет")] },
  subs: { label: "Субтитры по умолчанию", field: "subsLang", opts: [opt("off", "Выключены"), opt("rus", "RUS"), opt("eng", "ENG")] },
  hevc: { label: "HEVC", dev: "supportHevc", opts: ON_OFF },
  uhd: { label: "4K", dev: "support4k", opts: ON_OFF },
  bufferInit: { label: "Буфер старта", field: "bufferInit", opts: nums([2, 4, 6, 8], SEC) },
  bufferResume: { label: "Буфер продолжения", field: "bufferResume", opts: nums([4, 6, 8, 10], SEC) },
  posterSize: { label: "Размер постеров", field: "posterSize", opts: [opt("small", "Маленькие"), opt("medium", "Средние")] },
  cardBackgrounds: { label: "Фоны карточек", field: "cardBackgrounds", opts: [opt(true, "вкл"), opt(false, "выкл")] },
};

const GROUPS: [string, ...string[]][] = [
  [T.play, "quality", "mode", "loc", "audioLang", "audioType", "authors", "ac3", "subs"],
  [T.device, "hevc", "uhd", "device"],
  [T.account, "account"],
  [T.expert, "bufferInit", "bufferResume", "posterSize", "cardBackgrounds"],
  [T.diag, "probe"],
];

const defOf = (key: string): Def | undefined => (Object.prototype.hasOwnProperty.call(DEFS, key) ? DEFS[key] : undefined);
const optsOf = (ctx: AppContext, d: Def): Opt[] | Promise<Opt[]> => (typeof d.opts === "function" ? d.opts(ctx) : d.opts);
const setMsg = (key: string, v?: string): string => commitMsg(v === undefined ? msgs.act("set", key) : msgs.act("set", key, v));
const current = (p: Prefs, d: Def, dev: DeviceInfo | undefined): Val => (d.field ? p[d.field] as Val : dev?.settings[d.dev!]);

/** Экран и панели не ждут сеть дольше `WAIT_MS`; сбой части — прочерк в её строках. */
function soft<V>(ctx: AppContext, p: Promise<V>): Promise<V | undefined> {
  const failed = (e: unknown): undefined => void ctx.log.debug(TAG, "part_failed", { err: toKpError(e).code });
  return Promise.race([p.catch(failed), sleep(ctx.clock, WAIT_MS).then(() => undefined)]);
}

export async function settingsScreen(ctx: AppContext): Promise<MsxContentRoot> {
  const keys = Object.keys(DEFS);
  const [dev, user, lists] = await Promise.all([
    soft(ctx, ctx.api.deviceInfo()), soft(ctx, ctx.repo.user()), Promise.all(keys.map((k) => optsOf(ctx, DEFS[k]!))),
  ]);
  const p = ctx.prefs.get();
  const s = user?.value.subscription;
  const items: MsxContentItem[] = [];
  const add = (key: string, label: string, ext: string, action?: string): void => {
    items.push({ id: `s_${key}`, label, extensionLabel: ext, ...(action === undefined ? { enable: false } : { action }) });
  };
  for (const [head, ...rows] of GROUPS) {
    items.push({ type: "space", layout: "0,0,12,1", headline: head });
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
        const ext = s === undefined ? DASH : s.active ? `${T.until} ${fmtDate(s.endTime)}, ${T.left} ${Math.floor(s.days)} ${T.days}` : T.inactive;
        add(key, T.sub, ext, panelAction(ctx.P, ids.panel("setting", key)));
      } else {
        add(key, T.probe, "", contentAction(ctx.P, ids.probe()));
      }
    }
  }
  return { type: "list", flag: "settings", cache: false, reuse: false, headline: T.headline, template: { type: "control", layout: "0,0,12,1" }, items };
}

/** Панель `panel:setting:<key>` (её вызывает `panelScreen`); CDN-сервер — панель `panel:loc` (S10). */
export async function settingPanel(ctx: AppContext, key: string): Promise<MsxContentRoot> {
  if (key === "account") return choicePanel(ctx, T.account, [{ label: T.logout, action: setMsg("logout"), current: false }]);
  if (key === "authors") {
    const label = `${T.reset} (${ctx.prefs.get().audioAuthors.length})`;
    return choicePanel(ctx, T.authors, [{ label, action: setMsg(key, "reset"), current: false }]);
  }
  const d = defOf(key);
  if (d === undefined) throw new KpError("KP-BAD", "bad setting", undefined, key);
  const [opts, dev] = await Promise.all([optsOf(ctx, d), d.dev ? soft(ctx, ctx.api.deviceInfo()) : undefined]);
  const cur = current(ctx.prefs.get(), d, dev);
  return choicePanel(ctx, d.label, opts.map((o) => ({ label: o.label, action: setMsg(key, enc(o.v)), current: o.v === cur })));
}

/** POST настроек своего устройства и сверка повторным чтением (Plan B §6.2.1). */
async function saveDevice(ctx: AppContext, s: Partial<DeviceSettings>): Promise<void> {
  await ctx.api.deviceSettingsSave((await ctx.api.deviceInfo()).id, s);
  const now = (await ctx.api.deviceInfo()).settings;
  const keys = (Object.keys(s) as (keyof DeviceSettings)[]).filter((k) => now[k] !== s[k]);
  if (keys.length > 0) throw new KpError("KP-BAD", T.mismatch, undefined, keys.join(","));
}

/**
 * `act:set:<key>:<value>` → `prefs` или настройки устройства → `[back|reload:content]` (сбой устройства — ещё `info:`);
 * потолок 2160p включает 4K устройства; `act:set:logout` — выход, `reload:menu` даёт `onLoggedOut` (create-app).
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
