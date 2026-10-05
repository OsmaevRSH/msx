// Собственное подмножество JSON MSX (msx-platform §2–§3); типы vendor используются только в bridge.

export interface MsxContentItem {
  id?: string;
  type?: "default" | "teaser" | "button" | "separate" | "space" | "control";
  layout?: string;
  offset?: string;
  color?: string;
  round?: boolean;
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
  headline?: string;
  extension?: string;
  background?: string;
  template?: MsxContentItem;
  items?: MsxContentItem[];
  pages?: MsxContentPage[];
  header?: MsxContentPage;
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
