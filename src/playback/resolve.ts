import type { AppContext } from "../app/context.ts";
import type { Audio, ItemDetail, MediaLinks, MediaUnit } from "../api/models.ts";
import { KpError, toKpError } from "../core/errors.ts";
import type { KpErrorCode } from "../core/errors.ts";
import { ruTitle } from "../core/format.ts";
import type { MsxResolveResponse } from "../msx/types.ts";
import type { TrackerEvent } from "../progress/tracker.ts";
import type { PlayRoute } from "../router/ids.ts";
import { audioTitle, buildResolveResponse } from "../screens/player.ts";
import type { PlayerPropsInput, ResolvedPlay } from "../screens/player.ts";
import { continueTarget, episodeName, findUnit, mergedState, neighbours, orderedUnits, startPosition } from "./episodes.ts";
import type { EpRef } from "./episodes.ts";
import type { ChainStep } from "./modes.ts";
import type { StreamMode } from "./prefs.ts";
import { pickAudio, pickFile, pickSubtitle, selectPrefs } from "./select.ts";
import { qualityLabel, withAudio, withLoc } from "./url.ts";

// Resolve в плагине (спец. §9.1–9.2, CD-06): ответ { url, label, properties } — из L1, без своего сервера.

export const NO_SUBSCRIPTION_TEXT = "Подписка KinoPub неактивна";
export const NO_START_TEXT = "Видео не запускается. Откройте Диагностику";

/**
 * Параметры, которые пробник (этап 23) задаёт принудительно; `t0` — начало resolve для метрики; `restart` —
 * перезапуск из панели плеера (фикс 35a).
 */
export interface ResolveOverrides { manual?: StreamMode; audio?: Audio; probe?: string; ticks?: number; t0?: number; restart?: boolean }

const TAG = "resolve";
/** Plan B D-41: «Продолжить» по свежим данным — карточку старше 600 с ждём не дольше 500 мс. */
const FRESH_CARD_MS = 600_000;
const FRESH_WAIT_MS = 500;
/** Токен должен пережить просмотр с запасом: refresh посреди серии не нужен. */
const TOKEN_MARGIN_SEC = 600;
/** TTL пользователя в кэше (Plan B §7.2): старше — запись о подписке могла устареть. */
const USER_TTL_MS = 3_600_000;
/** Ошибка API сразу переводит цепочку на следующий шаг — не больше двух раз за один resolve (Plan B §5.11). */
const MAX_AUTO_STEPS = 2;
/**
 * Только ошибки ответа API лечатся другим режимом или свежими ссылками. Сеть, 429 и CORS к моменту ошибки уже
 * прошли повторы транспорта (спец. §5.3); 404 и вход другой режим не исправит.
 */
const NEXT_STEP_ON: ReadonlySet<KpErrorCode> = new Set<KpErrorCode>(["KP-5XX", "KP-BAD"]);
/** У `hls2` качество адаптивное, а озвучка — по умолчанию потока. */
const HLS2_QUALITY = "Авто";

interface Target { ref: EpRef; position: number | "none" }
/** Шаг цепочки, на котором есть что запускать (не шаг 4). */
type PlayStep = { step: ResolvedPlay["step"]; mode: StreamMode; freshLinks: boolean };

/**
 * `play:<id>:continue|start`, `play:<id>:<mid>:<s>:<e>[:start|:at<сек>]`. Серия и позиция «Продолжить»
 * выбираются в момент resolve по свежим данным (спец. §9.1, D-41). `:at<сек>` даёт только панель плеера: это
 * намеренный перезапуск, а не повтор после сбоя (фикс 35a).
 */
