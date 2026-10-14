import { channel } from "node:diagnostics_channel";
import type { ServerResponse } from "node:http";

/**
 * Намеренная задержка ответа mock — `delayMs` сценария и правила, правило `hang` (`ms: Infinity`): `{ delta: 1, ms }` в
 * начале, `{ delta: -1, ms }` в конце или когда клиент оборвал запрос. FakeClock тестов (test/helpers/fake-clock.ts)
 * решает по `ms`, а не по реальному времени: задержку не длиннее `ioGraceMs` ждёт до конца, как обычный ответ, длиннее —
 * не ждёт, её обгоняют поддельные таймеры. Без подписчиков (CLI, e2e) публикация ничего не стоит.
 */
export const DELAY_CHANNEL = "kpmock:delay";

const delays = channel(DELAY_CHANNEL);

/** Ответ `res` намеренно ждёт `p` — `ms` мс или вечно. Если клиент уже ушёл (`res.closed`), задержка не публикуется. */
export async function deliberate<T>(res: ServerResponse, ms: number, p: Promise<T>): Promise<T> {
  if (res.closed) return p;
  let open = true;
  const end = (): void => {
    if (!open) return;
    open = false;
    res.off("close", end);
    delays.publish({ delta: -1, ms });
  };
  delays.publish({ delta: 1, ms });
  res.once("close", end);
  try {
    return await p;
  } finally {
    end();
  }
}
