// Собственное подмножество JSON MSX (msx-platform §2–§3); типы vendor используются только в bridge.

export interface MsxContentItem {
  id?: string;
  type?: "default" | "teaser" | "button" | "separate" | "space" | "control";
  layout?: string;
  offset?: string;
  color?: string;
  round?: boolean;
  /** Разрыв шаблонных элементов: `context:<ID>` начинает вставку `inserts` с `position: "context:<ID>"` (0.1.156). */
  break?: string;
  /** Только в шаблоне: элементы в сетке 12×6 внутри сжатого корня (0.1.155); `compress: false` — без уменьшения шрифта. */
  decompress?: boolean;
  compress?: boolean;
  focus?: boolean;
  enable?: boolean;
  display?: boolean;
  enumerate?: boolean;
  key?: string;
  title?: string;
  titleHeader?: string;
  titleFooter?: string;
  label?: string;
  headline?: string;
  text?: string;
  icon?: string;
  image?: string;
  imageFiller?: string;
  /** Высота картинки в единицах сетки: картинка сверху, подписи `title*` под ней (обёртка MSX). */
  imageHeight?: number;
  /** Бейдж, тег, штамп и прогресс — в границах картинки, а не всей плитки (0.1.146, нужна обёртка). */
  imageBoundary?: boolean;
  iconSize?: string;
  /** Какие подписи обрезать в одну строку с «…»: `"titleHeader"` (0.1.128). */
  truncation?: string;
  alignment?: string;
  badge?: string;
  badgeColor?: string;
  tag?: string;
  tagColor?: string;
  stamp?: string;
  stampColor?: string;
  progress?: number;
  progressColor?: string;
  extensionLabel?: string;
  playerLabel?: string;
  action?: string;
  data?: unknown;
  properties?: Record<string, string>;
  live?: { type: "setup" | "playback" | string; action?: string; [k: string]: unknown };
  selection?: { action?: string; [k: string]: unknown };
  options?: MsxContentRoot;
  /** Поля для подстановок {context:…}: kid, kmid, ks, ke … */
  [context: string]: unknown;
}

export interface MsxContentPage {
  headline?: string;
  /** Сдвиг страницы; у `type: "list"` действуют только `y` и `h` — высота страницы в ленте. */
  offset?: string;
  /** Только у вставок `inserts`: где вставить (`page:N`, `context:<ID>`), область для шаблонных элементов и их правка. */
  position?: string;
  area?: string;
  template?: MsxContentItem;
  /** У вставки при шаблоне `decompress`: её `area` — в сетке 12×6 (иначе MSX не кладёт в неё шаблонные элементы). */
  decompress?: boolean;
  items: MsxContentItem[];
  [k: string]: unknown;
}

export interface MsxContentRoot {
  type?: "pages" | "list";
  flag?: string;
  cache?: boolean;
  reuse?: boolean;
  restore?: boolean;
  compress?: boolean;
  important?: boolean;
  /** Заранее строить соседнюю страницу ленты (картинки, live): `next` у сеток постеров. */
  preload?: "none" | "next" | "prev" | "full";
  headline?: string;
  extension?: string;
  background?: string;
  template?: MsxContentItem;
  items?: MsxContentItem[];
  pages?: MsxContentPage[];
  header?: MsxContentPage;
  /** Страницы-вставки между шаблонными элементами (0.1.156): здесь — края сеток без перехода по кругу (`msx/edges.ts`). */
  inserts?: MsxContentPage[];
  options?: MsxContentRoot;
  ready?: { action: string };
  [k: string]: unknown;
}

export interface MsxMenuItem {
  id?: string;
  type?: "default" | "separator" | "settings";
  icon?: string;
  label?: string;
  data?: string;
  focus?: boolean;
}

export interface MsxMenuRoot {
  headline?: string;
  extension?: string;
  dictionary?: string;
  flag?: string;
  cache?: boolean;
  reuse?: boolean;
  menu: MsxMenuItem[];
}

export interface MsxResolveResponse {
  url?: string;
  label?: string;
  properties?: Record<string, string>;
  error?: string;
}
