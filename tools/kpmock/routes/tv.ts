import { CHANNELS } from "../fixtures.ts";
import { requireAuth } from "../router.ts";
import type { HandlerCtx, MockResponse, Router } from "../router.ts";
import type { MockState } from "../state.ts";
import { posterUrl } from "./cdn.ts";

// Каналы эфира `/v1/tv` (= `/v1/tv/index`, research kinopub-api §7.4, отчёт v1.11): без пагинации, `stream` — HLS live
// (в e2e — WebM: web MSX играет его без HLS), логотипы `s`/`m` 240×180, прочие поля пустые, как у живого API.

function channels(ctx: HandlerCtx): MockResponse {
  requireAuth(ctx);
  const stream = (name: string): string =>
    ctx.scenario.media === "webm" ? `${ctx.base}/cdn/media/sample.webm?tv=${name}` : `${ctx.base}/cdn/tv/${name}/playlist.m3u8`;
  const list = CHANNELS.map((c) => {
    const logo = posterUrl(ctx.base, "logo", c.id);
    return { id: c.id, title: c.title, name: c.name, logos: { s: logo, m: logo }, stream: stream(c.name), playlist: "", embed: "", current: "", status: null };
  });
  return { status: 200, json: { status: 200, channels: list } };
}

export function register(r: Router, _s: MockState, _base: () => string): void {
  r.add("GET", "/v1/tv", channels);
  r.add("GET", "/v1/tv/index", channels);
}
