import type { ItemDetail, MediaUnit } from "../api/models.ts";
import type { AppContext } from "../app/context.ts";
import { KP_CLIENT } from "../config/client.ts";
import { sleep } from "../core/clock.ts";
import { KpError, toKpError } from "../core/errors.ts";
import { ruTitle } from "../core/format.ts";
import { fnv1a } from "../core/hash.ts";
import { stat } from "../core/metrics.ts";
import { mergeSchema, schemaOf } from "./fingerprint.ts";
import type { CheckId, CheckResult } from "./runner.ts";
import { loadTitle, result, saveSchema, saveTitle } from "./store.ts";
import type { SchemaLog, TestTitle, UnitRef } from "./store.ts";

// Проверки пробника уровня API (спец. §16.2: CDG-01…04, 08). Где важно поведение браузера (CORS), — сырой
// `ctx.fetch`; остальное — через KpApi с его повторами и лимитером.

/** Спец. §5.3: проба — всегда этот запрос без настоящего токена (CM-01). */
const TYPES_PROBE = "/v1/types?access_token=x";
const CORS_ATTEMPTS = 3;
const CORS_PAUSE_MS = 5000;
const PROBE_TIMEOUT_MS = 8000;
const OAUTH_TIMEOUT_MS = 15_000;
const DEVICE_FIELDS = ["code", "user_code", "verification_uri", "interval", "expires_in"] as const;
const TIMED_REPEATS = 3;
const CATALOG_PERPAGE = 48;
const TITLE_CANDIDATES = 10;
const PROBE_TIME = 120;
const SERIES = new Set(["serial", "docuserial", "tvshow"]);

const needLogin = (ctx: AppContext, id: CheckId): CheckResult => result(ctx, id, null, "нужен вход");
const base = (ctx: AppContext): string => ctx.flags.get().apiBase.replace(/\/+$/, "");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Сырой простой запрос: без своих заголовков, `credentials: "omit"`, таймаут через Clock; тело читается внутри таймаута. */
async function rawSend(ctx: AppContext, url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; text: string }> {
  const ac = new AbortController();
  const timer = ctx.clock.setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await ctx.fetch(url, { ...init, credentials: "omit", signal: ac.signal });
    return { status: res.status, text: init.mode === "no-cors" ? "" : await res.text() };
  } finally {
    ctx.clock.clearTimeout(timer);
  }
}

// --- CDG-01 ---

/**
 * CORS GET (спец. §5.3 п. 3, §16.2). Ответ прочитан — значит, ACAO есть: сам заголовок из JS не читается
 * (решение Р-12). `KP-CORS` — только если обычный запрос падает, а `no-cors` к тому же URL проходит, 3 раза подряд.
 */
export async function checkCors(ctx: AppContext): Promise<CheckResult> {
  const url = base(ctx) + TYPES_PROBE;
  let noCorsOk = 0;
  for (let i = 1; i <= CORS_ATTEMPTS; i++) {
    const t0 = ctx.clock.perf();
    try {
      const { status } = await rawSend(ctx, url, { method: "GET", mode: "cors" }, PROBE_TIMEOUT_MS);
      const values = { status, readable: true, attempts: i, ms: Math.round(ctx.clock.perf() - t0) };
      const onError = status === 429 || status >= 500 ? `; ответ ${status} тоже с ACAO` : "";
      return result(ctx, "CDG-01", true, `ответ ${status} прочитан, ACAO есть${onError}`, values);
    } catch {
      try {
        await rawSend(ctx, url, { method: "GET", mode: "no-cors" }, PROBE_TIMEOUT_MS);
        noCorsOk += 1;
      } catch {
        // и no-cors не прошёл: сеть или VPN
      }
    }
    if (i < CORS_ATTEMPTS) await sleep(ctx.clock, CORS_PAUSE_MS);
  }
  const values = { readable: false, attempts: CORS_ATTEMPTS, noCorsOk };
  if (noCorsOk === CORS_ATTEMPTS) {
    return result(ctx, "CDG-01", false, "KP-CORS: API отвечает без CORS — клиентская схема невозможна (Plan B)", { ...values, code: "KP-CORS" });
  }
  return result(ctx, "CDG-01", false, "KP-NET: нет связи с API — проверьте VPN и повторите", { ...values, code: "KP-NET" });
}

// --- CDG-02 ---

