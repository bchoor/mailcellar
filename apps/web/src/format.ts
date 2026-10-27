// One way to write each kind of number, size and time, so a value reads the same on every page.
// Times follow the person's time zone (Settings ▸ Preferences), read when they're written.
import { getPrefs } from '@columenlabs/lumen-ui';

export const count = (n: number) => n.toLocaleString('en-US');

/**
 * Bytes in decimal units, as storage is billed and macOS shows it: 812 KB, 45.2 MB, 13.1 GB.
 * One decimal under 100 (MB and up), whole above.
 */
export function bytes(b: number): string {
  for (const [unit, name] of [[1e12, 'TB'], [1e9, 'GB'], [1e6, 'MB']] as const) {
    if (b < unit) continue;
    const v = b / unit;
    return `${v < 100 ? v.toFixed(1) : count(Math.round(v))} ${name}`;
  }
  return b ? `${count(Math.max(1, Math.round(b / 1e3)))} KB` : '0 KB';
}

const zone = () => getPrefs().timeZone;
const sameDay = (a: Date, b: Date, timeZone: string) =>
  a.toLocaleDateString('en-US', { timeZone }) === b.toLocaleDateString('en-US', { timeZone });

/** A moment: `9:14 AM PDT` today, `Oct 25, 9:14 AM PDT` another day this year, `Oct 25, 2025, 9:14 AM PST` before. */
export function moment(at: string | number | Date): string {
  const d = new Date(at);
  const timeZone = zone();
  const t = d.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const now = new Date();
  if (sameDay(d, now, timeZone)) return t;
  const thisYear = d.toLocaleDateString('en-US', { timeZone, year: 'numeric' }) === now.toLocaleDateString('en-US', { timeZone, year: 'numeric' });
  return `${d.toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' }) })}, ${t}`;
}

/** A day: `Oct 25, 2026`. */
export const day = (at: string | number | Date) =>
  new Date(at).toLocaleDateString('en-US', { timeZone: zone(), month: 'short', day: 'numeric', year: 'numeric' });

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
/** A calendar month as the index files mail (UTC): `2026-09` → `Sep 2026`. */
export const monthName = (ym: string) => MONTH.format(new Date(`${ym}-01T00:00:00Z`));
