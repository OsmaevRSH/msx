import type { FileInfo } from "../api/models.ts";

export type Quality = 480 | 720 | 1080 | 2160;

const MASTER_V1 = /master-v1a\d+\.m3u8/;
const BY_QUALITY_ID: Record<number, Quality> = { 1: 480, 2: 720, 3: 1080, 4: 2160 };

/** URL без query и fragment, query (без `?`) и fragment (с `#`). */
function splitUrl(url: string): { path: string; query: string | undefined; hash: string } {
  const h = url.indexOf("#");
  const hash = h >= 0 ? url.slice(h) : "";
  const rest = h >= 0 ? url.slice(0, h) : url;
  const q = rest.indexOf("?");
  return q >= 0 ? { path: rest.slice(0, q), query: rest.slice(q + 1), hash } : { path: rest, query: undefined, hash };
}

/**
 * `hls1`: озвучка выбирается номером в имени master (`master-v1a1` → `master-v1a<audios.index>`, Plan B §5.5, F3).
 * Меняется только путь; query с подписью и `loc` остаётся как есть.
 */
export function withAudio(url: string, index: number): string {
  if (!Number.isInteger(index) || index < 1) return url;
  const { path, query, hash } = splitUrl(url);
  if (!MASTER_V1.test(path)) return url;
  return path.replace(MASTER_V1, `master-v1a${index}.m3u8`) + (query === undefined ? "" : `?${query}`) + hash;
}

/**
 * CDN-сервер задаётся только параметром `loc`; хост менять нельзя (Plan B §5.14, kinopub-api §7.2).
 * Остальные параметры переносятся строкой, без перекодирования.
 */
export function withLoc(url: string, loc?: string): string {
  if (loc === undefined || loc === "") return url;
  const { path, query, hash } = splitUrl(url);
  const param = `loc=${encodeURIComponent(loc)}`;
  const parts = query === undefined || query === "" ? [] : query.split("&");
  const out: string[] = [];
  let replaced = false;
  for (const p of parts) {
    if (p === "loc" || p.startsWith("loc=")) {
      if (!replaced) out.push(param);
      replaced = true;
    } else {
      out.push(p);
    }
  }
  if (!replaced) out.push(param);
  return `${path}?${out.join("&")}${hash}`;
}

/** Анаморфные файлы (1920×800) — по `quality_id`, иначе по ширине, а не по высоте (Plan B §5.4). */
export function qualityOf(f: FileInfo): Quality {
  const byId = BY_QUALITY_ID[f.qualityId];
  if (byId !== undefined) return byId;
  if (f.w >= 3800) return 2160;
  if (f.w >= 1900) return 1080;
  if (f.w >= 1260) return 720;
  return 480;
}

export function qualityLabel(f: FileInfo): string {
  return `${qualityOf(f)}p`;
}
