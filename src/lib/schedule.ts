const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_ORDER = new Map<string, number>(DAY_ABBR.map((d, i) => [d.toLowerCase(), i]));

export const DAY_NAMES = DAY_ABBR;

function scheduleDays(schedule: string | undefined): Set<number> | null {
  if (!schedule) return null;
  const s = schedule.toLowerCase().replace(/\s+/g, "");
  const range = s.match(/^([a-z]{3})-([a-z]{3})$/);
  if (range) {
    const start = DAY_ORDER.get(range[1]);
    const end = DAY_ORDER.get(range[2]);
    if (start !== undefined && end !== undefined) {
      const days = new Set<number>();
      let d = start;
      for (let i = 0; i < 7; i++) {
        days.add(d);
        if (d === end) break;
        d = (d + 1) % 7;
      }
      return days;
    }
  }
  const days = new Set<number>();
  let i = 0;
  while (i + 3 <= s.length) {
    const abbr = s.slice(i, i + 3);
    const d = DAY_ORDER.get(abbr);
    if (d === undefined) return null;
    days.add(d);
    i += 3;
  }
  return days.size > 0 ? days : null;
}

export function deliversOn(schedule: string | undefined, dayIdx: number): boolean {
  const days = scheduleDays(schedule);
  if (!days) return true;
  return days.has(dayIdx);
}

export function todayDayIndex(now: Date = new Date()): number {
  return now.getDay();
}