export async function resolvePlay(ctx: AppContext, r: PlayRoute): Promise<MsxResolveResponse> {
  const t0 = ctx.clock.perf();
  if (subscriptionInactive(ctx)) return { error: NO_SUBSCRIPTION_TEXT };
  const byProgress = r.k === "play" ? r.what === "continue" : !r.start && r.at === undefined;
  const got = await ctx.repo.item(r.id, byProgress ? { freshWithinMs: FRESH_CARD_MS, waitMs: FRESH_WAIT_MS } : undefined);
  const t = target(ctx, got.value, got.fetchedAt, r);
  return resolveUnit(ctx, got.value, t.ref, t.position, { t0, restart: r.k === "playEp" && r.at !== undefined });
}

/**
 * Ответ resolve для известной серии: шаг цепочки fallback → ссылки → файл, озвучка, субтитры → свойства плеера.
 * Ошибка API — сразу следующий шаг (не больше двух раз); шаг 4 — `{ error }`. Перезапуск — на шаге, который играет.
 */
export async function resolveUnit(
  ctx: AppContext, item: ItemDetail, ref: EpRef, position: number | "none", o: ResolveOverrides = {},
): Promise<MsxResolveResponse> {
  const t0 = o.t0 ?? ctx.clock.perf();
  const unit = findUnit(item, ref.mid)?.unit;
  if (unit === undefined) throw new KpError("KP-404", "unit-not-found", undefined, `mid ${ref.mid}`);
  await ctx.auth.ensureFreshFor(unit.duration + TOKEN_MARGIN_SEC);
  const prefs = ctx.prefs.get();
  const manual = o.manual ?? prefs.titleMode[String(item.id)] ?? prefs.streamMode;
  let step = o.restart ? ctx.chain.restart(ref.mid, manual) : ctx.chain.next(ref.mid, manual);
  for (let failures = 0; ; failures++) {
    const s = playable(step);
    if (s === undefined) {
      ctx.log.warn(TAG, "no_start", { mid: ref.mid });
      return { error: NO_START_TEXT };
    }
    try {
      const links = await ctx.repo.links(ref.mid, { cls: "fg", fresh: s.freshLinks });
      const play = resolved(ctx, item, unit, ref, position, links, s, o);
      const now = ctx.clock.perf();
      ctx.state.resolveAt.set(ref.mid, now);
      ctx.metrics.record("resolve", now - t0);
      ctx.log.info(TAG, "resolved", { mid: ref.mid, step: s.step, mode: s.mode, restart: o.restart, ms: now - t0 });
      return buildResolveResponse(ctx, play);
    } catch (e) {
      const err = toKpError(e);
      ctx.log.warn(TAG, "links_failed", { mid: ref.mid, step: s.step, err: err.code, msg: err.message });
      if (!NEXT_STEP_ON.has(err.code) || failures >= MAX_AUTO_STEPS) throw err;
      step = ctx.chain.advance(ref.mid, manual);
    }
  }
}

/**
 * Подключён в `createApp`: признак старта сбрасывает цепочку fallback этого `mid` и запускает фоновый префетч
 * ссылок следующей серии для автоперехода (спец. §8.3, §10.1).
 */
export function onTrackerEvent(ctx: AppContext, ev: TrackerEvent): void {
  if (ev.kind !== "started") return;
  ctx.chain.markStarted(ev.s.mid);
  const item = ctx.repo.peekItem(ev.s.itemId)?.value;
  const next = item === undefined ? undefined : neighbours(item, ev.s.mid).next;
  if (next === undefined) return;
  ctx.repo.links(next.mid, { cls: "bg" }).catch((e: unknown) => {
    ctx.log.debug(TAG, "prefetch_failed", { mid: next.mid, err: toKpError(e).code });
  });
}

// --- Внутреннее ---

/**
 * Неактивная подписка в кэше — отказ без сети. Запись старше TTL могла пережить продление: запуск не блокируем,
 * пользователь обновляется фоном.
 */
function subscriptionInactive(ctx: AppContext): boolean {
  const u = ctx.repo.peekUser();
  if (u === undefined || u.value.subscription.active) return false;
  if (!u.stale && ctx.clock.now() - u.fetchedAt < USER_TTL_MS) return true;
  ctx.repo.user().catch(() => undefined);
  return false;
}

