export interface Clock {
    now(): Date;
}

/** Tests only: always returns the same instant, as a fresh `Date` so callers cannot move it. */
export function createFixedClock(date: Date): Clock {
    const time = date.getTime();
    if (!Number.isFinite(time)) throw new RangeError('fixed clock needs a valid date');
    return { now: () => new Date(time) };
}
