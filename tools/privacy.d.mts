// Типы для tools/privacy.mjs.

export type PrivacyRule = "token" | "ipv4" | "home-path" | "reports" | "storage-clear";

/** `line` — с 1; 0 — нарушение относится к файлу целиком (правило `reports`). */
export interface Violation { path: string; line: number; rule: PrivacyRule; match: string }

/** Исключение из tools/privacy-allow.json: подавляет нарушение с тем же файлом и точно тем же `match`. */
export interface AllowEntry { file: string; match: string; reason: string }

export function scanText(path: string, text: string, allow?: AllowEntry[]): Violation[];
export function scanFiles(root: string, files: string[], allow?: AllowEntry[]): Violation[];
