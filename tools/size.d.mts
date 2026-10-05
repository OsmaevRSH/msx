// Типы для tools/size.mjs.

/** Предел включительно: `bytes` — размер файла, `gzip` — после zlib уровня 9. */
export interface SizeLimit { bytes: number; gzip?: number }
export interface SizeRow { file: string; bytes: number; gzip: number; limit: SizeLimit; ok: boolean; missing?: boolean }
export interface SizeReport { ok: boolean; rows: SizeRow[] }

/** Пределы по путям относительно каталога сборки. */
export const LIMITS: Record<string, SizeLimit>;
export function checkSizes(dir: string): SizeReport;
