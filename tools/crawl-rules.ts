import type { MsxContentItem, MsxContentRoot, MsxMenuRoot } from "../src/msx/types.ts";
import { decodeListKey, ids, isPanelId, parseDataId } from "../src/router/ids.ts";
import { WINDOW } from "../src/screens/list.ts";
import { MENU_FLAG, refreshMenu } from "../src/screens/menu.ts";

// Правила MSX-разметки и действий для каждого ответа плагина: их проверяют краулер (этап 32, спец. §14.1) и
// тест разметки `test/router/msx-markup.test.ts` (интеграция W10b). Функции чистые: на входе ответ или строка
// действия, на выходе список нарушений (пустой — всё в порядке).

export interface Issue { rule: string; detail: string }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Ответ для `video:resolve:…`, а не экран: свои правила (`url` или `error`, свойства — строки). */
export const RESOLVE_KINDS: ReadonlySet<string> = new Set(["play", "playEp", "probePlay"]);

/** Вид маршрута для отчёта и лимитов: `list:<источник>`, `panel:<тип>`, `probe:<страница>`, иначе `Route.k`. */
export function kindOf(dataId: string): string {
  const r = parseDataId(dataId);
  switch (r.k) {
    case "panel": return `panel:${r.type}`;
    case "probe": return `probe:${r.page ?? ""}`;
    case "list":
      try {
        return `list:${decodeListKey(r.key).src}`;
      } catch {
        return "list:bad";
      }
    default: return r.k;
  }
}

/** Все строки значения с путём вида `items[3].properties.trigger:back`. */
export function walkStrings(v: unknown, path: string, fn: (path: string, s: string) => void): void {
  if (typeof v === "string") fn(path, v);
  else if (Array.isArray(v)) v.forEach((x, i) => walkStrings(x, `${path}[${i}]`, fn));
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) walkStrings(x, path === "" ? k : `${path}.${k}`, fn);
}

// --- Разметка (msx-platform §2.1, §2.3, §2.4; спец. §11) ---

const focusable = (i: MsxContentItem, template: MsxContentItem | undefined): boolean =>
  (i.type ?? template?.type ?? "default") !== "space";

/** Content Root (и `options` — тоже корень): `items` только с `template`, на каждой странице есть фокус. */
export function rootIssues(root: MsxContentRoot, at: string): string[] {
  const out: string[] = [];
  const { items, pages, template } = root;
  if (items !== undefined && template === undefined) out.push(`${at}: items без template — MSX покажет «Содержимое недоступно»`);
  if (items !== undefined && pages !== undefined) out.push(`${at}: items и pages вместе`);
  if ((items?.length ?? 0) === 0 && (pages?.length ?? 0) === 0) out.push(`${at}: ни items, ни pages`);
  pages?.forEach((p, n) => {
    if (!p.items.some((i) => focusable(i, template))) out.push(`${at}: на странице ${n} нет фокусируемого элемента`);
  });
  if (root.options !== undefined) out.push(...rootIssues(root.options, `${at} options`));
  const all = [...(items ?? []), ...(pages ?? []).flatMap((p) => p.items), ...(root.header?.items ?? [])];
  all.forEach((i, n) => {
    if (i.options !== undefined) out.push(...rootIssues(i.options, `${at} item ${i.id ?? n} options`));
  });
  return out;
}

/** Меню с флагом, которым его перерисовывает `replace:menu:<флаг>:…` (спец. §6.3, v1.5). */
export function menuIssues(m: MsxMenuRoot): string[] {
  const out: string[] = [];
  if (!Array.isArray(m.menu) || m.menu.length === 0) out.push("init: пустое меню");
  if (m.flag === undefined) out.push("init: у меню нет flag — replace:menu его не найдёт");
  else if (m.flag !== MENU_FLAG) out.push(`init: flag ${m.flag} — replace:menu идёт с флагом ${MENU_FLAG}`);
  return out;
}

