import type { AppContext } from "../app/context.ts";
import type { Subtitle } from "../api/models.ts";
import type { MsxResolveResponse } from "../msx/types.ts";
import type { EpRef } from "../playback/episodes.ts";
import { KP_PROPS } from "../progress/session.ts";

// Заглушка этапа 16; свойства плеера и ответ resolve (спец. §9.2) — этап 18.
// Маркеры kp:* уже окончательные: по ним ProgressTracker собирает сессию (sessionFromProps требует kp:i, kp:m, kp:e).

export interface PlayerPropsInput { itemId: number; ref: EpRef; duration: number; prev?: EpRef; next?: EpRef; probe?: string; ticks?: number }

export interface ResolvedPlay {
  url: string; label: string; position: number | "none"; quality: string; audio: string;
  mode: "hls1" | "hls2"; step: 1 | 2 | 3; subtitle?: Subtitle; props: PlayerPropsInput;
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
  return out;
}

/** Те же свойства через `{context:…}` — для `template.properties` сезона (CDG-06). */
export function contextPlayerProps(ctx: AppContext): Record<string, string> {
  return {
    [KP_PROPS.item]: "{context:kid}",
    [KP_PROPS.mid]: "{context:kmid}",
    [KP_PROPS.season]: "{context:ks}",
    [KP_PROPS.episode]: "{context:ke}",
    [KP_PROPS.duration]: "{context:kd}",
    [KP_PROPS.hasNext]: "{context:kn}",
  };
}

/** Поля элемента для `{context:…}`: kid, kmid, ks, ke, kd, kn, knextAction, kprevAction, kcomplete. */
export function contextFields(ctx: AppContext, p: PlayerPropsInput): Record<string, string> {
  return {
    kid: String(p.itemId), kmid: String(p.ref.mid), ks: String(p.ref.season), ke: String(p.ref.video),
    kd: String(p.duration), kn: p.next !== undefined ? "1" : "0", knextAction: "[]", kprevAction: "[]", kcomplete: "player:eject",
  };
}

/** Свойства, зависящие от конкретного запуска: позиция, метка, субтитры, режим. */
export function dynamicProps(ctx: AppContext, r: ResolvedPlay): Record<string, string> {
  return { "resume:position": String(r.position) };
}

export function buildResolveResponse(ctx: AppContext, r: ResolvedPlay): MsxResolveResponse {
  return { error: "Не реализовано" };
}
