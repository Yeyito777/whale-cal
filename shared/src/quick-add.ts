import { addDays, dateFromKey, dateKey, isDateKey, isTimeKey, startOfWeek } from "./dates";
import type { DateKey, EventDraft, RecurrenceRule } from "./types";

export interface QuickAddOptions {
  selectedDate: DateKey;
  now?: Date;
}

const WEEKDAYS = new Map([
  ["sun", 0], ["sunday", 0], ["mon", 1], ["monday", 1], ["tue", 2], ["tues", 2],
  ["tuesday", 2], ["wed", 3], ["wednesday", 3], ["thu", 4], ["thur", 4], ["thurs", 4],
  ["thursday", 4], ["fri", 5], ["friday", 5], ["sat", 6], ["saturday", 6],
]);

function resolveDate(token: string, selectedDate: DateKey, now: Date): DateKey | null {
  const lower = token.toLowerCase();
  if (isDateKey(token)) return token;
  if (lower === "today") return dateKey(now);
  if (lower === "tomorrow") return addDays(dateKey(now), 1);
  if (lower === "yesterday") return addDays(dateKey(now), -1);
  const weekday = WEEKDAYS.get(lower);
  if (weekday !== undefined) {
    const current = dateFromKey(selectedDate).getDay();
    let distance = (weekday - current + 7) % 7;
    if (distance === 0) distance = 7;
    return addDays(selectedDate, distance);
  }
  return null;
}

function parseTimeToken(token: string): { startTime?: string; endTime?: string } | null {
  if (/^(all-day|allday)$/i.test(token)) return {};
  const match = /^(\d{1,2}:\d{2})(?:[-–](\d{1,2}:\d{2}))?$/.exec(token);
  if (!match) return null;
  const normalize = (value: string) => {
    const [hour, minute] = value.split(":");
    return `${hour!.padStart(2, "0")}:${minute}`;
  };
  const startTime = normalize(match[1]!);
  const endTime = match[2] ? normalize(match[2]) : undefined;
  if (!isTimeKey(startTime) || (endTime && !isTimeKey(endTime))) return null;
  return { startTime, ...(endTime ? { endTime } : {}) };
}

function parseRepeat(tokens: string[]): { tokens: string[]; recurrence?: RecurrenceRule } {
  const copy = [...tokens];
  const index = copy.findIndex(token => token.toLowerCase().startsWith("repeat:"));
  if (index === -1) return { tokens: copy };
  const value = copy[index]!.slice("repeat:".length).toLowerCase();
  const match = /^(daily|weekly|monthly|yearly)(?:\/(\d+))?$/.exec(value);
  if (!match) return { tokens: copy };
  copy.splice(index, 1);
  return {
    tokens: copy,
    recurrence: {
      frequency: match[1] as RecurrenceRule["frequency"],
      interval: Math.max(1, Number(match[2] ?? 1)),
    },
  };
}

/** Parse `[date] [HH:mm[-HH:mm]|all-day] title [repeat:weekly]`. */
export function parseQuickAdd(input: string, options: QuickAddOptions): EventDraft {
  const now = options.now ?? new Date();
  const repeated = parseRepeat(input.trim().split(/\s+/).filter(Boolean));
  const tokens = repeated.tokens;
  let startDate = options.selectedDate;
  let cursor = 0;

  const parsedDate = tokens[0] ? resolveDate(tokens[0], options.selectedDate, now) : null;
  if (parsedDate) {
    startDate = parsedDate;
    cursor++;
  }

  let times: { startTime?: string; endTime?: string } = {};
  if (tokens[cursor]) {
    const parsedTime = parseTimeToken(tokens[cursor]!);
    if (parsedTime) {
      times = parsedTime;
      cursor++;
    }
  }

  const title = tokens.slice(cursor).join(" ").trim();
  if (!title) throw new Error("An event title is required.");
  return {
    title,
    startDate,
    endDate: startDate,
    ...times,
    ...(repeated.recurrence ? { recurrence: repeated.recurrence } : {}),
  };
}

export function quickAddExamples(selectedDate: DateKey): string[] {
  const week = startOfWeek(selectedDate);
  return [
    `${selectedDate} 09:00-10:00 Planning`,
    `${addDays(week, 4)} all-day Deadline`,
    "tomorrow 14:00 Focus block repeat:weekly",
  ];
}
