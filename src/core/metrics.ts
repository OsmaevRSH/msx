export interface Stat {
  n: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

const RING = 200;

function nearestRank(sorted: number[], q: number): number {
  // Погрешность float (0.95 × 60 = 57.000…01) не должна сдвигать ранг.
  const rank = Math.ceil(q * sorted.length - 1e-9);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

export function stat(values: number[]): Stat {
  if (values.length === 0) return { n: 0, p50: 0, p95: 0, min: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    min: sorted[0] as number,
    max: sorted[sorted.length - 1] as number,
  };
}

export class Metrics {
  private values = new Map<string, number[]>();
  private counters = new Map<string, number>();

  record(name: string, value: number): void {
    if (!Number.isFinite(value)) return;
    let ring = this.values.get(name);
    if (ring === undefined) {
      ring = [];
      this.values.set(name, ring);
    }
    ring.push(value);
    if (ring.length > RING) ring.shift();
  }

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  summary(): { values: Record<string, Stat>; counters: Record<string, number> } {
    const values: Record<string, Stat> = {};
    for (const [name, ring] of this.values) values[name] = stat(ring);
    const counters: Record<string, number> = {};
    for (const [name, n] of this.counters) counters[name] = n;
    return { values, counters };
  }
}