function playable(c: ChainStep): PlayStep | undefined {
  return c.mode === "none" || c.step === 4 ? undefined : { step: c.step, mode: c.mode, freshLinks: c.freshLinks };
}

function target(ctx: AppContext, item: ItemDetail, fetchedAt: number, r: PlayRoute): Target {
  if (r.k === "play") {
    if (r.what === "continue") {
      const c = continueTarget(item, ctx.overlay.get, fetchedAt);
      return { ref: c.ref, position: c.position };
    }
    const first = orderedUnits(item)[0];
    if (first === undefined) throw new KpError("KP-BAD", "no-units", undefined, `item ${item.id}`);
    return { ref: first, position: "none" };
  }
  const hit = findUnit(item, r.mid);
  if (hit === undefined) throw new KpError("KP-404", "unit-not-found", undefined, `mid ${r.mid}`);
  if (r.start) return { ref: hit.ref, position: "none" };
  if (r.at !== undefined) return { ref: hit.ref, position: r.at > 0 ? r.at : "none" };
  return { ref: hit.ref, position: startPosition(mergedState(item, hit.ref, ctx.overlay.get, fetchedAt), hit.unit.duration) };
}

/** Plan B §5.4–5.6, §5.14: `hls1` — файл по качеству и `master-v1aN` по озвучке; `hls2` — один адаптивный поток. */
function resolved(
  ctx: AppContext, item: ItemDetail, unit: MediaUnit, ref: EpRef, position: number | "none", links: MediaLinks,
  step: PlayStep, o: ResolveOverrides,
): ResolvedPlay {
  const prefs = ctx.prefs.get();
  const sp = selectPrefs(prefs, item.id);
  const audio = o.audio ?? pickAudio(unit.audios, sp);
  let url: string | undefined;
  let quality = HLS2_QUALITY;
  let audioText = "";
  if (step.mode === "hls1") {
    const file = pickFile(links.files, sp);
    url = file?.urls.hls;
    if (file !== undefined && url !== undefined) {
      url = audio === undefined ? url : withAudio(url, audio.index);
      quality = qualityLabel(file);
      audioText = audio === undefined ? "" : audioTitle(audio);
    }
  } else {
    url = links.files.find((f) => f.urls.hls2 !== undefined)?.urls.hls2;
  }
  if (url === undefined) throw new KpError("KP-BAD", "no-stream-url", undefined, `mid ${ref.mid} ${step.mode}`);

  const props: PlayerPropsInput = { itemId: item.id, ref, duration: unit.duration };
  const { prev, next } = neighbours(item, ref.mid);
  if (prev !== undefined) props.prev = prev;
  if (next !== undefined) props.next = next;
  if (o.probe !== undefined) props.probe = o.probe;
  if (o.ticks !== undefined) props.ticks = o.ticks;

  const out: ResolvedPlay = {
    url: withLoc(url, prefs.loc), label: playLabel(item, ref), position, quality, audio: audioText,
    mode: step.mode, step: step.step, props, run: ctx.tracker.newRun(),
  };
  if (o.restart) out.restart = true;
  const sub = pickSubtitle(links.subtitles, sp, audio?.lang);
  if (sub !== undefined) out.subtitle = { ...sub, url: withLoc(sub.url, prefs.loc) };
  return out;
}

/**
 * Сериал — «<название> · 1 сезон, 4 серия»; фильм из частей — «<название> · Часть 2»; фильм — название (спец. §9.2).
 * Та же метка у перезапуска из панели плеера (`panels.ts`).
 */
export function playLabel(item: ItemDetail, ref: EpRef): string {
  const title = ruTitle(item.title);
  if (ref.season > 0) return `${title} · ${episodeName(ref)}`;
  return item.videos.length > 1 ? `${title} · Часть ${ref.video}` : title;
}
