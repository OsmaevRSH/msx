import type { AppContext } from "../app/context.ts";
import { fmtCount } from "../core/format.ts";
import { gridEdges } from "../msx/edges.ts";
import type { Grid } from "../msx/edges.ts";
import type { MsxContentItem, MsxContentRoot } from "../msx/types.ts";
import { ids } from "../router/ids.ts";
import { RETRY_CONTENT, errorScreen } from "./error.ts";
import { gridPreload } from "./tiles.ts";

// «Спорт» S16 (спец. §11): каналы прямого эфира KinoPub `/v1/tv` — раздел `sporttv` официального PWA и «Спорт» webOS;
// трансляции спортивные, KinoPub даёт их бонусом «как есть». Плитка — логотип 240×180 (4:3) и название, бейдж «Эфир».
// Эфир — HLS live: плитка запускает `video:<stream>` прямо, без resolve, поэтому у запуска нет `kp:*` — трекер его не
// считает просмотром (`load_without_kp`), `marktime` и прогресса нет. Адреса потока могут быть подписаны: список каналов
// только в L1, 2 мин, без сети — до часа из кэша с пометкой «нет связи».

/** Плитки 3×2 в сетке 12×6: 4 канала в ряд. */
const GRID: Grid = { width: 12, height: 6, w: 3, h: 2 };
/** Логотип над названием: 1,3 единицы — почти 4:3 при ширине плитки. */
const LOGO_H = 1.3;
const T = {
  headline: "Спорт",
  live: "Эфир",
  channels: ["канал", "канала", "каналов"] as const,
  empty: "Сейчас трансляций нет. Каналы KinoPub — бонус, работают как есть",
  refresh: "Обновить",
  offline: "{ico:msx-yellow:history} нет связи",
};

export async function tvScreen(ctx: AppContext): Promise<MsxContentRoot> {
  let got;
  try {
    got = await ctx.repo.tv();
  } catch (e) {
    return errorScreen(ctx, e, ids.tv());
  }
  const channels = got.value;
  const root: MsxContentRoot = { type: "list", flag: "tv", cache: false, reuse: false, ...gridPreload(ctx), headline: T.headline };
  root.extension = [channels.length > 0 ? `${T.live} · ${fmtCount(channels.length, T.channels)}` : "", got.offline === undefined ? "" : T.offline]
    .filter((x) => x !== "").join(" · ");
  if (channels.length === 0) {
    root.pages = [{ items: [
      { type: "space", layout: `0,0,${GRID.width},2`, text: T.empty },
      { type: "button", layout: "0,2,3,1", label: T.refresh, action: RETRY_CONTENT },
    ] }];
    return root;
  }
  const items = channels.map((c, i): MsxContentItem => ({
    id: `tv${c.id}`, ...(i === 0 ? { focus: true } : {}), titleHeader: c.title, image: c.logo, playerLabel: c.title,
    badge: T.live, action: `video:${c.stream}`,
  }));
  // Свойства плеера от плитки (Extended Properties MSX): у эфира нет позиции — полоса прогресса скрыта, «Назад» закрывает
  // плеер, а не оставляет эфир играть под экраном (проверено в web MSX 0.1.167).
  root.template = {
    layout: `0,0,${GRID.w},${GRID.h}`, color: "msx-glass", round: true, imageHeight: LOGO_H, imageFiller: "fit", imageBoundary: true,
    badgeColor: "msx-red", truncation: "titleHeader", enumerate: false,
    properties: { "control:type": "extended", "progress:display": "false", "trigger:back": "player:eject" },
  };
  const framed = gridEdges(items, GRID, { top: "shift", bottom: true });
  root.items = framed.items;
  if (framed.inserts !== undefined) root.inserts = framed.inserts;
  return root;
}
