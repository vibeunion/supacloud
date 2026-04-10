// Deno datetime/mod.ts shim
// Basic date time constants commonly used

export const SECOND = 1e3;
export const MINUTE = SECOND * 60;
export const HOUR = MINUTE * 60;
export const DAY = HOUR * 24;
export const WEEK = DAY * 7;

export function parse(dateString: string, formatString: string): Date {
  return new Date(dateString); // simplified fallback for basic use cases
}

export function format(date: Date, formatString: string): string {
  return date.toISOString(); // simplified fallback
}

export function dayOfYear(date: Date): number {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  const oneDay = 1000 * 60 * 60 * 24;
  return Math.floor(diff / oneDay);
}
