// Типы для tools/tv-address.mjs.

/** A — ввод `<login>.github.io` с замком; B — только короткая ссылка `id:igd:<alias>` (спец. §15.2). */
export type TvAddressVariant = "A" | "B";

export interface TvAddress {
  variant: TvAddressVariant;
  /** Что вводить на ТВ в Start Parameter. */
  input: string;
  /** Где MSX возьмёт start.json; проверяется в браузере. */
  startJsonUrl: string;
  /** Цель короткой ссылки is.gd — запасной путь для A и единственный для B. */
  aliasTarget: string;
  warnings: string[];
}

export function tvAddress(login: string, repo?: string): TvAddress;
export function formatTvAddress(r: TvAddress): string;
