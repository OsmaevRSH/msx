// Локальный тип до этапа 16, который заменит его на MsxHost из src/bridge/host.ts.
export interface MsxHostLike {
  executeAction(action: string, data?: unknown): void;
  requestData(dataId: string): Promise<any>;
}

/** Хост MSX для тестов: записывает действия и отвечает на requestData из `responses`. */
export class FakeHost implements MsxHostLike {
  actions: { action: string; data?: unknown }[] = [];
  /** Ответы requestData по dataId; функция вызывается при каждом запросе. */
  responses = new Map<string, unknown>();
  /** dataId всех вызовов requestData по порядку. */
  requests: string[] = [];

  executeAction(action: string, data?: unknown): void {
    this.actions.push(data === undefined ? { action } : { action, data });
  }

  async requestData(dataId: string): Promise<any> {
    this.requests.push(dataId);
    const r = this.responses.get(dataId);
    return typeof r === "function" ? (r as (id: string) => unknown)(dataId) : r;
  }

  clearActions(): void {
    this.actions = [];
  }
}
