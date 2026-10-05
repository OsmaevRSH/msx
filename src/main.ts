import * as tvx from "../vendor/tvx-plugin-module.min.js";
import { createApp } from "./app/create-app.ts";
import { installDebugHooks } from "./app/debug.ts";
import { KpHandler, TvxHost } from "./bridge/tvx-handler.ts";
import type { ProbeModule } from "./probe/lazy.ts";

// Подставляет tools/build.mjs (этап 23b): версия probe.js — его `?v=` — и модули app.js, которые probe.js берёт себе.
declare const __KP_PROBE_V__: string;
declare const __KP_PROBE_SHARED__: Readonly<Record<string, object>>;

interface ProbeScript { v: string; init(shared: Readonly<Record<string, object>>): ProbeModule }

// Момент выполнения бандла — начало холодного старта для CDG-10.
const t0 = performance.now();
// Спец. §6.2: @P — адрес, по которому MSX загрузила плагин, вплоть до схемы и слеша.
const P = location.origin + location.pathname;

/**
 * probe.js — `<script>` рядом с app.js (CSP `script-src 'self'`). GitHub Pages не различает `?v=` (CM-02), поэтому
 * сразу после деплоя старый app.js может получить новый probe.js: файл чужой версии отвергается, как сбой загрузки.
 */
function loadProbe(): Promise<ProbeModule> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.onload = () => {
      el.remove();
      const g = globalThis as { kpProbe?: ProbeScript };
      const p = g.kpProbe;
      delete g.kpProbe;
      try {
        if (p === undefined || p.v !== __KP_PROBE_V__) throw new Error(`probe.js version ${String(p?.v)}, expected ${__KP_PROBE_V__}`);
        resolve(p.init(__KP_PROBE_SHARED__));
      } catch (e) {
        reject(e);
      }
    };
    el.onerror = () => {
      el.remove();
      reject(new Error("probe.js failed to load"));
    };
    el.src = `probe.js?v=${__KP_PROBE_V__}`;
    document.head.appendChild(el);
  });
}

if (window.top === window) {
  // Открыт напрямую, а не в iframe MSX: показать его в web-версии MSX.
  location.replace(`${location.protocol}//msx.benzac.de/?start=menu:request:interaction:init@${P}`);
} else {
  tvx.PluginTools.onReady(() => {
    const { app, ctx } = createApp({
      host: new TvxHost(tvx.InteractionPlugin),
      storage: window.localStorage,
      fetch: window.fetch.bind(window),
      P,
      startedAt: t0,
      loadProbe,
    });
    installDebugHooks(ctx, app);
    tvx.InteractionPlugin.setupHandler(new KpHandler(app));
    tvx.InteractionPlugin.init();
  });
}