/** CORS POST: `/oauth2/device` с параметрами в query и пустым телом; код входа не подтверждается и не сохраняется. */
export async function checkOauthPost(ctx: AppContext): Promise<CheckResult> {
  const q = new URLSearchParams({ grant_type: "device_code", client_id: KP_CLIENT.id, client_secret: KP_CLIENT.secret });
  let res: { status: number; text: string };
  try {
    res = await rawSend(ctx, `${base(ctx)}/oauth2/device?${q.toString()}`, { method: "POST", mode: "cors" }, OAUTH_TIMEOUT_MS);
  } catch {
    return result(ctx, "CDG-02", false, "KP-NET: ответ /oauth2 не прочитан (нет ACAO или связи)", { readable: false, code: "KP-NET" });
  }
  let json: unknown;
  try {
    json = JSON.parse(res.text);
  } catch {
    json = undefined;
  }
  const has = (f: string): boolean => isObj(json) && json[f] !== undefined && json[f] !== null && json[f] !== "";
  const missing = DEVICE_FIELDS.filter((f) => !has(f));
  const ok = res.status === 200 && missing.length === 0;
  const values: CheckResult["values"] = { status: res.status, readable: true, fields: DEVICE_FIELDS.length - missing.length };
  if (missing.length > 0) values.missing = missing.join(",");
  const summary = ok ? "200, все 5 полей" : `${res.status}${missing.length > 0 ? `, нет полей: ${missing.join(", ")}` : ""}`;
  return result(ctx, "CDG-02", ok, summary, values);
}

// --- CDG-03 ---

/** Тело `URLSearchParams` принято: название устройства меняется на пробное, затем возвращается исходное. */
export async function checkPostBody(ctx: AppContext): Promise<CheckResult> {
  if (!ctx.auth.isLoggedIn()) return needLogin(ctx, "CDG-03");
  const { api } = ctx;
  const postBody = ctx.flags.get().postBody;
  const info = await api.deviceInfo();
  const probeTitle = `MSX probe ${fnv1a(`${ctx.state.bootId}:${ctx.clock.now()}`).slice(0, 4)}`;
  let accepted = false;
  let failure: unknown;
  try {
    await api.deviceNotify(probeTitle, info.hardware, info.software);
    accepted = (await api.deviceInfo()).title === probeTitle;
  } catch (e) {
    failure = e;
  }
  let restored = !accepted;
  try {
    await api.deviceNotify(info.title, info.hardware, info.software);
    if (accepted) restored = (await api.deviceInfo()).title === info.title;
  } catch {
    restored = false;
  }
  if (failure !== undefined) throw failure;
  const values = { accepted, restored, postBody };
  if (!accepted) return result(ctx, "CDG-03", false, `тело POST (${postBody}) не принято: нужен postBody=query`, values);
  return result(ctx, "CDG-03", restored, `тело POST (${postBody}) принято${restored ? "" : "; название устройства не вернулось"}`, values);
}

// --- CDG-04 ---

async function timed<T>(ctx: AppContext, into: number[], fn: () => Promise<T>): Promise<T> {
  const t0 = ctx.clock.perf();
  const v = await fn();
  into.push(Math.round(ctx.clock.perf() - t0));
  return v;
}

function firstUnit(d: ItemDetail): MediaUnit | undefined {
  return d.videos[0] ?? d.seasons[0]?.episodes[0];
}

/** Отпечаток схемы (спец. §13): «путь → тип» по эндпоинтам; у фильма и сериала схемы объединяются. */
async function fingerprint(ctx: AppContext, ids: number[], mid: number | undefined): Promise<number> {
  const out: SchemaLog = {};
  const take = async (label: string, path: string, query?: Record<string, string | number>): Promise<void> => {
    try {
      const s = schemaOf(await ctx.api.raw(path, query));
      const prev = out[label];
      out[label] = prev === undefined ? s : mergeSchema(prev, s);
    } catch (e) {
      if (out[label] === undefined) out[label] = { "!error": toKpError(e).code };
    }
  };
  await take("/v1/user", "/v1/user");
  await take("/v1/items", "/v1/items", { perpage: 2 });
  for (const id of ids) await take("/v1/items/:id", `/v1/items/${id}`, { nolinks: 1 });
  if (mid !== undefined) await take("/v1/items/media-links", "/v1/items/media-links", { mid });
  for (const id of ids) await take("/v1/watching", "/v1/watching", { id });
  await take("/v1/history", "/v1/history", { perpage: 2 });
  await take("/v1/bookmarks", "/v1/bookmarks");
  await take("/v1/watching/serials", "/v1/watching/serials");
  saveSchema(ctx.store, out);
  return Object.values(out).reduce((n, s) => n + Object.keys(s).length, 0);
}

/** Вход и API: токены есть, подписка активна, времена `items`/`items/{id}` (p50/p95), отпечаток схемы. */
export async function checkApi(ctx: AppContext): Promise<CheckResult> {
  if (!ctx.auth.isLoggedIn()) return needLogin(ctx, "CDG-04");
  const { api } = ctx;
  const userMs: number[] = [];
  const itemsMs: number[] = [];
  const itemMs: number[] = [];
  const user = await timed(ctx, userMs, () => api.user());
  let items: { id: number; type: string }[] = [];
  for (let i = 0; i < TIMED_REPEATS; i++) items = (await timed(ctx, itemsMs, () => api.items({ page: 1, perpage: CATALOG_PERPAGE }))).items;
  const first = items[0];
  if (first === undefined) return result(ctx, "CDG-04", false, "каталог пуст", { subscription: user.subscription.active });
  let detail: ItemDetail | undefined;
  for (let i = 0; i < TIMED_REPEATS; i++) detail = await timed(ctx, itemMs, () => api.item(first.id));
  const serial = items.find((it) => it.id !== first.id && SERIES.has(it.type));
  const ids = serial === undefined ? [first.id] : [first.id, serial.id];
  const schemaPaths = await fingerprint(ctx, ids, detail === undefined ? undefined : firstUnit(detail)?.id);
  const all = stat([...userMs, ...itemsMs, ...itemMs]);
  const list = stat(itemsMs);
  const card = stat(itemMs);
  const active = user.subscription.active;
  const values = {
    tokens: true, subscription: active, days: user.subscription.days, p50: all.p50, p95: all.p95,
    itemsP50: list.p50, itemsP95: list.p95, itemP50: card.p50, itemP95: card.p95, schemaPaths,
  };
  const times = `items p50 ${list.p50} мс, p95 ${list.p95} мс; карточка p50 ${card.p50} мс, p95 ${card.p95} мс`;
  return result(ctx, "CDG-04", active, `${active ? "подписка активна" : "подписка не активна"}; ${times}`, values);
}

