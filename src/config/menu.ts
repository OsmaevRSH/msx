import type { KvStore } from "../bridge/storage.ts";

// Порядок и видимость (спец. §11 S3, S4, S12): пункты меню — `kp.cfg.menu`, секции главной — `kp.cfg.home`. Хранятся
// только отличия от умолчания; чужие и повторные id, скрытие закреплённых пунктов и всё, что не массив строк,
// отбрасываются при чтении (как `FlagStore`). Версия `v` (фикс 2026-10-22) — у списков с миграцией: настройка старше неё
// один раз показывает пункты `show` и перезаписывается с `v`.

export interface OrderCfg {
  /** Все известные пункты, в том числе скрытые. */
  order: string[];
  hidden: string[];
}

/** Миграция сохранённой настройки: `version` — текущая, `show` — пункты, которые настройка старше неё не скрывает. */
export interface OrderMigration { version: number; show: readonly string[] }

type Raw = { order?: unknown; hidden?: unknown; v?: unknown };

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export class OrderStore {
  private store: KvStore;
  readonly defaults: readonly string[];
  /** Пункты, которые нельзя скрыть («Настройки»). */
  private locked: ReadonlySet<string>;
  private key: string;
  private migration: OrderMigration | undefined;

  constructor(store: KvStore, defaults: readonly string[], locked: readonly string[] = [], key = "menu", migration?: OrderMigration) {
    this.store = store;
    this.defaults = defaults;
    this.locked = new Set(locked);
    this.key = key;
    this.migration = migration;
  }

  /**
   * Сохранённый порядок без чужих id; пункты, которых в нём нет (появились в новой версии), встают после своего соседа
   * по умолчанию — или первыми, если соседа выше нет. Настройка старше версии миграции сохраняется заново без `show`.
   */
  get(): OrderCfg {
    const raw = this.store.get<Raw>("cfg", this.key);
    const m = this.migration;
    const old = m !== undefined && raw !== undefined && raw !== null && raw.v !== m.version;
    const known = (v: unknown): string[] => [...new Set(strs(v).filter((id) => this.defaults.includes(id)))];
    const order = known(raw?.order);
    this.defaults.forEach((id, i) => {
      if (order.includes(id)) return;
      const prev = this.defaults.slice(0, i).reverse().find((p) => order.includes(p));
      order.splice(prev === undefined ? 0 : order.indexOf(prev) + 1, 0, id);
    });
    const hidden = known(raw?.hidden).filter((id) => !this.locked.has(id) && !(old && m?.show.includes(id) === true));
    const cfg = { order, hidden: order.filter((id) => hidden.includes(id)) };
    if (old) this.set(cfg);
    return cfg;
  }

  /** Видимые пункты в порядке пользователя. */
  shown(): string[] {
    const { order, hidden } = this.get();
    return order.filter((id) => !hidden.includes(id));
  }

  canHide(id: string): boolean {
    return !this.locked.has(id);
  }

  /** Порядок по умолчанию и без скрытых не хранится; закреплённый пункт не скрывается; версия миграции — в `v`. */
  set(cfg: OrderCfg): void {
    const order = cfg.order.join() === this.defaults.join() ? undefined : cfg.order;
    const hidden = cfg.hidden.filter((id) => !this.locked.has(id));
    const out = { ...(order === undefined ? {} : { order }), ...(hidden.length > 0 ? { hidden } : {}) };
    if (Object.keys(out).length === 0) this.store.remove("cfg", this.key);
    else this.store.set("cfg", this.key, this.migration === undefined ? out : { ...out, v: this.migration.version });
  }

  reset(): void {
    this.store.remove("cfg", this.key);
  }
}

/** Пункты меню S3 (`src/screens/menu.ts`) — прежнее имя. */
export { OrderStore as MenuStore };
