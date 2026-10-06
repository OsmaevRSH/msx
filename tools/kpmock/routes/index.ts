import type { Router } from "../router.ts";
import type { MockState } from "../state.ts";
import { register as bookmarks } from "./bookmarks.ts";
import { register as catalog } from "./catalog.ts";
import { register as cdn } from "./cdn.ts";
import { register as collections } from "./collections.ts";
import { register as device } from "./device.ts";
import { register as items } from "./items.ts";
import { register as oauth } from "./oauth.ts";
import { register as tv } from "./tv.ts";
import { register as types } from "./types.ts";
import { register as user } from "./user.ts";
import { register as watching } from "./watching.ts";

/** Порядок важен только при равных маршрутах (см. Router): этапы 6–8 наполняют модули, не трогая этот файл. */
export function registerAll(r: Router, state: MockState, base: () => string): void {
  for (const reg of [types, oauth, device, user, catalog, items, cdn, watching, bookmarks, collections, tv]) reg(r, state, base);
}
