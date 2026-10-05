import { AUTHORS, COUNTRIES, GENRES, VOICE_TYPES } from "../fixtures.ts";
import { HttpError, requireAuth } from "../router.ts";
import type { Router } from "../router.ts";
import type { MockState } from "../state.ts";

// Пользователь и справочники (research kinopub-api §5.3, §6.1; Plan B §12.3).

export interface ServerLocation { id: number; location: string; name: string }
export interface StreamingType { id: number; code: string; version: number; name: string; description: string }

export const SERVER_LOCATIONS: readonly ServerLocation[] = [
  { id: 1, location: "nl", name: "Netherlands" }, { id: 2, location: "de", name: "Germany" }, { id: 3, location: "ru", name: "Russia" },
];
export const STREAMING_TYPES: readonly StreamingType[] = [
  { id: 1, code: "http", version: 1, name: "HTTP", description: "HTTP pseudo streaming" },
  { id: 2, code: "hls", version: 1, name: "HLS", description: "" },
  { id: 3, code: "hls2", version: 2, name: "HLS2", description: "" },
  { id: 4, code: "hls4", version: 4, name: "HLS4", description: "" },
];
// id совпадают с quality_id файлов фикстур: 480p → 1 … 2160p → 4.
const VIDEO_QUALITIES = [
  { id: 1, title: "480p", quality: 480 }, { id: 2, title: "720p", quality: 720 },
  { id: 3, title: "1080p", quality: 1080 }, { id: 4, title: "2160p", quality: 2160 },
];

/** `type` у /v1/genres — группа жанров или тип контента (research kinopub-api §6.1). */
const GENRE_GROUP: Record<string, keyof typeof GENRES> = {
  movie: "movie", serial: "movie", "3D": "movie", docu: "docu", documovie: "docu", docuserial: "docu",
  tvshow: "tvshow", music: "music", concert: "music",
};

const REFERENCES: Record<string, () => unknown[]> = {
  "server-location": () => SERVER_LOCATIONS.map((l) => ({ ...l })),
  "streaming-type": () => STREAMING_TYPES.map((t) => ({ ...t })),
  "video-quality": () => VIDEO_QUALITIES.map((q) => ({ ...q })),
  "voiceover-type": () => VOICE_TYPES.map(({ id, title }) => ({ id, title })),
  "voiceover-author": () => AUTHORS.map(({ id, title }) => ({ id, title })),
};

function genres(type: string | null): { id: number; title: string; type: string }[] {
  const groups = type === null || type === "" ? (Object.keys(GENRES) as (keyof typeof GENRES)[])
    : Object.hasOwn(GENRE_GROUP, type) ? [GENRE_GROUP[type]] : [];
  return groups.flatMap((g) => GENRES[g].map(({ id, title }) => ({ id, title, type: g })));
}

export function register(r: Router, s: MockState, base: () => string): void {
  r.add("GET", "/v1/user", (ctx) => {
    requireAuth(ctx);
    const now = Math.floor(Date.now() / 1000);
    return {
      status: 200,
      json: {
        status: 200,
        user: {
          username: "tester", reg_date: now - 365 * 86_400,
          subscription: { active: true, end_time: now + 30 * 86_400, days: 30 },
          settings: { show_erotic: false, show_uncertain: true },
          profile: { name: "Тестер", avatar: "" },
        },
      },
    };
  });

  r.add("GET", "/v1/genres", (ctx) => {
    requireAuth(ctx);
    return { status: 200, json: { status: 200, items: genres(ctx.query.get("type")) } };
  });

  r.add("GET", "/v1/countries", (ctx) => {
    requireAuth(ctx);
    return { status: 200, json: { status: 200, items: COUNTRIES.map((c) => ({ ...c })) } };
  });

  r.add("GET", "/v1/references/:name", (ctx) => {
    requireAuth(ctx);
    const items = Object.hasOwn(REFERENCES, ctx.params.name) ? REFERENCES[ctx.params.name] : undefined;
    if (!items) throw new HttpError(404, { status: 404, error: "Not found" });
    return { status: 200, json: { status: 200, items: items() } };
  });
}
