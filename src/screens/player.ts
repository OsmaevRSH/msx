import type { AppContext } from "../app/context.ts";
import type { Audio, Subtitle } from "../api/models.ts";
import { chain, panelAction, resolveAction } from "../msx/actions.ts";
import type { MsxResolveResponse } from "../msx/types.ts";
import type { EpRef } from "../playback/episodes.ts";
import type { SubsChoice } from "../playback/select.ts";
import { KP_PROPS } from "../progress/session.ts";
import { ids } from "../router/ids.ts";

// Свойства плеера и ответ resolve (спец. §9.1–9.2, §10.1, §16.3; Plan B §5.8, §5.11).
// Маркеры kp:* — по ним ProgressTracker собирает сессию (sessionFromProps требует kp:i, kp:m, kp:e).

export interface PlayerPropsInput { itemId: number; ref: EpRef; duration: number; prev?: EpRef; next?: EpRef; probe?: string; ticks?: number }

export interface ResolvedPlay {
  url: string; label: string; position: number | "none"; quality: string; audio: string;
  mode: "hls1" | "hls2"; step: 1 | 2 | 3; subtitle?: Subtitle; props: PlayerPropsInput;
}

/** Снимок позиции: свойства-действия не несут своих данных, поэтому все триггеры шлют одно и то же (спец. §10.1). */
const SNAPSHOT = "interaction:commit:video";
const NOP = chain([]);
const PERCENT_STEP = 5;
const BUFFER_TIMEOUT_SEC = "10";
/** Режим и шаг fallback пользователю ничего не говорят (V-27): они только в журнале resolve и в проверках «Диагностики». */
const MODE_LABEL = { hls1: "HLS1", hls2: "HLS2" } as const;
const RETRY_TOAST = "info:Предыдущий запуск не удался — пробую другой способ воспроизведения";
/** Язык дорожки по-русски: озвучка — «Русский», субтитры — «Русские»; прочие коды — заглавными (V-20). */
const LANGS: Readonly<Record<string, readonly [audio: string, subs: string]>> = {
  rus: ["Русский", "Русские"], eng: ["Английский", "Английские"], ukr: ["Украинский", "Украинские"],
};
const SUBS_FORCED = "только надписи";
const SUBS_OFF = "Выключены";

const langName = (lang: string, k: 0 | 1): string => LANGS[lang.toLowerCase()]?.[k] ?? lang.toUpperCase();

/** Студия озвучки, иначе её тип («Оригинал»), иначе язык — на кнопке карточки и в `label:extension`. */
export const audioTitle = (a: Audio): string => a.authorTitle ?? a.typeTitle ?? langName(a.lang, 0);

/** «Английские», «Английские · только надписи», «Выключены». */
export function subsTitle(c: SubsChoice | "off"): string {
  if (c === "off") return SUBS_OFF;
  const name = langName(c.lang, 1);
  return c.forced ? `${name} · ${SUBS_FORCED}` : name;
}

/** Действия, которые зависят от серии: у карточки — готовые строки, у шаблона сезона — `{context:…}`. */
interface EpisodeActions { item: string; mid: string; prev?: string; next?: string; complete: string }

const playEp = (ctx: AppContext, r: EpRef): string => resolveAction(ctx.P, ids.playEp(r.itemId, r.mid, r.season, r.video));

function episodeActions(ctx: AppContext, p: PlayerPropsInput): EpisodeActions {
  const out: EpisodeActions = { item: String(p.itemId), mid: String(p.ref.mid), complete: "player:eject" };
  if (p.prev !== undefined) out.prev = playEp(ctx, p.prev);
  if (p.next !== undefined) {
    out.next = playEp(ctx, p.next);
    // CDG-11: нажатие кнопки из триггера (паттерн RBTV) или запасной путь — resolve следующей серии напрямую.
    out.complete = ctx.flags.get().autonext === "button" ? "player:button:next:execute" : out.next;
  }
  return out;
}

/** Всё, кроме маркеров `kp:*`: одинаково для ответа resolve и для `template.properties`. */
function controls(ctx: AppContext, a: EpisodeActions, ticks: number): Record<string, string> {
  const prefs = ctx.prefs.get();
  const flags = ctx.flags.get();
  const panel = (type: string): string => panelAction(ctx.P, ids.panel(type, a.item, a.mid, "p"));
  const out: Record<string, string> = {
    "control:type": "extended",
    "tizen:buffer:size:init": String(prefs.bufferInit),
    "tizen:buffer:size:resume": String(prefs.bufferResume),
    "tizen:buffer:timeout": BUFFER_TIMEOUT_SEC,
    // AVPlay не меняет скорость, поэтому `speed` — субтитры, а `restart` — качество («С начала» есть на карточке).
    "button:content:icon": "audiotrack",
    "button:content:action": panel("audio"),
    "button:speed:icon": "subtitles",
    "button:speed:action": panel("subs"),
    "button:restart:icon": "hd",
    "button:restart:action": panel("quality"),
  };
  if (a.prev !== undefined) {
    out["button:prev:icon"] = "default";
    out["button:prev:action"] = a.prev;
    out["button:prev:key"] = "channel_down";
  }
  if (a.next !== undefined) {
    out["button:next:icon"] = "default";
    out["button:next:action"] = a.next;
    out["button:next:key"] = "channel_up";
  }
  out["trigger:complete"] = a.complete;
  // Позиция при выходе по Back: снимок раньше `eject`, `video:stop` может прийти уже без позиции (Plan B M-02).
  out["trigger:back"] = chain([SNAPSHOT, "player:eject"]);
  if (flags.heartbeat === "ticks") {
    out[`trigger:${ticks}t`] = chain([SNAPSHOT, "player:ticking:restart"]);
  } else if (flags.heartbeat === "percent") {
    for (let n = PERCENT_STEP; n < 100; n += PERCENT_STEP) out[`trigger:${n}%`] = SNAPSHOT;
  }
  // Страховка правила «просмотрено» (≥ 90 %); в режиме percent заменяет обычный триггер 90 %.
  out["trigger:90%"] = `shot:${SNAPSHOT}`;
  if (flags.events === "triggers") {
    out["trigger:pause"] = SNAPSHOT;
    out["trigger:stop"] = SNAPSHOT;
  }
  return out;
}