/** Меню перерисовывается только `replace:menu:<флаг меню>:request:interaction:init@P`; `reload:menu` — нигде. */
export function menuActionIssues(P: string, where: string, v: unknown): string[] {
  const text = typeof v === "string" ? v : JSON.stringify(v);
  const out: string[] = [];
  if (text.includes("reload:menu")) out.push(`${where}: reload:menu — меню из start parameter MSX не перезапросит`);
  const want = refreshMenu(P);
  for (const m of text.matchAll(/replace:menu:[^|\]"]*/g)) {
    if (m[0] !== want) out.push(`${where}: ${m[0]} вместо ${want}`);
  }
  return out;
}

// --- Строки ---

/** Ключевые слова MSX (msx-platform §2.1, «Inline expressions»); `{context:…}` проверяет `contextIssues`. */
const KEYWORD = /^\{(?:(?:ico|txt|col|dic|context|now|progress):[^{}]*|br|tb|pipe)\}$/;

/** Нераскрытые `{…}` — всё, что не ключевое слово MSX: MSX покажет их буквально. */
export function placeholderIssues(v: unknown): string[] {
  const out: string[] = [];
  walkStrings(v, "", (path, s) => {
    for (const m of s.matchAll(/\{[^{}]*\}/g)) if (!KEYWORD.test(m[0])) out.push(`${path}: ${m[0]}`);
  });
  return out;
}

const ADDRESS = /request:interaction:([^@|\]"]*)@([^|\]"\s]*)/g;

/** CD-16: любой `@` адрес плагина — ровно `P`, иначе MSX сочтёт его другим плагином и перезагрузит iframe. */
export function addressIssues(v: unknown, P: string): string[] {
  const out: string[] = [];
  walkStrings(v, "", (path, s) => {
    for (const m of s.matchAll(ADDRESS)) if (m[2] !== P) out.push(`${path}: ${m[1]}@${m[2]}`);
  });
  return out;
}

const CONTEXT = /\{context:([^{}]*)\}/g;
const CONTEXT_PATHS = new Set(["template.selection.action", "template.selection.headline", "template.selection.text"]);
const contextAllowed = (path: string): boolean => CONTEXT_PATHS.has(path) || path.startsWith("template.properties.");
const CONTEXT_WHERE = "outside template.selection (action, headline, text) and template.properties";

/**
 * Р-36: `{context:…}` — только в `template.selection` (`action`, `headline`, `text`) и `template.properties`; в
 * `template.action` MSX его не раскрывает. Раскрывает полем элемента, нестроковое поле — пустой строкой, поэтому
 * у каждого элемента корня поле есть и оно строка.
 */
export function contextIssues(root: unknown): string[] {
  if (!isObj(root)) return [];
  const out: string[] = [];
  const fields = new Set<string>();
  walkStrings(root, "", (path, s) => {
    const names = [...s.matchAll(CONTEXT)].map((m) => m[1] ?? "");
    if (names.length === 0) return;
    if (contextAllowed(path)) for (const n of names) fields.add(n);
    else out.push(`${path}: {context:…} ${CONTEXT_WHERE}`);
  });
  const items = Array.isArray(root.items) ? root.items : [];
  for (const name of fields) {
    items.forEach((it, i) => {
      const v = isObj(it) ? it[name] : undefined;
      if (typeof v !== "string") out.push(`items[${i}].${name}: {context:${name}} needs a string field, got ${v === null ? "null" : typeof v}`);
    });
  }
  return out;
}

/** Как MSX раскрывает `{context:<поле>}` для элемента: строковое поле или пустая строка. */
export function expandContext(s: string, item: unknown): string {
  return s.replace(CONTEXT, (_, name: string) => {
    const v = isObj(item) ? item[name] : undefined;
    return typeof v === "string" ? v : "";
  });
}

// --- Действия ---

/** `[a|b]` → `["a", "b"]`, `[]` → `[]`, одиночное действие — оно само. */
export function splitChain(a: string): string[] {
  if (!a.startsWith("[")) return [a];
  const inner = a.slice(1, -1);
  return inner === "" ? [] : inner.split("|");
}

/** Действия, которые строит плагин (`src/msx/actions.ts`, плеер, ошибки, пробник). */
const FORMS: readonly RegExp[] = [
  /^back$/, /^home$/, /^reload:(?:content|panel)$/, /^invalidate:content$/, /^info:[^|]+$/,
  /^interaction:commit:message:[^|]+$/, /^(?:shot:)?interaction:commit:video$/,
  /^player:(?:eject|ticking:restart|button:[a-z]+:execute|commit:message:[^|]+)$/,
];
/** Запрос к плагину: только с префиксом действия, голый `request:interaction:…` — это `data` пункта меню. */
const REQUEST_ACTION = /^(?:content:|panel:|video:resolve:|replace:(?:content|menu):[A-Za-z0-9_]+:)request:interaction:([^@]*)@.+$/;