// --- CDG-08 ---

function unitRef(u: MediaUnit, s: number): UnitRef {
  return { mid: u.id, s, e: u.number, duration: u.duration };
}

function testTitleOf(d: ItemDetail): TestTitle | undefined {
  const seasons = [...d.seasons].sort((a, b) => a.number - b.number);
  const [s1, s2] = seasons;
  const e1 = s1?.episodes[0];
  const last = s1?.episodes[s1.episodes.length - 1];
  const s2e1 = s2?.episodes[0];
  if (s1 === undefined || s2 === undefined || e1 === undefined || last === undefined || s2e1 === undefined) return undefined;
  if (e1.audios.length < 2) return undefined;
  return {
    id: d.id, title: ruTitle(d.title), seasons: seasons.length, audios: e1.audios.length,
    s1e1: unitRef(e1, s1.number), s1Last: unitRef(last, s1.number), s2e1: unitRef(s2e1, s2.number),
  };
}

/** Тестовый тайтл: среди 10 свежих сериалов — первый с ≥ 2 сезонами и ≥ 2 озвучками в S1E1; хранится в `kp.cfg.probe.title`. */
export async function pickTestTitle(ctx: AppContext): Promise<TestTitle | undefined> {
  const saved = loadTitle(ctx.store);
  if (saved !== undefined) return saved;
  const page = await ctx.api.items({ type: "serial", sort: "-updated", page: 1, perpage: TITLE_CANDIDATES });
  for (const it of page.items.slice(0, TITLE_CANDIDATES)) {
    const t = testTitleOf(await ctx.api.item(it.id));
    if (t !== undefined) {
      saveTitle(ctx.store, t);
      return t;
    }
  }
  return undefined;
}

/**
 * `marktime` и `toggle` на S1E1 тестового тайтла; исходные позиция и статус возвращаются. `toggle` не повторяется
 * вслепую (CM-01): сбой — ✗ с просьбой проверить отметку на сайте.
 */
export async function checkProgress(ctx: AppContext): Promise<CheckResult> {
  if (!ctx.auth.isLoggedIn()) return needLogin(ctx, "CDG-08");
  const title = await pickTestTitle(ctx);
  if (title === undefined) return result(ctx, "CDG-08", false, "нет тестового тайтла: среди 10 свежих сериалов нет подходящего");
  const { api } = ctx;
  const { id } = title;
  const { s, e } = title.s1e1;
  const read = async (): Promise<{ time: number; status: -1 | 0 | 1 }> => {
    const u = (await api.watching(id)).find((x) => x.season === s && x.number === e);
    if (u === undefined) throw new KpError("KP-BAD", "no-watching-unit");
    return { time: u.time, status: u.status };
  };
  const orig = await read();
  await api.marktime(id, e, PROBE_TIME, s);
  const posOk = (await read()).time === PROBE_TIME;
  await api.marktime(id, e, orig.time, s);
  const was = orig.status === 1 ? 1 : 0;
  let toggleOk: boolean;
  try {
    toggleOk = (await api.toggle(id, e, s)).watched !== was;
    toggleOk = (await api.toggle(id, e, s)).watched === was && toggleOk;
  } catch (err) {
    const code = toKpError(err).code;
    return result(ctx, "CDG-08", false, `toggle: ${code}; проверьте отметку на сайте (S${s}E${e} «${title.title}»)`, { id, posOk, code });
  }
  let now = await read();
  // marktime делает серию начатой, а toggle назад — непросмотренной: начатую возвращает позиция.
  if (now.status !== orig.status && orig.status === 0) {
    await api.marktime(id, e, orig.time, s);
    now = await read();
  }
  const restored = now.time === orig.time && now.status === orig.status;
  const ok = posOk && toggleOk && restored;
  const parts = [posOk ? "позиция сохраняется" : "позиция не сохранилась", toggleOk ? "toggle отвечает watched" : "toggle не переключил"];
  if (!restored) parts.push("исходное состояние не вернулось — проверьте отметку на сайте");
  return result(ctx, "CDG-08", ok, parts.join("; "), { id, s, e, posOk, toggleOk, restored });
}
