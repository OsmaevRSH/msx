// Отпечаток схемы ответов API (спец. §13, Plan B DG-24, решение Р-29): «путь → тип», значения не сохраняются.

export type Schema = Record<string, string>;

/** Элементов массива на образец: типы полей у элементов одного списка обычно совпадают. */
const ARRAY_SAMPLE = 50;
const MAX_DEPTH = 16;
const MAX_PATHS = 2000;
// Ключи-числа — это id (словарь по id), то есть значения: схлопываются в один путь.
const NUMERIC_KEY = /^\d+$/;

function typeName(v: unknown): string {
  if (v === null) return "null";
  return typeof v;
}

function addType(out: Schema, path: string, type: string): void {
  const prev = out[path];
  if (prev === undefined && Object.keys(out).length >= MAX_PATHS) return;
  out[path] = prev === undefined ? type : union(prev, type);
}

function union(a: string, b: string): string {
  return [...new Set([...a.split("|"), ...b.split("|")])].sort().join("|");
}

function walk(v: unknown, path: string, out: Schema, depth: number): void {
  if (depth > MAX_DEPTH) {
    addType(out, path, "…");
    return;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) addType(out, path, "[]");
    for (const el of v.slice(0, ARRAY_SAMPLE)) walk(el, `${path}[]`, out, depth + 1);
    return;
  }
  if (typeof v === "object" && v !== null) {
    const keys = Object.keys(v);
    if (keys.length === 0) addType(out, path, "{}");
    for (const k of keys) {
      const name = NUMERIC_KEY.test(k) ? "{id}" : k;
      walk((v as Record<string, unknown>)[k], path === "" ? name : `${path}.${name}`, out, depth + 1);
    }
    return;
  }
  addType(out, path === "" ? "$" : path, typeName(v));
}

/** Путь → тип (`string`, `number`, `boolean`, `null`; пустые `[]`/`{}`); массивы — `[]` в пути, типы элементов объединяются. */
export function schemaOf(json: unknown, prefix?: string): Schema {
  const out: Schema = {};
  walk(json, prefix ?? "", out, 0);
  return out;
}

/** Объединение двух отпечатков: типы одного пути — через `|`, по алфавиту. */
export function mergeSchema(a: Schema, b: Schema): Schema {
  const out: Schema = { ...a };
  for (const [path, type] of Object.entries(b)) out[path] = out[path] === undefined ? type : union(out[path] as string, type);
  return out;
}
