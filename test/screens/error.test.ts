import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AppContext } from "../../src/app/context.ts";
import { KpError } from "../../src/core/errors.ts";
import type { KpErrorCode } from "../../src/core/errors.ts";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { errorScreen, errorText, placeholderScreen } from "../../src/screens/error.ts";
import { TEST_P } from "../helpers/harness.ts";

// Экран и тексты ошибок нужны только ctx.P: полный стенд не поднимается.
const ctx = { P: TEST_P } as AppContext;

const RETRY = "[invalidate:content|reload:content]";
const PROBE = `content:request:interaction:probe@${TEST_P}`;
const LOGIN = `content:request:interaction:login@${TEST_P}`;

const TEXTS: [KpErrorCode, string][] = [
  ["KP-NET", "Нет связи с KinoPub. Проверьте VPN"],
  ["KP-429", "KinoPub перегружен, повторите через минуту"],
  ["KP-5XX", "KinoPub не отвечает"],
  ["KP-404", "Тайтл недоступен или удалён из каталога"],
  ["KP-AUTH", "Сессия KinoPub завершена, войдите снова"],
  ["KP-CORS", "KinoPub не разрешает запросы из приложения (CORS)"],
  ["KP-BAD", "Неожиданный ответ KinoPub"],
];

const items = (s: MsxContentRoot): MsxContentItem[] => s.pages?.[0]?.items ?? [];
const buttons = (s: MsxContentRoot): { layout?: string; label?: string; action?: string }[] =>
  items(s).filter((i) => i.type === "button").map((i) => ({ layout: i.layout, label: i.label, action: i.action }));

describe("errorText", () => {
  for (const [code, text] of TEXTS) {
    it(`${code} → «${text}»`, () => {
      assert.deepEqual(errorText(new KpError(code, "x", 500, "d")), { code, text });
    });
  }

  it("classifies non-KpError values like the transport does", () => {
    assert.equal(errorText(new TypeError("Failed to fetch")).code, "KP-NET");
    assert.equal(errorText(new Error("boom")).code, "KP-BAD");
    assert.equal(errorText("weird").code, "KP-BAD");
  });
});

describe("errorScreen (S14)", () => {
  it("KP-NET: reason with the code, «Повторить» re-requests the screen, «Диагностика» opens the probe", () => {
    const s = errorScreen(ctx, new KpError("KP-NET", "offline"), "home");
    assert.equal(s.type, "pages");
    assert.equal(s.cache, false);
    const [info] = items(s);
    assert.deepEqual(
      { type: info?.type, layout: info?.layout, headline: info?.headline, text: info?.text },
      {
        type: "space", layout: "0,0,12,4", headline: "{ico:msx-yellow:warning} Не удалось загрузить",
        text: "Нет связи с KinoPub. Проверьте VPN{br}Код: KP-NET",
      },
    );
    assert.deepEqual(buttons(s), [
      { layout: "0,5,6,1", label: "Повторить", action: RETRY },
      { layout: "6,5,6,1", label: "Диагностика", action: PROBE },
    ]);
  });

  it("KP-AUTH: «Войти» instead of «Повторить»", () => {
    const s = errorScreen(ctx, new KpError("KP-AUTH", "rejected", 401), "item:5");
    assert.match(items(s)[0]?.text ?? "", /^Сессия KinoPub завершена, войдите снова\{br\}Код: KP-AUTH$/);
    assert.deepEqual(buttons(s), [
      { layout: "0,5,6,1", label: "Войти", action: LOGIN },
      { layout: "6,5,6,1", label: "Диагностика", action: PROBE },
    ]);
  });

  it("works without retryDataId (unknown route)", () => {
    const s = errorScreen(ctx, new KpError("KP-BAD", "unknown route"));
    assert.match(items(s)[0]?.text ?? "", /Код: KP-BAD$/);
    assert.equal(buttons(s)[0]?.action, RETRY);
  });

  it("inside a panel: 8 columns wide and «Повторить» reloads the panel", () => {
    const s = errorScreen(ctx, new KpError("KP-5XX", "down", 502), "panel:audio:2001:2001004:c");
    assert.equal(items(s)[0]?.layout, "0,0,8,4");
    assert.deepEqual(buttons(s), [
      { layout: "0,5,4,1", label: "Повторить", action: "reload:panel" },
      { layout: "4,5,4,1", label: "Диагностика", action: PROBE },
    ]);
  });

  it("every page has a focusable item and every action addresses the plugin or MSX itself", () => {
    for (const [code] of TEXTS) {
      const s = errorScreen(ctx, new KpError(code, "x"), "home");
      for (const p of s.pages ?? []) assert.ok(p.items.some((i) => i.type !== "space"), code);
      for (const b of buttons(s)) assert.ok(b.action === RETRY || b.action?.endsWith(`@${TEST_P}`), String(b.action));
    }
  });
});

describe("placeholderScreen", () => {
  it("keeps the stage 16 shape", () => {
    assert.deepEqual(placeholderScreen(ctx, "Раздел"), {
      type: "pages", headline: "Раздел", pages: [{ items: [{ type: "space", layout: "0,0,12,2", text: "Раздел в разработке" }] }],
    });
  });
});
