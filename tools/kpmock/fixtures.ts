// Синтетический детерминированный каталог kpmock (спец. §15.6: только синтетические фикстуры).
// Никакой случайности: все «разбросы» — арифметика от id.

export const FIX = {
  SERIAL_BIG: 2001, SERIAL_SMALL: 2002, MOVIE_MULTI: 2003, MOVIE_AUDIO12: 2004, MOVIE_DELETED: 2005, MOVIE_SIMPLE: 2006,
  SERIAL_LONG: 2007, GENRE_ANIM: 23,
} as const;

export interface Ref { id: number; title: string }
export interface FxAudio { id: number; index: number; codec: "aac" | "ac3"; channels: number; lang: string;
  type: { id: number; title: string; short_title: string | null }; author: { id: number; title: string; short_title: string | null } | null }
export interface FxFile { codec: "h264" | "h265"; w: number; h: number; quality: string; quality_id: number; file: string }
export interface FxSub { lang: string; shift: number; embed: boolean; forced: boolean; file: string }
export interface FxUnit { id: number; number: number; snumber: number; title: string; duration: number;
  audios: FxAudio[]; files: FxFile[]; subsInItem: FxSub[]; subsFull: FxSub[] }
export interface FxSeason { id: number; number: number; title: string; episodes: FxUnit[] }
export interface FxItem { id: number; type: string; subtype: string; title: string; year: number; genres: Ref[];
  countries: Ref[]; quality: number; plot: string; imdb_rating: number; kinopoisk_rating: number;
  rating: number; views: number; created_at: number; updated_at: number; videos?: FxUnit[];
  seasons?: FxSeason[]; deleted?: boolean;
  /** Только по id (карточка, сезоны, ссылки): нет в списках, поиске и похожих — каталог и golden-снимки не меняются. */
  unlisted?: boolean }

/**
 * `/v1/types` как у живого API (research kinopub-api §6.1, отчёт v1.11): `3d` строчными и `4k`. Тайтлы mock — с типом
 * `3D`, как в документации: фильтр `type` mock сравнивает без учёта регистра.
 */
export const TYPES: { id: string; title: string }[] = [
  { id: "movie", title: "Фильмы" }, { id: "serial", title: "Сериалы" }, { id: "tvshow", title: "ТВ шоу" },
  { id: "4k", title: "4K" }, { id: "3d", title: "3D" }, { id: "concert", title: "Концерты" },
  { id: "documovie", title: "Документальные фильмы" }, { id: "docuserial", title: "Документальные сериалы" },
];

const refs = (s: string): Ref[] => s.split(",").map((p) => {
  const [id, title] = p.split(":");
  return { id: Number(id), title };
});

// movie и docu — из статического справочника (research kinopub-api §6.4); tvshow и music — синтетические названия.
export const GENRES: Record<"movie" | "docu" | "tvshow" | "music", Ref[]> = {
  movie: refs("25:Аниме,3:Биография,2:Боевик,14:Вестерн,15:Военный,13:Детектив,24:Документальный,107:Дорама,9:Драма," +
    "18:Исторический,1:Комедия,26:Короткометражка,17:Криминал,10:Мелодрама,11:Мистика,19:Музыкальный,23:Мультфильм," +
    "105:Нуар,8:Приключения,6:Семейный,27:Спектакль,20:Спорт,101:Стендап,7:Триллер,12:Ужасы,4:Фантастика,5:Фэнтези," +
    "128:Эксклюзив,21:Эротика,116:Водевиль"),
  docu: refs("51:История,54:Путешествия,58:Мир животных,73:Природа,55:Наука,133:Эксклюзив"),
  tvshow: refs("110:Юмор,111:Реалити,112:Познавательное,113:Кулинария,114:Игры,123:Ток-шоу,124:Музыкальное шоу"),
  music: refs("30:Рок,31:Поп,32:Джаз,33:Классика,34:Электроника,35:Хип-хоп,109:Балет"),
};

export const COUNTRIES: Ref[] = refs("1:США,2:Россия,3:Франция,4:Германия,5:Великобритания,6:Япония,7:Южная Корея,8:Италия");

export const VOICE_TYPES: { id: number; title: string; short_title: string | null }[] = [
  { id: 1, title: "Дубляж", short_title: "Dub" }, { id: 2, title: "Многоголосый", short_title: "MVO" },
  { id: 3, title: "Двухголосый", short_title: "DVO" }, { id: 4, title: "Одноголосый", short_title: "AVO" },
  { id: 6, title: "Оригинал", short_title: "Orig" },
];
export const AUTHORS: { id: number; title: string; short_title: string | null }[] = [
  { id: 11, title: "Студия Альфа", short_title: null }, { id: 12, title: "Студия Бета", short_title: null },
  { id: 13, title: "Студия Гамма", short_title: null }, { id: 14, title: "Студия Дельта", short_title: null },
  { id: 15, title: "Студия Эпсилон", short_title: null },
];

