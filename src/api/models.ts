// Доменные модели клиента: результат толерантного разбора ответов KinoPub (этап 13).

export type ItemType = "movie" | "serial" | "3D" | "concert" | "documovie" | "docuserial" | "tvshow";

export interface Posters {
  small: string;
  medium: string;
  big: string;
  wide?: string;
}

export interface ItemSummary {
  id: number;
  type: ItemType;
  subtype: string;
  title: string;
  year?: number;
  genres: { id: number; title: string }[];
  countries: string[];
  quality: number;
  posters: Posters;
  imdbRating?: number;
  kpRating?: number;
  durationAvg?: number;
  plot?: string;
}

export interface Audio {
  id: number;
  index: number;
  codec: string;
  channels: number;
  lang: string;
  typeId?: number;
  typeTitle?: string;
  authorId?: number;
  authorTitle?: string;
}

export type StreamKind = "http" | "hls" | "hls2" | "hls4";

export interface FileInfo {
  codec: string;
  w: number;
  h: number;
  quality: string;
  qualityId: number;
  file: string;
  urls: Partial<Record<StreamKind, string>>;
}

export interface Subtitle {
  lang: string;
  shift: number;
  embed: boolean;
  forced: boolean;
  url: string;
}

export interface WatchState {
  status: -1 | 0 | 1;
  time: number;
}

export interface MediaUnit {
  id: number;
  number: number;
  snumber: number;
  title: string;
  thumbnail?: string;
  duration: number;
  audios: Audio[];
  files: FileInfo[];
  subtitles: Subtitle[];
  watching: WatchState;
}

export interface Season {
  id: number;
  number: number;
  title: string;
  episodes: MediaUnit[];
}

export interface ItemDetail extends ItemSummary {
  videos: MediaUnit[];
  seasons: Season[];
  bookmarks: number[];
  voice?: string;
  finished?: boolean;
}

export interface MediaLinks {
  mid: number;
  files: FileInfo[];
  subtitles: Subtitle[];
}

export interface Pagination {
  total: number;
  current: number;
  perpage: number;
  totalItems: number;
}

export interface Page<T> {
  items: T[];
  pagination: Pagination;
}

export interface HistoryEntry {
  item: ItemSummary;
  media: { id: number; number: number; snumber: number; title: string; duration: number };
  time: number;
  lastSeen: number;
}

export interface SerialWatching {
  id: number;
  type: ItemType;
  title: string;
  posters: Posters;
  total: number;
  watched: number;
  new: number;
}

export interface WatchingUnit {
  number: number;
  season: number;
  status: -1 | 0 | 1;
  time: number;
  duration: number;
}

export interface BookmarkFolder {
  id: number;
  title: string;
  count: number;
}

export interface User {
  username: string;
  subscription: { active: boolean; endTime: number; days: number };
}

export interface DeviceSettings {
  supportSsl: 0 | 1;
  supportHevc: 0 | 1;
  supportHdr: 0 | 1;
  support4k: 0 | 1;
  mixedPlaylist: 0 | 1;
}

export interface DeviceInfo {
  id: number;
  title: string;
  hardware: string;
  software: string;
  settings: DeviceSettings;
}

export interface ServerLocation {
  id: number;
  location: string;
  name: string;
}

export interface Genre {
  id: number;
  title: string;
}

export interface DeviceCode {
  code: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export interface TokenPairRaw {
  access: string;
  refresh: string;
  expiresIn: number;
}
