// Human periods (Today, Yesterday, This week, …, 2025) in the person's time zone. A message
// shows the first that holds it; a filter on one takes its whole span, so This week holds today.

const DAY_MS = 86_400_000;

/** How far `tz` is ahead of UTC at `ms`, in ms. */
function offset(ms: number, tz: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(ms)
      .map((x) => [x.type, Number(x.value)]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

/** Midnight of a calendar day in `tz` (month and day may run over, as in Date.UTC). */
function midnight(y: number, m: number, d: number, tz: string): number {
  const guess = Date.UTC(y, m, d);
  return guess - offset(guess - offset(guess, tz), tz);
}

export interface Period {
  label: string;
  from: number;
  to: number;
}

/** The periods in order, newest and narrowest first, then every year back to `oldest`. */
export function periods(now: number, tz: string, oldest = now): Period[] {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' })
      .formatToParts(now)
      .map((x) => [x.type, Number(x.value)]),
  );
  const [y, m, d] = [p.year, p.month - 1, p.day];
  const weekday = new Date(Date.UTC(y, m, d)).getUTCDay();
  const today = midnight(y, m, d, tz);
  const week = midnight(y, m, d - weekday, tz);
  const month = midnight(y, m, 1, tz);
  const out: Period[] = [
    { label: 'Today', from: today, to: Number.MAX_SAFE_INTEGER },
    { label: 'Yesterday', from: midnight(y, m, d - 1, tz), to: today },
    { label: 'This week', from: week, to: Number.MAX_SAFE_INTEGER },
    { label: 'Last week', from: midnight(y, m, d - weekday - 7, tz), to: week },
    { label: 'This month', from: month, to: Number.MAX_SAFE_INTEGER },
    { label: 'Last month', from: midnight(y, m - 1, 1, tz), to: month },
  ];
  const first = new Date(oldest - DAY_MS).getUTCFullYear();
  for (let year = y; year >= Math.min(first, y); year--)
    out.push({ label: String(year), from: midnight(year, 0, 1, tz), to: midnight(year + 1, 0, 1, tz) });
  return out;
}

/** The period a time shows under: the first that holds it. */
export const periodOf = (list: Period[], ts: number) => list.find((x) => ts >= x.from && ts < x.to)?.label ?? '';

/** A period's span by its label (`2019` too, though older than the list), any case. */
export function periodSpan(list: Period[], label: string, tz: string): Period | null {
  const hit = list.find((x) => x.label.toLowerCase() === label.trim().toLowerCase());
  if (hit) return hit;
  const year = /^(\d{4})$/.exec(label.trim());
  return year ? { label, from: midnight(Number(year[1]), 0, 1, tz), to: midnight(Number(year[1]) + 1, 0, 1, tz) } : null;
}

/** A calendar day (`2026-10-23`) in `tz`, as a span. */
export function daySpan(iso: string, tz: string): Period | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  return { label: iso, from: midnight(y, mo, d, tz), to: midnight(y, mo, d + 1, tz) };
}

/** A time's calendar day in `tz`, as `2026-10-23`. */
export const localDay = (ts: number, tz: string) => new Date(ts).toLocaleDateString('en-CA', { timeZone: tz });
