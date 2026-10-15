// Бюджет размера сборки: CNFR-15 (app.js с библиотекой TVX), спец. §15.3 (index.html < 1 КБ) и probe.js (этап 23b).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

/** @type {Record<string, import("./size.d.mts").SizeLimit>} */
export const LIMITS = {
  // 100 КБ gzip (спец. v1.15.2): пользователь выбрал 8 новых функций (≈ +8 КБ), на ТВ разница незаметна; редкие экраны
  // при необходимости уйдут в ленивый бандл, как probe.js. Gzip в CI (официальный Node с zlib Chromium) чуть больше,
  // чем у Node из Homebrew с системной zlib, поэтому нужен запас, а не впритык.
  "app/app.js": { bytes: 320_000, gzip: 102_400 },
  "app/index.html": { bytes: 1023 },
  // Пробник грузится только при открытии «Диагностики» или «Скорости серверов KinoPub». ~1,2× его размера: на этапе 23b
  // (34 КБ, 13,5 КБ gzip) — 40 960 Б и 16 384 Б gzip; v1.20 (спец. §16.7) — тест скорости CDN, +4,9 КБ gzip (48 КБ,
  // 18,8 КБ gzip). Запас — на правки по итогам Phase 0, а модули app.js, скопированные в probe.js по ошибке сборки, видны.
  "app/probe.js": { bytes: 58_368, gzip: 22_528 },
};

/**
 * @param {string} dir
 * @returns {import("./size.d.mts").SizeReport}
 */
export function checkSizes(dir) {
  const rows = Object.entries(LIMITS).map(([file, limit]) => {
    let buf;
    try {
      buf = readFileSync(join(dir, file));
    } catch {
      return { file, bytes: 0, gzip: 0, limit, ok: false, missing: true };
    }
    const gzip = gzipSync(buf, { level: 9 }).length;
    const ok = buf.length <= limit.bytes && (limit.gzip === undefined || gzip <= limit.gzip);
    return { file, bytes: buf.length, gzip, limit, ok };
  });
  return { ok: rows.every((r) => r.ok), rows };
}

function table(rows) {
  const n = (v) => (v === undefined ? "—" : v.toLocaleString("en-US"));
  const lines = [["file", "bytes", "≤ bytes", "gzip", "≤ gzip", ""]];
  for (const r of rows) {
    lines.push(r.missing
      ? [r.file, "—", n(r.limit.bytes), "—", n(r.limit.gzip), "MISSING"]
      : [r.file, n(r.bytes), n(r.limit.bytes), n(r.gzip), n(r.limit.gzip), r.ok ? "ok" : "OVER"]);
  }
  const widths = lines[0].map((_, i) => Math.max(...lines.map((l) => l[i].length)));
  return lines.map((l) => l.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ").trimEnd()).join("\n");
}

if (import.meta.main) {
  const dir = process.argv[2] ?? "dist";
  const res = checkSizes(dir);
  console.log(table(res.rows));
  if (!res.ok) {
    console.error(`size: budget exceeded in ${dir}/`);
    process.exitCode = 1;
  }
}
