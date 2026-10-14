import type { KvStore } from "../bridge/storage.ts";

// Недавние запросы поиска S7 (спец. §11 S7): `kp.cfg.recent`, новые сверху, без повторов, не больше 6 — столько строк
// в колонке справа от клавиатуры. Запрос попадает сюда, когда из поиска открыли тайтл. Текст запросов личный: в журнал
// и в отчёт пробника он не попадает, сообщение «недавний запрос» несёт только номер строки.

const KEY = "recent";
/** Строк в колонке подсказок: ряды 1–6 сетки 16×8 (над и под ними — стражи краёв). */
export const RECENT_MAX = 6;
/** Как у строки ввода (`search.ts`): длиннее клавиатура не набирает. */
const MAX_CHARS = 32;

const valid = (q: unknown): q is string => typeof q === "string" && q.trim() !== "" && q.length <= MAX_CHARS;

export function recentQueries(store: KvStore): string[] {
  const raw = store.get<unknown>("cfg", KEY);
  return Array.isArray(raw) ? raw.filter(valid).slice(0, RECENT_MAX) : [];
}

/** Запрос — первым; прежний такой же уходит, лишний с конца отбрасывается. */
export function rememberQuery(store: KvStore, q: string): void {
  if (!valid(q)) return;
  store.set("cfg", KEY, [q, ...recentQueries(store).filter((r) => r !== q)].slice(0, RECENT_MAX));
}

export function forgetQueries(store: KvStore): void {
  store.remove("cfg", KEY);
}
