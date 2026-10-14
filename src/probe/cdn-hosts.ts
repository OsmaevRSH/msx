// Хосты видео KinoPub для теста скорости CDN (спец. §16.7) — им же `tools/build.mjs` открывает `connect-src` CSP
// (§15.4). Мастер-плейлисты отдаёт ротируемый фронт-хост (`cdn2cdn.com` → `cdn2site.com` → `digital-cdn.net`, бывает и
// API `/manifest`), плейлисты серий и сегменты — узлы `<uuid>.<город>-static-NN.cdntogo.net` (research kinopub-api §2,
// §7.2; логи lampa_kinopub). Плееру MSX CSP плагина не мешает — она нужна только тесту.

/** Источники `connect-src` сверх API: `*.` — любой поддомен. */
export const CDN_SOURCES: readonly string[] = ["https://*.cdntogo.net", "https://cdn2cdn.com", "https://cdn2site.com", "https://digital-cdn.net"];

/**
 * Пустит ли CSP плагина запрос к `url`: origin API (`apiBases`) или источник `CDN_SOURCES`. Запрос, который CSP режет,
 * падает так же, как без CORS или без сети, — тест называет причину сам, а не «нет ответа».
 */
export function cspAllows(url: string, apiBases: readonly string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const origin = (s: string): string | undefined => {
    try {
      return new URL(s).origin;
    } catch {
      return undefined;
    }
  };
  if (apiBases.some((b) => origin(b) === u.origin)) return true;
  if (u.protocol !== "https:" || u.port !== "") return false;
  return CDN_SOURCES.some((s) => {
    const host = s.slice("https://".length);
    return host.startsWith("*.") ? u.hostname.endsWith(host.slice(1)) : u.hostname === host;
  });
}
