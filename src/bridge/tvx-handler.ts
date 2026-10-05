import type { AnyObject, TVXInteractionPluginHandler } from "../../vendor/tvx-plugin-module.min.js";
import { errorText } from "../screens/error.ts";
import type { MsxHost, PluginApp } from "./host.ts";

/** То, что нужно мосту от `TVXInteractionPlugin` (структурно; рантайм-объект передаёт `main.ts`). */
export interface TvxPluginLike {
  executeAction(action: string, data?: object): void;
  requestData(dataId: string, callback: (data: any) => void): void;
}

/** `MsxHost` над `TVXInteractionPlugin`: `requestData` с колбэком → Promise. */
export class TvxHost implements MsxHost {
  private tvx: TvxPluginLike;

  constructor(tvx: TvxPluginLike) {
    this.tvx = tvx;
  }

  executeAction(action: string, data?: unknown): void {
    this.tvx.executeAction(action, data as object | undefined);
  }

  requestData(dataId: string): Promise<any> {
    return new Promise((resolve) => this.tvx.requestData(dataId, resolve));
  }
}

const FALLBACK_ERROR = "Ошибка плагина";

function errorResponse(e: unknown): AnyObject {
  try {
    return { error: errorText(e).text };
  } catch {
    return { error: FALLBACK_ERROR };
  }
}

/**
 * Обработчик TVX (спец. §6.1): тонкий проброс в `PluginApp`. На каждый `handleRequest` MSX ждёт ровно один
 * вызов `callback`, поэтому и синхронное исключение, и отказ превращаются в ответ `{ error }`.
 */
export class KpHandler implements TVXInteractionPluginHandler {
  private app: PluginApp;

  constructor(app: PluginApp) {
    this.app = app;
  }

  ready(): void {
    this.app.ready();
  }

  handleRequest(dataId: string, data: AnyObject, callback: (respData?: AnyObject) => void): void {
    let p: Promise<unknown>;
    try {
      p = this.app.handleRequest(dataId, data);
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then(
      (r) => callback(r as AnyObject),
      (e: unknown) => callback(errorResponse(e)),
    ).catch(() => {
      // исключение в самом callback MSX — ответ уже не доставить
    });
  }

  handleData(data: AnyObject): void {
    try {
      this.app.handleData(data);
    } catch {
      // App сам пишет ошибки в журнал; исключение не должно уйти в TVX
    }
  }

  handleEvent(data: AnyObject): void {
    try {
      this.app.handleEvent(data);
    } catch {
      // см. handleData
    }
  }
}
