import { appendFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

// Отчёт для GitHub Actions (спец. §15.5). Лог шага без входа в GitHub не открыть, а аннотации `::error` видны всем: на
// странице прогона и в API `check-runs/{id}/annotations`. Отсюда же — короткая сводка в $GITHUB_STEP_SUMMARY. Вне
// Actions (`GITHUB_ACTIONS` не `true`) ничего не пишется.

const GH = process.env.GITHUB_ACTIONS === "true";
/** Больше 10 аннотаций-ошибок на шаг GitHub не показывает. */
const MAX_ANNOTATIONS = 10;
const MAX_SUMMARY = 30;

const escData = (s: string): string => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s: string): string => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** Строка `::error` для лога шага; `file` — от корня репозитория. */
export function ghError(title: string, message: string, file?: string, line?: number): string {
  const props = [file !== undefined ? `file=${escProp(file)}` : "", line !== undefined ? `line=${line}` : "", `title=${escProp(title)}`];
  return `::error ${props.filter((p) => p !== "").join(",")}::${escData(message.slice(0, 2000))}`;
}

/** Аннотации и сводка проверки `step` (`checked` — что проверено, например «1737 tests»); пусто вне Actions. */
export function ghReport(step: string, checked: string, failures: { title: string; message: string; file?: string; line?: number }[]): string[] {
  if (!GH) return [];
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== "") {
    const head = failures.length === 0 ? `### ${step}: ✔ ${checked}` : `### ${step}: ✖ ${failures.length} failed (${checked})`;
    const rows = failures.slice(0, MAX_SUMMARY).map((f) => {
      const where = f.file !== undefined ? `\`${f.file}${f.line !== undefined ? `:${f.line}` : ""}\` ` : "";
      return `- ${where}${f.title} — ${(f.message.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, 300)}`;
    });
    if (failures.length > MAX_SUMMARY) rows.push(`- … and ${failures.length - MAX_SUMMARY} more`);
    appendFileSync(summary, [head, ...rows, ""].join("\n") + "\n");
  }
  return failures.slice(0, MAX_ANNOTATIONS).map((f) => ghError(f.title, f.message, f.file, f.line));
}

interface TestEventData {
  name: string; nesting: number; file?: string; line?: number;
  details?: { type?: string; error?: { message?: string; cause?: unknown } };
}

function errorText(e: TestEventData["details"]): string {
  const err = e?.error;
  const cause = err?.cause;
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  if (cause !== undefined && cause !== null) return String(cause);
  return err?.message ?? "failed";
}

function repoPath(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  return relative(process.cwd(), file.startsWith("file:") ? fileURLToPath(file) : file);
}

/**
 * Репортёр `node --test` (`--test-reporter=./tools/gh-report.ts`) рядом со `spec`: упавшие тесты — аннотациями с путём
 * «набор › тест», файлом и строкой, и сводкой шага.
 */
export default async function* report(source: AsyncIterable<{ type: string; data: TestEventData }>): AsyncGenerator<string> {
  const stacks = new Map<string, string[]>();
  const failures: { title: string; message: string; file?: string; line?: number }[] = [];
  let total = 0;
  for await (const { type, data } of source) {
    if (type !== "test:start" && type !== "test:pass" && type !== "test:fail") continue;
    const stack = stacks.get(data.file ?? "") ?? [];
    stacks.set(data.file ?? "", stack);
    if (type === "test:start") {
      stack.length = data.nesting;
      stack.push(data.name);
      continue;
    }
    if (data.details?.type === "suite") continue;
    total += 1;
    if (type === "test:fail") {
      const title = [...stack.slice(0, data.nesting), data.name].join(" › ");
      const f = repoPath(data.file);
      failures.push({ title, message: errorText(data.details), ...(f !== undefined ? { file: f } : {}), ...(data.line !== undefined ? { line: data.line } : {}) });
    }
  }
  for (const line of ghReport("npm test", `${total} tests`, failures)) yield `${line}\n`;
}
