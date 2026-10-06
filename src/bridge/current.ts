import { isPanelId } from "../router/ids.ts";

/** Где MSX покажет ответ на `dataId`: экран, панель или нигде (`init` — меню, `play:…` — resolve). */
export function slotOf(dataId: string): "content" | "panel" | undefined {
  if (dataId === "init" || dataId.startsWith("play:")) return undefined;
  return isPanelId(dataId) ? "panel" : "content";
}

/**
 * Текущий контентный экран (спец. §6.3, CD-16): асинхронная перерисовка (`reload:content`, `replace:content`)
 * допустима только для него. Панели и resolve открываются поверх экрана и его не меняют; `init` — меню, не контент.
 */
export class CurrentScreen {
  private cur: string | undefined;

  onRequest(dataId: string): void {
    if (slotOf(dataId) === "content") this.cur = dataId;
  }

  get(): string | undefined {
    return this.cur;
  }

  isCurrent(dataId: string): boolean {
    return this.cur === dataId;
  }
}
