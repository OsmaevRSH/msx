/**
 * Текущий контентный экран (спец. §6.3, CD-16): асинхронная перерисовка (`reload:content`, `replace:content`)
 * допустима только для него. Панели и resolve открываются поверх экрана и его не меняют; `init` — меню, не контент.
 */
export class CurrentScreen {
  private cur: string | undefined;

  onRequest(dataId: string): void {
    if (dataId === "init" || dataId.startsWith("panel:") || dataId.startsWith("play:")) return;
    this.cur = dataId;
  }

  get(): string | undefined {
    return this.cur;
  }

  isCurrent(dataId: string): boolean {
    return this.cur === dataId;
  }
}
