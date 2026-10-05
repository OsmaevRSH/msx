// Проверка «ничего личного» для публичного репозитория (спец. §15.6, CD-15) и запрет `.clear(` в src/ (спец. §7.3, CD-05).
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOW_FILE = "tools/privacy-allow.json";
const REPORTS_PATH = /(^|\/)reports\//;

const DOC_NETS = ["192.0.2.", "198.51.100.", "203.0.113."]; // RFC 5737

function isPersonalIp(m) {
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return false;
  const ip = octets.join(".");
  // 0.0.0.0/8 — «эта сеть» (RFC 1122), чужим адресом быть не может; заодно не ловятся версии вида 0.0.79.1.
  return ip !== "127.0.0.1" && octets[0] !== 0 && !DOC_NETS.some((net) => ip.startsWith(net));
}

/** @type {{ name: import("./privacy.d.mts").PrivacyRule; re: RegExp; accept?: (m: RegExpMatchArray) => boolean; only?: (path: string) => boolean }[]} */
const LINE_RULES = [
  { name: "token", re: /(access_token|refresh_token)["']?\s*[:=]\s*["']?[A-Za-z0-9._~-]{20,}/g },
  // Не часть более длинной цепочки «число.число…»: три числа — версия, пять — тоже не адрес.
  { name: "ipv4", re: /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)/g, accept: isPersonalIp },
  // Имя — только символы логина: плейсхолдеры вида <имя> и пути внутри URL не ловятся.
  { name: "home-path", re: /(?<![\w.-])\/(?:Users|home)\/[A-Za-z0-9._-]+\//g },
  { name: "storage-clear", re: /\.clear\s*\(/g, only: (path) => path.startsWith("src/") },
];

const allowed = (allow, v) => allow.some((a) => a.file === v.path && a.match === v.match);

/**
 * @param {string} path путь относительно корня репозитория, через `/`
 * @param {string} text
 * @param {import("./privacy.d.mts").AllowEntry[]} [allow]
 * @returns {import("./privacy.d.mts").Violation[]}
 */
export function scanText(path, text, allow = []) {
  const found = [];
  if (REPORTS_PATH.test(path)) found.push({ path, line: 0, rule: "reports", match: path });
  const rules = LINE_RULES.filter((r) => !r.only || r.only(path));
  text.split(/\r?\n/).forEach((line, i) => {
    for (const rule of rules) {
      for (const m of line.matchAll(rule.re)) {
        if (!rule.accept || rule.accept(m)) found.push({ path, line: i + 1, rule: rule.name, match: m[0] });
      }
    }
  });
  return found.filter((v) => !allowed(allow, v));
}

/**
 * Двоичные файлы (есть байт 0x00), файлы больше 2 МБ и отсутствующие в рабочей копии проверяются только по пути.
 * @param {string} root
 * @param {string[]} files пути относительно root
 * @param {import("./privacy.d.mts").AllowEntry[]} [allow]
 * @returns {import("./privacy.d.mts").Violation[]}
 */
export function scanFiles(root, files, allow = []) {
  const found = [];
  for (const raw of files) {
    const file = raw.replace(/\\/g, "/");
    const abs = join(root, file);
    let text = "";
    try {
      const st = statSync(abs);
      if (st.isFile() && st.size <= MAX_BYTES) {
        const buf = readFileSync(abs);
        if (!buf.includes(0)) text = buf.toString("utf8");
      }
    } catch {
      // файл удалён из рабочей копии, но есть в индексе
    }
    found.push(...scanText(file, text, allow));
  }
  return found;
}

if (import.meta.main) {
  const files = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\0")
    .filter(Boolean);
  const allow = JSON.parse(readFileSync(join(ROOT, ALLOW_FILE), "utf8"));
  // Сам список исключений повторяет разрешённые строки дословно.
  const selfAllow = allow.map((a) => ({ file: ALLOW_FILE, match: a.match, reason: "allowlist entry" }));
  const unique = [...new Set(files)];
  const found = scanFiles(ROOT, unique, [...allow, ...selfAllow]);
  for (const v of found) console.error(`${v.path}:${v.line}  [${v.rule}]  ${v.match}`);
  if (found.length > 0) {
    console.error(`privacy: ${found.length} violation(s); fix them or add a justified entry to tools/privacy-allow.json`);
    process.exitCode = 1;
  } else {
    console.log(`privacy: ${unique.length} files, no violations (${allow.length} allowlisted)`);
  }
}
