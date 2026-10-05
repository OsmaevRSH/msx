// Типы для tools/build.mjs (импортируется из .ts: тесты, e2e).

/** Параметры сборки; каждый, кроме ENTRY и env, можно задать и переменной окружения с тем же именем. */
export interface BuildOptions {
  /** Origin сайта, по умолчанию `http://127.0.0.1:8080`; хост приводится к нижнему регистру. */
  SITE_ORIGIN?: string;
  /** Путь сайта, по умолчанию `/`; нормализуется к виду `/x/`. */
  BASE_PATH?: string;
  API_BASE?: string;
  API_FALLBACK_BASE?: string;
  /** `1`/`0`, по умолчанию `0`. */
  DEBUG_HOOKS?: string | boolean;
  /** Целое > 0, по умолчанию 60. */
  HEARTBEAT_TICKS?: string | number;
  /** Каталог результата относительно cwd, по умолчанию `dist`. */
  OUT_DIR?: string;
  /** Адрес исходников для баннера `app.js`, по умолчанию пусто. */
  SOURCE_URL?: string;
  /** Точка входа относительно корня репозитория, по умолчанию `src/main.ts` (для тестов). */
  ENTRY?: string;
  /** Источник переменных окружения, по умолчанию `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface BuildResult {
  /** Первые 10 hex SHA-256 содержимого `app/app.js`. */
  hash: string;
  /** Абсолютный путь каталога результата. */
  outDir: string;
  /** Записанные файлы относительно `outDir`. */
  files: string[];
  /** Полный адрес плагина `<SITE_ORIGIN><BASE_PATH>app/index.html`. */
  pluginUrl: string;
}

export function build(opts?: BuildOptions): Promise<BuildResult>;
export function siteOrigin(value: string): string;
export function apiBase(name: string, value: string): string;
export function basePath(value: string): string;
export function csp(apiBases: string[]): string;
