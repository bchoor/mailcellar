// Schedules and usage: what the mailbox runs on its own, and what it has spent of the
// free tier. Shapes match Lumen's SchedulesSection, so the API returns them as is.

export interface ScheduleRun {
  at: string;
  ok: boolean;
  detail: string;
}

export interface Schedule {
  id: string;
  name: string;
  on: boolean;
  /** Minutes between runs. */
  every: number;
  /** HH:MM: the window's start, or the time of a daily run. */
  from: string;
  /** HH:MM: the window's end. */
  to: string;
  /** Days it runs, 0 = Sunday. */
  days: number[];
  tz: string;
  kind: 'window' | 'daily';
  choices: number[];
  about: { inspects: string; processes: string; enriches?: string; outputs: string; cost?: string };
  last: ScheduleRun | null;
  next: string | null;
  waiting: string | null;
}

/** The fields a person can change. Everything else is fixed by the schedule's kind. */
export type ScheduleChange = Partial<Pick<Schedule, 'on' | 'every' | 'from' | 'to' | 'days' | 'tz'>>;

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

export const DEFAULT_SCHEDULES: Schedule[] = [
  {
    id: 'gmail-sync',
    name: 'Gmail sync',
    on: true,
    every: 360,
    from: '00:00',
    to: '23:59',
    days: ALL_DAYS,
    tz: 'UTC',
    kind: 'window',
    choices: [60, 180, 360, 720, 1440],
    about: {
      inspects: 'New mail and label changes in each connected Gmail account since the last run',
      processes: 'Copies new messages and attachments, and updates labels. Mail deleted in Gmail stays in MailCellar',
      outputs: 'The archive and its search, shown on these pages',
      cost: 'Free tier',
    },
    last: null,
    next: null,
    waiting: null,
  },
  {
    id: 'compaction',
    name: 'Archive maintenance',
    on: true,
    every: 1440,
    from: '03:15',
    to: '03:15',
    days: ALL_DAYS,
    tz: 'UTC',
    kind: 'daily',
    choices: [],
    about: {
      inspects: 'The archive’s stored files',
      processes: 'Combines many small files into fewer large ones',
      outputs: 'Faster searches across years of mail',
      cost: 'Free tier',
    },
    last: null,
    next: null,
    waiting: null,
  },
];

function isTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A change a person sent, checked against the schedule it changes. Throws on anything else. */
export function checkScheduleChange(s: Schedule, change: unknown): ScheduleChange {
  if (typeof change !== 'object' || change === null) throw new Error('change must be an object');
  const c = change as Record<string, unknown>;
  const out: ScheduleChange = {};
  for (const key of Object.keys(c)) {
    const v = c[key];
    switch (key) {
      case 'on':
        if (typeof v !== 'boolean') throw new Error('on must be true or false');
        out.on = v;
        break;
      case 'every':
        if (typeof v !== 'number' || !s.choices.includes(v)) throw new Error(`every must be one of ${s.choices.join(', ') || 'none'}`);
        out.every = v;
        break;
      case 'from':
      case 'to':
        if (typeof v !== 'string' || !HHMM.test(v)) throw new Error(`${key} must be HH:MM`);
        out[key] = v;
        break;
      case 'days':
        if (!Array.isArray(v) || !v.length || !v.every((d) => ALL_DAYS.includes(d)))
          throw new Error('days must be a non-empty list of 0 to 6');
        out.days = [...new Set(v as number[])].sort();
        break;
      case 'tz':
        if (typeof v !== 'string' || !isTimeZone(v)) throw new Error('tz must be an IANA time zone');
        out.tz = v;
        break;
      default:
        throw new Error(`${key} can't be changed`);
    }
  }
  return out;
}

const DAY_MS = 86_400_000;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** tz's offset from UTC at `at`, in ms (wall clock minus UTC). */
function tzOffset(tz: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(at);
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

/** The UTC time of a wall-clock time (as ms since the epoch, read as if UTC) in tz. */
const fromWallClock = (tz: string, wall: number) => wall - tzOffset(tz, wall - tzOffset(tz, wall));

/**
 * When a schedule next runs after `after`: every `every` minutes from `from` to `to` (or once
 * at `from` for a daily one), on its days, in its time zone. Null when it is off.
 */
export function nextRun(s: Schedule, after: Date): Date | null {
  if (!s.on || !s.days.length) return null;
  const now = after.getTime();
  const today = Math.floor((now + tzOffset(s.tz, now)) / DAY_MS) * DAY_MS;
  const start = minutesOf(s.from);
  const step = s.kind === 'daily' ? 1440 : s.every;
  let end = s.kind === 'daily' ? start : minutesOf(s.to);
  if (end < start) end += 1440; // a window that runs past midnight
  for (let d = -1; d <= 7; d++) {
    const day = today + d * DAY_MS;
    if (!s.days.includes(new Date(day).getUTCDay())) continue;
    for (let m = start; m <= end; m += step) {
      const at = fromWallClock(s.tz, day + m * 60_000);
      if (at > now) return new Date(at);
    }
  }
  return null;
}

/** Usage the mailbox measures itself, per UTC day. */
export type UsageMetric = 'do_rows_written' | 'do_rows_read' | 'messages_indexed';
export interface UsageDay {
  day: string;
  metric: UsageMetric;
  value: number;
}

/** Free-tier allowances a day, from Cloudflare's pricing pages (checked 2026-10-23). */
export const FREE_DAILY: Record<Exclude<UsageMetric, 'messages_indexed'>, number> = {
  do_rows_written: 100_000,
  do_rows_read: 5_000_000,
};
