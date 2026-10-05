import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MsxContentItem, MsxContentRoot } from "../../src/msx/types.ts";
import { encodeListKey, ids } from "../../src/router/ids.ts";
import { searchScreen } from "../../src/screens/search.ts";
import { createTestApp } from "../helpers/harness.ts";
import type { TestApp, TestAppOptions } from "../helpers/harness.ts";

// MSX подставляет в `{context:X}` только строковое поле элемента; число или true превращается в пустую строку
// (msx-platform §2.1). Тогда префетч по фокусу шлёт `pf:` и CDG-12 проваливается ложно, а свойства плеера сезона
// (Р-18) приходят пустыми. Решение Р-36: `{context:…}` — только в `selection` и `properties` шаблона.

let apps: TestApp[] = [];

afterEach(async () => {
  for (const t of apps) await t.close();
  apps = [];
});

async function make(o: Omit<TestAppOptions, "loggedIn"> = {}): Promise<TestApp> {
  const t = await createTestApp({ ...o, loggedIn: true });
  apps.push(t);
  return t;
}

/** Имена полей из всех `{context:X}` во всех строках значения (рекурсивно). */
function contextRefs(v: unknown, out = new Set<string>()): Set<string> {
  if (typeof v === "string") for (const m of v.matchAll(/\{context:([^}]+)\}/g)) out.add(m[1] as string);
  else if (Array.isArray(v)) for (const x of v) contextRefs(x, out);
  else if (typeof v === "object" && v !== null) for (const x of Object.values(v)) contextRefs(x, out);
  return out;
}

/** Каждый элемент несёт строкой каждое поле, на которое ссылается шаблон. */
function assertStringFields(root: MsxContentRoot, expected: string[]): void {
  const refs = contextRefs(root.template);
  for (const name of expected) assert.ok(refs.has(name), `template refers to {context:${name}}`);
  const items: MsxContentItem[] = root.items ?? [];
  assert.ok(items.length > 0, "items");
  for (const it of items) {
    for (const name of refs) assert.equal(typeof it[name], "string", `${String(it.id)}.${name} is a string`);
  }
}

describe("{context:…} fields are strings (msx-platform §2.1, Р-36)", () => {
  it("list grid: kid of every tile is a string for selection pf:{context:kid}", async () => {
    const t = await make();
    const root: MsxContentRoot = await t.request(ids.list(encodeListKey({ src: "catalog", type: "movie" })));
    assertStringFields(root, ["kid"]);
    assert.equal(root.items?.[0]?.kid, root.items?.[0]?.id?.slice(1));
  });

  it("search results: kid of every tile is a string", async () => {
    const t = await make();
    const s = t.ctx.state.search;
    Object.assign(s, { query: "фи", status: "ready", done: false, items: (await t.run(t.ctx.repo.search("фи", 1))).value.items });
    assertStringFields(await searchScreen(t.ctx), ["kid"]);
  });

  it("season with playerPropsIn: item — every field of template.properties is a string", async () => {
    const t = await make({ flags: { playerPropsIn: "item" } });
    const root: MsxContentRoot = await t.request(ids.season(2001, 1));
    assertStringFields(root, ["kid", "kmid", "ks", "ke", "kd", "kn", "knextAction", "kprevAction", "kcomplete"]);
  });

  it("template.action never uses {context:…}: the action of each element is its own", async () => {
    const t = await make({ flags: { playerPropsIn: "item" } });
    const roots: MsxContentRoot[] = [
      await t.request(ids.list(encodeListKey({ src: "catalog", type: "serial" }))),
      await t.request(ids.season(2001, 1)),
    ];
    for (const r of roots) assert.equal(contextRefs(r.template?.action).size, 0);
  });
});