const SERIES_TYPES = new Set(["serial", "docuserial", "tvshow"]);
const NAMES: Record<string, [string, string]> = {
  movie: ["Тестовый фильм", "Test Movie"], serial: ["Тестовый сериал", "Test Series"],
  documovie: ["Тестовый документальный фильм", "Test Documentary"],
  docuserial: ["Тестовый документальный сериал", "Test Docuseries"],
  tvshow: ["Тестовое шоу", "Test Show"], concert: ["Тестовый концерт", "Test Concert"], "3D": ["Тестовый 3D-фильм", "Test 3D Movie"],
};
const TYPE_QUOTA: [string, number][] = [
  ["movie", 20], ["serial", 15], ["documovie", 4], ["docuserial", 3], ["tvshow", 3], ["concert", 3], ["3D", 2],
];
const T0 = 1_788_000_000; // Unix-секунды, «самый свежий» тайтл (id 1000)

/** 50 типов на блок из 50 id, равномерно перемешанных (метод наибольшего отставания от квоты). */
function typePattern(): string[] {
  const used = new Map<string, number>();
  const out: string[] = [];
  for (let k = 0; k < 50; k++) {
    let best = TYPE_QUOTA[0][0];
    let bestScore = -Infinity;
    for (const [t, q] of TYPE_QUOTA) {
      const score = (q * (k + 1)) / 50 - (used.get(t) ?? 0);
      if (score > bestScore + 1e-9) { best = t; bestScore = score; }
    }
    out.push(best);
    used.set(best, (used.get(best) ?? 0) + 1);
  }
  return out;
}

function voice(typeId: number): FxAudio["type"] {
  const t = VOICE_TYPES.find((v) => v.id === typeId);
  if (!t) throw new Error(`unknown voice type ${typeId}`);
  return { ...t };
}

function author(id: number | null): FxAudio["author"] {
  if (id === null) return null;
  const a = AUTHORS.find((x) => x.id === id);
  if (!a) throw new Error(`unknown author ${id}`);
  return { ...a };
}

type AudioSpec = [codec: "aac" | "ac3", channels: number, lang: string, typeId: number, authorId: number | null];

function audios(mid: number, specs: AudioSpec[]): FxAudio[] {
  return specs.map(([codec, channels, lang, typeId, authorId], i) => ({
    id: mid * 100 + i + 1, index: i + 1, codec, channels, lang, type: voice(typeId), author: author(authorId),
  }));
}

function filePath(mid: number, tag: string): string {
  return `/${(mid % 9) + 1}/${(mid % 256).toString(16).padStart(2, "0")}/kp${mid}_${tag}.mp4`;
}

function h264Ladder(mid: number): FxFile[] {
  return [[854, 480, 1], [1280, 720, 2], [1920, 1080, 3]].map(([w, h, q]) => ({
    codec: "h264" as const, w, h, quality: `${h}p`, quality_id: q, file: filePath(mid, `${h}p`),
  }));
}

function subtitles(mid: number): { subsInItem: FxSub[]; subsFull: FxSub[] } {
  const sub = (lang: string, forced: boolean): FxSub => ({
    lang, shift: 0, embed: false, forced, file: `/s/${mid % 10}/${mid}.${lang}${forced ? ".forced" : ""}.srt`,
  });
  return { subsInItem: [sub("rus", false)], subsFull: [sub("rus", false), sub("eng", false), sub("eng", true), sub("ukr", false), sub("fre", false)] };
}

interface UnitSpec { number: number; snumber: number; title: string; duration: number; audios?: AudioSpec[]; files?: FxFile[] }

function makeUnit(itemId: number, ordinal: number, spec: UnitSpec): FxUnit {
  const mid = itemId * 1000 + ordinal;
  const defAudios: AudioSpec[] = itemId % 2 === 0
    ? [["aac", 2, "rus", 2, AUTHORS[itemId % AUTHORS.length].id], ["aac", 2, "eng", 6, null]]
    : [["aac", 2, "rus", 1, null]];
  return {
    id: mid, number: spec.number, snumber: spec.snumber, title: spec.title, duration: spec.duration,
    audios: audios(mid, spec.audios ?? defAudios), files: spec.files ?? h264Ladder(mid), ...subtitles(mid),
  };
}

