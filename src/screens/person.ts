import type { AppContext } from "../app/context.ts";
import { fmtCount } from "../core/format.ts";
import { fnv1a } from "../core/hash.ts";
import type { MsxContentRoot } from "../msx/types.ts";
import { ids } from "../router/ids.ts";
import { errorScreen } from "./error.ts";
import { emptyItems, fill, remember } from "./list.ts";
import type { ListEntry } from "./list.ts";
import { gridPreload, gridTemplate } from "./tiles.ts";

// Тайтлы актёра или режиссёра (v1.19, спец. §11 S8): `/v1/items/search?field=cast|director&q=<одно имя>` (HC `video.md`:
// поле — одно на запрос, несколько имён через запятую не работают). Без своего источника в `listSource` (его меняет пакет
// «Каталог»): как «Я смотрю», экран кладёт найденное в память списков и рисует его окном `fill` — плитки, стражи и
// `extend` те же, а возврат к экрану отвечает из памяти без сети. Найденное — первые две порции (≤ 96, как поиск S7).

const PER_PAGE = 48;
const T = { cast: "В ролях", director: "Режиссёр", empty: "Ничего не найдено" };
const FOUND = ["тайтл", "тайтла", "тайтлов"] as const;

export async function personScreen(ctx: AppContext, field: "cast" | "director", name: string): Promise<MsxContentRoot> {
  const dataId = ids.person(field, name);
  // Ключ окна без «:» — его разбирают сообщения `extend:<ключ>:<край>`.
  const key = `p${fnv1a(dataId)}`;
  let st: ListEntry | undefined = ctx.state.lists.get(key);
  if (st === undefined) {
    try {
      const first = await ctx.api.searchBy(field, name, 1, PER_PAGE);
      const more = first.pagination.total > 1 ? (await ctx.api.searchBy(field, name, 2, PER_PAGE)).items : [];
      const items = [...new Map([...first.items, ...more].map((it) => [it.id, it])).values()];
      st = { key, items, page: 1, totalPages: 1, done: true, dataId, total: first.pagination.totalItems ?? items.length };
    } catch (e) {
      return errorScreen(ctx, e, dataId);
    }
  }
  remember(ctx, key, st);
  const root: MsxContentRoot = {
    type: "list", flag: key, cache: false, reuse: false, ...gridPreload(ctx), headline: `${T[field]}: ${name}`,
    extension: fmtCount(st.total ?? st.items.length, FOUND),
  };
  if (st.items.length === 0) {
    root.pages = [{ items: emptyItems(T.empty) }];
    return root;
  }
  root.template = gridTemplate(ctx);
  fill(ctx, root, key, st);
  return root;
}
