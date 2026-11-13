/**
 * Working hours evaluation in the business timezone, no dependencies (uses Intl).
 * Shape: { timezone: 'Asia/Kolkata', days: { mon: [{start:'09:30', end:'18:30'}], ..., sun: [] } }
 */
export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const DEFAULT_WORKING_HOURS = {
  timezone: 'Asia/Kolkata',
  days: {
    mon: [{ start: '09:30', end: '18:30' }],
    tue: [{ start: '09:30', end: '18:30' }],
    wed: [{ start: '09:30', end: '18:30' }],
    thu: [{ start: '09:30', end: '18:30' }],
    fri: [{ start: '09:30', end: '18:30' }],
    sat: [{ start: '10:00', end: '14:00' }],
    sun: [],
  },
};

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Local day key + minutes-since-midnight for a date in a timezone. */
export function localTime(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'UTC',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const day = String(get('weekday')).slice(0, 3).toLowerCase();
  const minutes = Number(get('hour')) * 60 + Number(get('minute'));
  return { day, minutes };
}

export function isWithinWorkingHours(hours, date = new Date()) {
  const wh = hours && hours.days ? hours : DEFAULT_WORKING_HOURS;
  const { day, minutes } = localTime(date, wh.timezone);
  const slots = wh.days[day] || [];
  return slots.some((s) => {
    const start = toMinutes(s.start);
    const end = toMinutes(s.end);
    if (start === null || end === null) return false;
    if (end > start) return minutes >= start && minutes < end;
    // overnight slot e.g. 22:00-02:00
    return minutes >= start || minutes < end;
  });
}