function makeSeasons(itemId: number, seasons: number, episodes: number, duration: (mid: number) => number,
  audioSpecs?: AudioSpec[]): FxSeason[] {
  const out: FxSeason[] = [];
  let ordinal = 0;
  for (let s = 1; s <= seasons; s++) {
    const eps: FxUnit[] = [];
    for (let e = 1; e <= episodes; e++) {
      ordinal++;
      eps.push(makeUnit(itemId, ordinal, {
        number: e, snumber: s, title: `Серия ${e}`, duration: duration(itemId * 1000 + ordinal), audios: audioSpecs,
      }));
    }
    out.push({ id: itemId * 100 + s, number: s, title: `Сезон ${s}`, episodes: eps });
  }
  return out;
}

function genresFor(id: number, type: string): Ref[] {
  const pool = type === "documovie" || type === "docuserial" ? GENRES.docu
    : type === "tvshow" ? GENRES.tvshow
      : type === "concert" ? GENRES.music
        : GENRES.movie.filter((g) => g.id !== FIX.GENRE_ANIM && g.id !== 21);
  const out = [pool[id % pool.length]];
  const second = pool[(id * 7) % pool.length];
  if (id % 2 === 0 && second.id !== out[0].id) out.push(second);
  if (id % 3 === 0) out.push(GENRES.movie.find((g) => g.id === FIX.GENRE_ANIM) as Ref);
  return out.map((g) => ({ ...g }));
}

function baseItem(id: number, type: string, title: string): FxItem {
  const created = T0 - (id - 1000) * 43_200;
  const countries = [COUNTRIES[id % COUNTRIES.length]];
  if (id % 4 === 0) countries.push(COUNTRIES[(id + 3) % COUNTRIES.length]);
  return {
    id, type, subtype: "", title, year: 1990 + ((id * 13) % 37), genres: genresFor(id, type),
    countries: countries.map((c) => ({ ...c })), quality: 1080,
    plot: `Синтетическое описание тайтла ${id}. Данные mock для тестов.`,
    imdb_rating: (50 + ((id * 7) % 49)) / 10, kinopoisk_rating: (50 + ((id * 11) % 49)) / 10,
    rating: (id * 3) % 60, views: (id * 7919) % 50_000, created_at: created, updated_at: created + (id % 4) * 3600,
  };
}

function regularItem(id: number, type: string): FxItem {
  const [ru, en] = NAMES[type];
  const it = baseItem(id, type, `${ru} ${id} / ${en} ${id}`);
  if (SERIES_TYPES.has(type)) {
    it.seasons = makeSeasons(id, 1 + (id % 3), 6 + (id % 5), (mid) => 1800 + ((mid * 13) % 1200));
  } else {
    it.videos = [makeUnit(id, 1, { number: 1, snumber: 0, title: "", duration: 4800 + ((id * 37) % 3000) })];
  }
  return it;
}

const AUDIO12: AudioSpec[] = [
  ["aac", 2, "rus", 1, 11], ["aac", 6, "rus", 1, 11], ["ac3", 6, "rus", 1, 11],
  ["aac", 2, "rus", 2, 12], ["aac", 6, "rus", 2, 12], ["ac3", 6, "rus", 2, 12],
  ["aac", 2, "rus", 3, 13], ["aac", 2, "rus", 4, 14], ["aac", 2, "ukr", 2, 15],
  ["aac", 2, "eng", 6, null], ["aac", 6, "eng", 6, null], ["ac3", 6, "eng", 6, null],
];

