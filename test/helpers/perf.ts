import assert from "node:assert/strict";

/**
 * Бюджеты по реальному времени (CNFR-03, CNFR-04: init ≤ 100 мс, ответ из памяти и L2 ≤ 50 мс) проверяются только в
 * режиме `KP_PERF=1` — `npm run perf` на спокойной машине. В `npm test` и CI их смысл держат логические проверки:
 * поддельное время FakeClock, «нет запроса в сеть», «ответ раньше ответа mock». Реальные миллисекунды зависят от
 * загрузки машины (раннер CI, параллельные прогоны), а не от кода.
 */
export const PERF = process.env.KP_PERF === "1";

/** Реальное время `ms` уложилось в `budgetMs` — только при `KP_PERF=1`. */
export function assertRealMs(ms: number, budgetMs: number, what: string): void {
  if (!PERF) return;
  assert.ok(ms <= budgetMs, `${what}: ${ms.toFixed(1)} ms > ${budgetMs} ms of real time`);
}
