export interface BuildInfo {
  version: string;
  apiBase: string;
  apiFallbackBase: string;
  debugHooks: boolean;
  heartbeatTicks: number;
}

// Подставляет esbuild (define в tools/build.mjs); в тестах и при запуске .ts напрямую не определён.
declare const __KP_BUILD__: BuildInfo | undefined;

const DEFAULTS: BuildInfo = Object.freeze({
  version: "0.0.0-dev",
  apiBase: "https://api.service-kp.com",
  apiFallbackBase: "https://api.srvkp.com",
  debugHooks: false,
  heartbeatTicks: 60,
});

export const BUILD: BuildInfo = typeof __KP_BUILD__ === "undefined" ? DEFAULTS : __KP_BUILD__;
