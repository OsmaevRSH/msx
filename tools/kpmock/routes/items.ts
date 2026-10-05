import type { Router } from "../router.ts";
import type { MockState } from "../state.ts";

// Заглушка этапа 3; маршруты добавляет этап 7.
export function register(r: Router, s: MockState, base: () => string): void {}
