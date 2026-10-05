/** Хост MSX глазами приложения: в браузере — `TvxHost` над `TVXInteractionPlugin`, в тестах — `FakeHost`. */
export interface MsxHost {
  executeAction(action: string, data?: unknown): void;
  requestData(dataId: string): Promise<any>;
}

/** Приложение глазами моста: `KpHandler` пробрасывает в него вызовы `TVXInteractionPluginHandler`. */
export interface PluginApp {
  ready(): void;
  handleRequest(dataId: string, data: unknown): Promise<unknown>;
  handleData(data: any): void;
  handleEvent(event: any): void;
}
