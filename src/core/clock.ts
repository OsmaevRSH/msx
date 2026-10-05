export type TimerId = number;

export interface Clock {
  now(): number;
  perf(): number;
  setTimeout(fn: () => void, ms: number): TimerId;
  clearTimeout(id: TimerId): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  perf: () => performance.now(),
  // В Node таймер — объект; Number() даёт его числовой id, который принимает clearTimeout.
  setTimeout: (fn, ms) => Number(setTimeout(fn, ms)),
  clearTimeout: (id) => clearTimeout(id),
};

export function sleep(clock: Clock, ms: number): Promise<void> {
  return new Promise((resolve) => {
    clock.setTimeout(resolve, ms);
  });
}