function specialItems(): FxItem[] {
  const big = baseItem(FIX.SERIAL_BIG, "serial", "Тестовый сериал «Большой» / Test Series Big");
  big.seasons = makeSeasons(FIX.SERIAL_BIG, 10, 20, (mid) => 2400 + (mid % 20) * 10,
    [["aac", 2, "rus", 2, 12], ["aac", 2, "eng", 6, null]]);

  const small = baseItem(FIX.SERIAL_SMALL, "serial", "Тестовый сериал «Короткий» / Test Series Short");
  small.seasons = makeSeasons(FIX.SERIAL_SMALL, 2, 3, () => 60);

  const multi = baseItem(FIX.MOVIE_MULTI, "movie", "Тестовый фильм «Из частей» / Test Movie Multipart");
  multi.subtype = "multi";
  multi.videos = [1, 2, 3].map((n) => makeUnit(FIX.MOVIE_MULTI, n, { number: n, snumber: 0, title: `Часть ${n}`, duration: 3000 }));

  const a12 = baseItem(FIX.MOVIE_AUDIO12, "movie", "Тестовый фильм «12 озвучек» / Test Movie Twelve Audios");
  const mid12 = FIX.MOVIE_AUDIO12 * 1000 + 1;
  a12.quality = 2160;
  a12.videos = [makeUnit(FIX.MOVIE_AUDIO12, 1, {
    number: 1, snumber: 0, title: "", duration: 6000, audios: AUDIO12,
    files: [
      ...h264Ladder(mid12),
      { codec: "h265", w: 3840, h: 2160, quality: "2160p", quality_id: 4, file: filePath(mid12, "2160p") },
      { codec: "h264", w: 1920, h: 800, quality: "1080p", quality_id: 3, file: filePath(mid12, "1080p_wide") },
    ],
  })];

  const deleted = baseItem(FIX.MOVIE_DELETED, "movie", "Тестовый фильм «Удалённый» / Test Movie Deleted");
  deleted.deleted = true;
  deleted.videos = [makeUnit(FIX.MOVIE_DELETED, 1, { number: 1, snumber: 0, title: "", duration: 5000 })];

  const simple = baseItem(FIX.MOVIE_SIMPLE, "movie", "Тестовый фильм «Простой» / Test Movie Simple");
  simple.videos = [makeUnit(FIX.MOVIE_SIMPLE, 1, { number: 1, snumber: 0, title: "", duration: 5400 })];

  // Длинные сезоны (CNFR-16): 100 и 200 серий — ответ сезона делится на части (спец. §11 S9).
  const long = baseItem(FIX.SERIAL_LONG, "serial", "Тестовый сериал «Длинный» / Test Series Long");
  long.unlisted = true;
  long.seasons = makeSeasons(FIX.SERIAL_LONG, 2, 200, (mid) => 1320 + (mid % 7) * 30);
  long.seasons[0].episodes = long.seasons[0].episodes.slice(0, 100);

  return [big, small, multi, a12, deleted, simple, long];
}

/** Строит каталог заново (без кэша) — для проверки детерминизма. */
export function buildCatalog(): FxItem[] {
  const pattern = typePattern();
  const out: FxItem[] = [];
  for (let id = 1000; id < 1500; id++) out.push(regularItem(id, pattern[(id - 1000) % 50]));
  return [...out, ...specialItems()];
}

let cached: FxItem[] | undefined;
let byId: Map<number, FxItem> | undefined;
let byMid: Map<number, { item: FxItem; unit: FxUnit; season: number }> | undefined;

/** Кэшируется после первого вызова; вызывающие не должны менять объекты. */
export function catalog(): FxItem[] {
  if (!cached) {
    cached = buildCatalog();
    byId = new Map(cached.map((it) => [it.id, it]));
    byMid = new Map();
    for (const item of cached) {
      for (const unit of item.videos ?? []) byMid.set(unit.id, { item, unit, season: 0 });
      for (const s of item.seasons ?? []) for (const unit of s.episodes) byMid.set(unit.id, { item, unit, season: s.number });
    }
  }
  return cached;
}

export function findItem(id: number): FxItem | undefined {
  catalog();
  return byId?.get(id);
}

export function findUnit(mid: number): { item: FxItem; unit: FxUnit; season: number } | undefined {
  catalog();
  return byMid?.get(mid);
}

// --- Подборки и каналы эфира (v1.11, research kinopub-api §6.1, §7.4) ---

export interface FxCollection { id: number; title: string; watchers: number; views: number; created: number; updated: number; items: number[] }
export interface FxChannel { id: number; title: string; name: string }

const THEMES = ["Семейные", "Про космос", "Детективы", "Комедии", "Исторические", "Про спорт", "Новогодние", "Экранизации",
  "Про любовь", "Фантастика"];

/** 60 подборок — больше порции 48; у каждой 5–64 видимых тайтла (часть больше порции), состав — арифметика от id. */
export function buildCollections(): FxCollection[] {
  const visible = catalog().filter((it) => !it.deleted && !it.unlisted).map((it) => it.id);
  return Array.from({ length: 60 }, (_, i) => {
    const id = i + 1;
    const n = 5 + ((id * 7) % 60);
    const start = (id * 37) % visible.length;
    const items = [...new Set(Array.from({ length: n }, (_, k) => visible[(start + k * 3) % visible.length]))];
    return {
      id, title: `Тестовая подборка «${THEMES[i % THEMES.length]}» ${Math.floor(i / THEMES.length) + 1}`,
      watchers: (id * 131) % 1000, views: (id * 7919) % 20_000, created: T0 - id * 86_400, updated: T0 - ((id * 17) % 60) * 3600, items,
    };
  });
}

let collections: FxCollection[] | undefined;

export function allCollections(): FxCollection[] {
  collections ??= buildCollections();
  return collections;
}

/** Каналы `/v1/tv`: синтетические спортивные трансляции. */
export const CHANNELS: readonly FxChannel[] = [1, 2, 3, 4, 5, 6].map((n) => ({ id: n, title: `Тестовый спорт ${n}`, name: `sport${n}` }));