/** Статические свойства ответа resolve. */
export function playerProps(ctx: AppContext, p: PlayerPropsInput): Record<string, string> {
  const out: Record<string, string> = {
    [KP_PROPS.item]: String(p.itemId),
    [KP_PROPS.mid]: String(p.ref.mid),
    [KP_PROPS.season]: String(p.ref.season),
    [KP_PROPS.episode]: String(p.ref.video),
    [KP_PROPS.duration]: String(p.duration),
    [KP_PROPS.hasNext]: p.next !== undefined ? "1" : "0",
  };
  if (p.probe !== undefined) out[KP_PROPS.probe] = p.probe;
  return { ...out, ...controls(ctx, episodeActions(ctx, p), p.ticks ?? ctx.build.heartbeatTicks) };
}

/**
 * Те же свойства через `{context:…}` — для `template.properties` сезона (спец. §16.3, CDG-06, решение Р-18).
 * Кнопки соседей есть всегда: у крайних серий их действие — пустое `[]` из `contextFields`.
 */
export function contextPlayerProps(ctx: AppContext): Record<string, string> {
  const a: EpisodeActions = {
    item: "{context:kid}", mid: "{context:kmid}", prev: "{context:kprevAction}", next: "{context:knextAction}",
    complete: "{context:kcomplete}",
  };
  return {
    [KP_PROPS.item]: "{context:kid}",
    [KP_PROPS.mid]: "{context:kmid}",
    [KP_PROPS.season]: "{context:ks}",
    [KP_PROPS.episode]: "{context:ke}",
    [KP_PROPS.duration]: "{context:kd}",
    [KP_PROPS.hasNext]: "{context:kn}",
    ...controls(ctx, a, ctx.build.heartbeatTicks),
  };
}

/** Поля элемента для `{context:…}`: kid, kmid, ks, ke, kd, kn, knextAction, kprevAction, kcomplete. */
export function contextFields(ctx: AppContext, p: PlayerPropsInput): Record<string, string> {
  const a = episodeActions(ctx, p);
  return {
    kid: String(p.itemId), kmid: String(p.ref.mid), ks: String(p.ref.season), ke: String(p.ref.video),
    kd: String(p.duration), kn: p.next !== undefined ? "1" : "0",
    knextAction: a.next ?? NOP, kprevAction: a.prev ?? NOP, kcomplete: a.complete,
  };
}

/** Те же поля у элемента сезона, который видео не запускает (переход между частями сезона): действия — пустые `[]`. */
export const idleContextFields = (): Record<string, string> =>
  ({ kid: "", kmid: "", ks: "", ke: "", kd: "", kn: "0", knextAction: NOP, kprevAction: NOP, kcomplete: NOP });

/** Свойства, зависящие от конкретного запуска: позиция, метка, субтитры, режим и шаг цепочки fallback. */
export function dynamicProps(ctx: AppContext, r: ResolvedPlay): Record<string, string> {
  const out: Record<string, string> = {
    // Позиция KinoPub; `resume:key` не задаём, иначе MSX хранит свою и расходится с KinoPub (Plan B §5.7).
    "resume:position": String(r.position),
    "label:extension": [r.quality, r.audio, r.props.probe === undefined ? "" : MODE_LABEL[r.mode]].filter((s) => s !== "").join(" · "),
  };
  if (r.subtitle !== undefined) {
    out["tizen:subtitle:url"] = r.subtitle.url;
    // `shift` API — секунды (Plan B §5.6), AVPlay ждёт миллисекунды.
    if (r.subtitle.shift !== 0) out["tizen:subtitle:delay"] = String(Math.round(r.subtitle.shift * 1000));
  }
  // Варианты hls2 уже ограничены качеством устройства — стартуем с верхнего (Plan B §5.8).
  if (r.mode === "hls2") out["tizen:stream:ADAPTIVE_INFO"] = "STARTBITRATE=HIGHEST";
  if (r.step >= 2) out["trigger:load"] = RETRY_TOAST;
  return out;
}

/** `{ url, label, properties }`; при `playerPropsIn: item` статические свойства уже в элементе (CDG-06). */
export function buildResolveResponse(ctx: AppContext, r: ResolvedPlay): MsxResolveResponse {
  const dynamic = dynamicProps(ctx, r);
  const properties = ctx.flags.get().playerPropsIn === "resolve" ? { ...playerProps(ctx, r.props), ...dynamic } : dynamic;
  return { url: r.url, label: r.label, properties };
}
