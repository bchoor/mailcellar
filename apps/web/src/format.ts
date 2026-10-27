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

/** The calendar day `d` falls on, `days` from today, in the person's zone. */
const daysFrom = (d: Date, timeZone: string, days: number) => sameDay(d, new Date(Date.now() + days * 86_400_000), timeZone);
const thisYear = (d: Date, timeZone: string) =>
  d.toLocaleDateString('en-US', { timeZone, year: 'numeric' }) === new Date().toLocaleDateString('en-US', { timeZone, year: 'numeric' });

/**
 * A moment: `1:31 AM PT` today, `Yesterday, 1:31 AM PT` (or `Tomorrow, …`), `Oct 26, 1:31 AM PT`
 * another day this year, `Oct 26, 2025` before (the zone's generic name: PT, never PDT or PST).
 */
export function moment(at: string | number | Date): string {
  const d = new Date(at);
  const timeZone = zone();
  if (!thisYear(d, timeZone)) return day(d);
  const t = d.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'shortGeneric' });
  if (daysFrom(d, timeZone, 0)) return t;
  if (daysFrom(d, timeZone, -1)) return `Yesterday, ${t}`;
  if (daysFrom(d, timeZone, 1)) return `Tomorrow, ${t}`;
  return `${d.toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric' })}, ${t}`;
}

/** A message's time in a list, short as a mail app's: `1:31 AM PT` today, `Yesterday`, `Oct 26`, `Oct 26, 2025`. */
export function listTime(at: string | number | Date): string {
  const d = new Date(at);
  const timeZone = zone();
  if (daysFrom(d, timeZone, 0)) return d.toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit', timeZoneName: 'shortGeneric' });
  if (daysFrom(d, timeZone, -1)) return 'Yesterday';
  return d.toLocaleDateString('en-US', { timeZone, month: 'short', day: 'numeric', ...(thisYear(d, timeZone) ? {} : { year: 'numeric' }) });
}

/** A day: `Oct 25, 2026`. */
export const day = (at: string | number | Date) =>
  new Date(at).toLocaleDateString('en-US', { timeZone: zone(), month: 'short', day: 'numeric', year: 'numeric' });

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
/** A calendar month as the index files mail (UTC): `2026-09` → `Sep 2026`. */
export const monthName = (ym: string) => MONTH.format(new Date(`${ym}-01T00:00:00Z`));
