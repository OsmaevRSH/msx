import type { KvStore } from "../bridge/storage.ts";

// Пункты меню S3 (спец. §11 S3, S12): порядок и скрытые пункты в `kp.cfg.menu`. Хранятся только отличия от умолчания;
// чужие и повторные id, скрытие закреплённых пунктов и всё, что не массив строк, отбрасываются при чтении (как `FlagStore`).

export interface MenuCfg {
  /** Все известные пункты, в том числе скрытые. */
  order: string[];
  hidden: string[];
}

const KEY = "menu";
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export class MenuStore {
  private store: KvStore;
  private defaults: readonly string[];
  /** Пункты, которые нельзя скрыть («Просмотр и аккаунт»). */
  private locked: ReadonlySet<string>;

  constructor(store: KvStore, defaults: readonly string[], locked: readonly string[]) {
    this.store = store;
    this.defaults = defaults;
    this.locked = new Set(locked);
  }

  /**
   * Сохранённый порядок без чужих id; пункты, которых в нём нет (появились в новой версии), встают после своего соседа
   * по умолчанию — или первыми, если соседа выше нет.
   */
  get(): MenuCfg {
    const raw = this.store.get<{ order?: unknown; hidden?: unknown }>("cfg", KEY);
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

  canHide(id: string): boolean {
    return !this.locked.has(id);
  }

  /** Порядок по умолчанию и без скрытых не хранится; закреплённый пункт не скрывается. */
  set(cfg: MenuCfg): void {
    const order = cfg.order.join() === this.defaults.join() ? undefined : cfg.order;
    const hidden = cfg.hidden.filter((id) => !this.locked.has(id));
    const out = { ...(order === undefined ? {} : { order }), ...(hidden.length > 0 ? { hidden } : {}) };
    if (Object.keys(out).length === 0) this.store.remove("cfg", KEY);
    else this.store.set("cfg", KEY, out);
  }

  reset(): void {
    this.store.remove("cfg", KEY);
  }
}
