type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
}

/** Число или числовая строка → число; всё остальное → undefined. */
export function numberFrom(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string" || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function firstNumber(sources: (Obj | undefined)[], field: string, ok: (n: number) => boolean): number | undefined {
  for (const src of sources) {
    const n = numberFrom(src?.[field]);
    if (n !== undefined && ok(n)) return n;
  }
  return undefined;
}

/**
 * Позиция из снимка `interaction:commit:video` (`{video:{info,data}}`) или из `handleEvent` (`{data:{position}}`).
 * Формат приложенных данных у MSX разный, поэтому ищем по очереди (Plan B §9.2).
 */
export function positionFrom(payload: unknown): { position?: number; duration?: number } {
  const root = obj(payload);
  const sources = [obj(obj(root?.video)?.data), obj(root?.data), root];
  const position = firstNumber(sources, "position", (n) => n >= 0);
  const duration = firstNumber(sources, "duration", (n) => n > 0);
  const out: { position?: number; duration?: number } = {};
  if (position !== undefined) out.position = position;
  if (duration !== undefined) out.duration = duration;
  return out;
}

/** Свойства ответа resolve (с маркерами `kp:*`), которые MSX возвращает вместе с событием плеера (спец. §10.1). */
export function propsFrom(payload: unknown): Record<string, unknown> | undefined {
  const root = obj(payload);
  const candidates = [
    obj(obj(root?.video)?.info)?.properties,
    obj(root?.info)?.properties,
    obj(obj(root?.data)?.info)?.properties,
  ];
  for (const c of candidates) {
    const props = obj(c);
    if (props) return props;
  }
  return undefined;
}
