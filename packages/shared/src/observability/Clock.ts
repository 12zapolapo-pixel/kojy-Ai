/**
 * Clock abstraction — injectable time source
 * Enables deterministic testing of all time-sensitive code.
 */
export type ClockFn = () => Date;
export const systemClock: ClockFn = () => new Date();
export function frozenClock(iso: string): ClockFn { return () => new Date(iso); }
