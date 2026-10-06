import type { AppContext } from "../app/context.ts";
import type { HistoryEntry, ItemSummary, SerialWatching, Titled } from "../api/models.ts";
import type { ReqClass } from "../api/transport.ts";
import type { Got } from "../cache/swr.ts";
import { sleep } from "../core/clock.ts";
import { fmtCount } from "../core/format.ts";
import { contentAction } from "../msx/actions.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { ids } from "../router/ids.ts";
import { film } from "./continue.ts";
import { errorScreen } from "./error.ts";
import { fill, remember } from "./list.ts";
import type { ListEntry } from "./list.ts";
import { FILMS, SERIALS } from "./list-head.ts";
import { personalHash, scheduleRefresh, trackScreen } from "./refresh.ts";
import { GRID, gridPreload, gridTemplate, posterTiles } from "./tiles.ts";

// «Я смотрю» S15 (спец. §11): сериалы списка «Я смотрю» KinoPub (`/v1/watching/serials?subscribed=1`, как у Kodi и
// других клиентов) — с новыми сериями первыми, бейдж «+N» и доля просмотренных серий; затем начатые фильмы
// (`/v1/watching/movies`) — прогресс и остаток из истории и оверлея ТВ, как у «Продолжить» главной. Плитки — те же, что
// в списках S5; окно ≤ 96 плиток и ≤ 32 КБ, догрузка `extend` и стражи краёв — механизмом списков (`list.ts`, ключ
// `watching`). Данные — SWR (1 мин): из кэша сразу, устаревшее — фоном, экран заменяется `replace:content:watching`,
// только если он текущий и изменилась его персональная часть; после просмотра — так же (`refreshAfterPlayback`).

const FLAG = "watching";
/** Ключ окна в `state.lists`: не похож на ключ списка (b64url `src|…`), сообщения `extend:watching:…` — его. */
const KEY = "watching";
/** Как у главной (D-40): устаревшие персональные данные обновляются фоном, экран сверяется через 3 с. */
const RECHECK_MS = 3000;
const T = {
  headline: "Я смотрю",
  empty: "Здесь появятся сериалы и фильмы, которые вы смотрите",
  find: "{ico:search} Найти фильм",
  offline: "{ico:msx-yellow:history} нет связи",
};

interface Snap { serials: SerialWatching[]; movies: ItemSummary[]; history: HistoryEntry[]; stale: boolean; offline: boolean }

const ok = <V>(r: PromiseSettledResult<Got<V>>): Got<V> | undefined => (r.status === "fulfilled" ? r.value : undefined);
const pct = (p: number): number => Math.round(p * 100) / 100;

/** Оба списка не ответили и кэша нет — ошибка; история нужна только для прогресса фильмов. */
async function load(ctx: AppContext, cls: ReqClass): Promise<Snap> {
  const [s, m, h] = await Promise.allSettled([
    ctx.repo.serials({ cls, subscribed: true }), ctx.repo.watchingMovies({ cls }), ctx.repo.history({ cls }),
  ]);
  if (s.status === "rejected" && m.status === "rejected") throw s.reason;
  const gots = [ok(s), ok(m), ok(h)];
  return {
    serials: ok(s)?.value ?? [], movies: ok(m)?.value ?? [], history: ok(h)?.value ?? [],
    stale: [s, m, h].some((r) => r.status === "rejected") || gots.some((g) => g?.stale === true),
    offline: gots.some((g) => g?.offline !== undefined),
  };
}

/** Плитки и тайтлы окна: сериалы с новыми сериями — первыми, затем остальные и фильмы, кроме досмотренных на ТВ. */
function tilesOf(ctx: AppContext, s: Snap): { items: Titled[]; tiles: MsxContentItem[]; serials: number } {
  const serials = [...s.serials.filter((w) => w.new > 0), ...s.serials.filter((w) => w.new <= 0)];
  const items: Titled[] = [];
  const deco: Partial<MsxContentItem>[] = [];
  for (const w of serials) {
    items.push(w);
    const d: Partial<MsxContentItem> = w.total > 0 ? { progress: pct(Math.min(1, w.watched / w.total)), progressColor: "msx-blue" } : {};
    if (w.new > 0) d.badge = `+${w.new}`;
    deco.push(d);
  }
  for (const it of s.movies) {
    const e = s.history.find((h) => h.item.id === it.id);
    const f = e === undefined ? undefined : film(e, ctx.overlay.get);
    if (e !== undefined && f === undefined) continue;
    items.push(it);
    deco.push(f?.progress === undefined ? {} : { progress: pct(f.progress), progressColor: "msx-blue", stamp: f.stamp });
  }
  const tiles = posterTiles(ctx, items).map((t, i) => ({ ...t, ...deco[i] }));
  return { items, tiles, serials: serials.length };
}

/** Экран и хеш его персональной части; окно прежнего показа сохраняется, если число плиток не изменилось. */
function render(ctx: AppContext, s: Snap): { root: MsxContentRoot; hash: string } {
  const { items, tiles, serials } = tilesOf(ctx, s);
  const root: MsxContentRoot = { type: "list", flag: FLAG, cache: false, reuse: false, ...gridPreload(ctx), headline: T.headline };
  const counts = [serials > 0 ? fmtCount(serials, SERIALS) : "", items.length > serials ? fmtCount(items.length - serials, FILMS) : ""];
  const ext = [...counts, s.offline ? T.offline : ""].filter((x) => x !== "").join(" · ");
  if (ext !== "") root.extension = ext;
  const hash = personalHash([tiles.map((t) => [t.id, t.badge, t.progress, t.stamp]), s.offline]);
  if (items.length === 0) {
    // V-32: экран из меню — вместо бесполезной «Назад» поиск, как у пустых «Закладок».
    root.pages = [{ items: [
      { type: "space", layout: `0,0,${GRID.width},2`, text: T.empty },
      { type: "button", layout: "0,2,3,1", label: T.find, action: contentAction(ctx.P, ids.search()) },
    ] }];
    return { root, hash };
  }
  const prev: ListEntry | undefined = ctx.state.lists.get(KEY);
  const st: ListEntry = { key: KEY, items, tiles, page: 1, totalPages: 1, done: true, dataId: ids.watching() };
  if (prev?.items.length === items.length) Object.assign(st, { from: prev.from, to: prev.to, anchor: prev.anchor, pivot: prev.pivot });
  remember(ctx, KEY, st);
  root.template = gridTemplate(ctx);
  fill(ctx, root, KEY, st);
  return { root, hash };
}

/** Пересчёт для `scheduleRefresh`: фоновые запросы; устаревшее — обновить и сверить через 3 с. */
async function recompute(ctx: AppContext): Promise<string> {
  let s = await load(ctx, "bg");
  if (s.stale) {
    await sleep(ctx.clock, RECHECK_MS);
    s = await load(ctx, "bg");
  }
  return render(ctx, s).hash;
}

export async function watchingScreen(ctx: AppContext): Promise<MsxContentRoot> {
  let s: Snap;
  try {
    s = await load(ctx, "fg");
  } catch (e) {
    return errorScreen(ctx, e, ids.watching());
  }
  const { root, hash } = render(ctx, s);
  // Каждый показ: после плеера `refreshAfterPlayback` сверяет экран именно с этим хешем.
  const spec = { dataId: ids.watching(), flag: FLAG, hash, recompute: () => recompute(ctx) };
  trackScreen(ctx, spec);
  if (s.stale) scheduleRefresh(ctx, spec);
  return root;
}
