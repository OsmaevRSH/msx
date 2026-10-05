import * as tvx from "../vendor/tvx-plugin-module.min.js";
import { createApp } from "./app/create-app.ts";
import { installDebugHooks } from "./app/debug.ts";
import { KpHandler, TvxHost } from "./bridge/tvx-handler.ts";

// Момент выполнения бандла — начало холодного старта для CDG-10.
const t0 = performance.now();
// Спец. §6.2: @P — адрес, по которому MSX загрузила плагин, вплоть до схемы и слеша.
const P = location.origin + location.pathname;

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
    });
    installDebugHooks(ctx, app);
    tvx.InteractionPlugin.setupHandler(new KpHandler(app));
    tvx.InteractionPlugin.init();
  });
}
