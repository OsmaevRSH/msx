import { TYPES } from "../fixtures.ts";
import { requireAuth } from "../router.ts";
import type { Router } from "../router.ts";
import type { MockState } from "../state.ts";

export function register(r: Router, s: MockState, base: () => string): void {
  r.add("GET", "/v1/types", (ctx) => {
    requireAuth(ctx);
    return { status: 200, json: { status: 200, items: TYPES.map((t) => ({ ...t })) } };
  });
}
