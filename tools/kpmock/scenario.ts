// Сценарии mock (спец. §14.2, Plan B §12.3). Применяются сервером до обработчика:
// глобальная задержка → первое подходящее правило → rate limit (429).

/** `path` — регулярное выражение по pathname (без query); `times` не задан — без ограничения. */
export interface Rule { path: string; method?: string; status?: number; times?: number; delayMs?: number; noCors?: boolean; drop?: boolean }

export interface Scenario {
  delayMs: number; rules: Rule[]; rateLimit?: { max: number; windowMs: number };
  corsOff: boolean;            // ни одного CORS-заголовка на API → в браузере TypeError (тест KP-CORS)
  noCorsErrors: boolean;       // 429 и 5xx без CORS-заголовков (nginx без always)
  toggleLostResponse: number;  // столько ближайших toggle применить и оборвать соединение (этап 8)
  pendingPolls: number; slowDownAtPoll?: number; codeExpiredAtPoll?: number;   // этап 6
  accessTtlSec: number; refreshInvalid: boolean;                                // этап 6
  clampPages: boolean; media: "playlist" | "webm";                              // этап 7
}

export const DEFAULT_SCENARIO: Scenario = Object.freeze({
  delayMs: 0, rules: Object.freeze([]) as unknown as Rule[], corsOff: false, noCorsErrors: false, toggleLostResponse: 0,
  pendingPolls: 2, accessTtlSec: 3600, refreshInvalid: false, clampPages: true, media: "playlist",
}) as Scenario;

/** Независимая копия: правила меняются при применении (`times`), вызывающий не должен этого видеть. */
export function cloneScenario(s: Scenario): Scenario {
  return structuredClone(s);
}

/** JSON-слияние верхнего уровня; `rules` заменяются целиком. */
export function mergeScenario(base: Scenario, patch: Partial<Scenario>): Scenario {
  return cloneScenario({ ...base, ...patch });
}

/** Первое правило под запрос с неисчерпанным `times`; `times` уменьшается. */
export function takeRule(s: Scenario, method: string, path: string): Rule | undefined {
  for (const rule of s.rules) {
    if (rule.times !== undefined && rule.times <= 0) continue;
    if (rule.method && rule.method.toUpperCase() !== method) continue;
    if (!new RegExp(rule.path).test(path)) continue;
    if (rule.times !== undefined) rule.times -= 1;
    return rule;
  }
  return undefined;
}

/** Окно rate limit: метки времени принятых запросов. Возвращает true, если запрос надо отклонить 429. */
export function overLimit(s: Scenario, window: number[], now: number): boolean {
  if (!s.rateLimit) return false;
  const from = now - s.rateLimit.windowMs;
  while (window.length > 0 && window[0] <= from) window.shift();
  if (window.length >= s.rateLimit.max) return true;
  window.push(now);
  return false;
}
