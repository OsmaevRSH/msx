import type { KvStore } from "../bridge/storage.ts";

// Порядок и видимость (спец. §11 S3, S4, S12): пункты меню — `kp.cfg.menu`, секции главной — `kp.cfg.home`. Хранятся
// только отличия от умолчания; чужие и повторные id, скрытие закреплённых пунктов и всё, что не массив строк,
// отбрасываются при чтении (как `FlagStore`).

export interface OrderCfg {
  /** Все известные пункты, в том числе скрытые. */
  order: string[];
  hidden: string[];
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export class OrderStore {
  private store: KvStore;
  readonly defaults: readonly string[];
  /** Пункты, которые нельзя скрыть («Просмотр и аккаунт»). */
  private locked: ReadonlySet<string>;
  private key: string;

  constructor(store: KvStore, defaults: readonly string[], locked: readonly string[] = [], key = "menu") {
    this.store = store;
    this.defaults = defaults;
    this.locked = new Set(locked);
    this.key = key;
  }

  /**
   * Сохранённый порядок без чужих id; пункты, которых в нём нет (появились в новой версии), встают после своего соседа
   * по умолчанию — или первыми, если соседа выше нет.
   */
  get(): OrderCfg {
    const raw = this.store.get<{ order?: unknown; hidden?: unknown }>("cfg", this.key);
    const known = (v: unknown): string[] => [...new Set(strs(v).filter((id) => this.defaults.includes(id)))];
    const order = known(raw?.order);
    this.defaults.forEach((id, i) => {
      if (order.includes(id)) return;
      const prev = this.defaults.slice(0, i).reverse().find((p) => order.includes(p));
      order.splice(prev === undefined ? 0 : order.indexOf(prev) + 1, 0, id);
    });
    const hidden = known(raw?.hidden).filter((id) => !this.locked.has(id));
    return { order, hidden: order.filter((id) => hidden.includes(id)) };
  }

  /** Видимые пункты в порядке пользователя. */
  shown(): string[] {
    const { order, hidden } = this.get();
    return order.filter((id) => !hidden.includes(id));
  }

  canHide(id: string): boolean {
    return !this.locked.has(id);
  }

  /** Порядок по умолчанию и без скрытых не хранится; закреплённый пункт не скрывается. */
  set(cfg: OrderCfg): void {
    const order = cfg.order.join() === this.defaults.join() ? undefined : cfg.order;
    const hidden = cfg.hidden.filter((id) => !this.locked.has(id));
    const out = { ...(order === undefined ? {} : { order }), ...(hidden.length > 0 ? { hidden } : {}) };
    if (Object.keys(out).length === 0) this.store.remove("cfg", this.key);
    else this.store.set("cfg", this.key, out);
  }

  reset(): void {
    this.store.remove("cfg", this.key);
  }
}

/** Пункты меню S3 (`src/screens/menu.ts`) — прежнее имя. */
export { OrderStore as MenuStore };
