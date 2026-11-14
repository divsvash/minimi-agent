export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
export const fixedClock = (d: Date): Clock => ({ now: () => d });