/**
 * Грамматика действия MSX; адрес `@P` проверяет `addressIssues`, перерисовку меню — `menuActionIssues`. `lazy:<действие>`
 * — то же действие после анимаций (X-3: `replace:menu` после `home`).
 */
export function actionIssues(action: string): string[] {
  if (action === "") return [": empty action"];
  const chained = action.startsWith("[");
  if (chained && !action.endsWith("]")) return [`${action}: unclosed chain`];
  const out = new Set<string>();
  for (const m of splitChain(action).map((a) => a.replace(/^lazy:/, ""))) {
    if (m === "") out.add(`${action}: empty member`);
    else if (chained && /[[\]]/.test(m)) out.add(`${action}: nested chain`);
    else if (REQUEST_ACTION.test(m)) {
      if (REQUEST_ACTION.exec(m)?.[1] === "") out.add(`${action}: empty dataId`);
    } else if (!FORMS.some((f) => f.test(m))) out.add(`${action}: unknown action`);
  }
  return [...out];
}

/** Видео запускается только в варианте `:start` (Р-34). */
export function startVariant(id: string): string {
  const r = parseDataId(id);
  if (r.k === "play") return ids.playStart(r.id);
  if (r.k === "playEp") return ids.playEp(r.id, r.mid, r.s, r.e, { start: true });
  return id;
}

/** Действия ответа: `action` где угодно, действия-свойства плеера, `{context:…}` шаблона — по каждому элементу. */
export function actionsOf(answer: unknown): string[] {
  const out = new Set<string>();
  const items = (answer as { items?: unknown } | null)?.items;
  walkStrings(answer, "", (path, s) => {
    const prop = /(?:^|\.)properties\.([^.]+)$/.exec(path)?.[1];
    const isAction = path === "action" || path.endsWith(".action") || (prop !== undefined && (prop.endsWith(":action") || prop.startsWith("trigger:")));
    if (!isAction) return;
    const templated = path.startsWith("template.") && s.includes("{context:");
    if (!templated) out.add(s);
    else if (Array.isArray(items)) for (const it of items) out.add(expandContext(s, it));
  });
  return [...out];
}

// --- Ответы ---

function resolveIssues(a: Obj): string[] {
  const out: string[] = [];
  const { url, error, properties } = a;
  if (typeof url !== "string" && typeof error !== "string") out.push("resolve: neither url nor error");
  if (typeof url === "string" && !/^https?:\/\/\S+$/.test(url)) out.push(`resolve: url ${url} is not absolute`);
  if (properties !== undefined && !isObj(properties)) out.push("resolve: properties is not an object");
  if (isObj(properties)) {
    for (const [k, v] of Object.entries(properties)) if (typeof v !== "string") out.push(`resolve: property ${k} is ${typeof v}`);
  }
  return out;
}

/** Разметка по виду маршрута: меню, ответ resolve или Content Root; у списка и поиска — окно ≤ 96 плиток (Р-35). */
export function answerIssues(dataId: string, answer: unknown): Issue[] {
  if (!isObj(answer)) {
    const what = answer === null ? "null" : Array.isArray(answer) ? "array" : typeof answer;
    return [{ rule: "json", detail: `${dataId}: answer is ${what}` }];
  }
  const k = parseDataId(dataId).k;
  const out: Issue[] = [];
  const add = (rule: string, details: string[]): void => details.forEach((detail) => out.push({ rule, detail }));
  if (RESOLVE_KINDS.has(k)) add("resolve", resolveIssues(answer));
  else if (k === "init") add("markup", menuIssues(answer as unknown as MsxMenuRoot));
  else {
    add("markup", rootIssues(answer as MsxContentRoot, dataId));
    const tiles = Array.isArray(answer.items) ? answer.items.length : 0;
    if ((k === "list" || k === "search") && tiles > WINDOW) add("window", [`${dataId}: ${tiles} tiles > ${WINDOW}`]);
  }
  return out;
}

const KB = 1024;

/** CNFR-16 = Plan B NFR-11: меню 6 КБ, главная 48, карточка 20, панель 16, resolve 6, списки, серии и прочее 32. */
export function sizeLimit(dataId: string): number {
  const k = parseDataId(dataId).k;
  if (k === "init" || RESOLVE_KINDS.has(k)) return 6 * KB;
  if (isPanelId(dataId)) return 16 * KB;
  if (k === "item") return 20 * KB;
  if (k === "home") return 48 * KB;
  return 32 * KB;
}

/** Размер ответа так, как его меряет CNFR-16: JSON в UTF-8 до gzip. */
export function bytesOf(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");
}
