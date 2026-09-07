import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { eventIsCompleted, isDateKey, isTimeKey, occurrencesOnDate } from "@whale-cal/shared/dates";
import type { Calendar, CalendarDatabase, CalendarEvent, EventDraft, EventPatch, RecurrenceRule } from "@whale-cal/shared/types";
import { databasePath } from "@whale-cal/shared/paths";
import { log } from "./log";
import { CALENDAR_COLORS, nextCalendarColor } from "./calendar-colors";

function nowIso(): string { return new Date().toISOString(); }

function defaultDatabase(): CalendarDatabase {
  const now = nowIso();
  return {
    version: 1,
    revision: 0,
    calendars: [{ id: randomUUID(), name: "Personal", color: CALENDAR_COLORS[0], visible: true, createdAt: now, updatedAt: now }],
    events: [],
  };
}

function cleanText(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required.`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${field} must be text.`);
  const text = value.trim();
  if (required && !text) throw new Error(`${field} is required.`);
  if (text.length > max) throw new Error(`${field} is too long (maximum ${max} characters).`);
  return text || undefined;
}

function cleanRecurrence(value: RecurrenceRule | undefined): RecurrenceRule | undefined {
  if (!value) return undefined;
  if (!["daily", "weekly", "monthly", "yearly"].includes(value.frequency)) {
    throw new Error("Repeat must be daily, weekly, monthly, or yearly.");
  }
  const interval = Number(value.interval);
  if (!Number.isInteger(interval) || interval < 1 || interval > 999) throw new Error("Repeat interval must be from 1 to 999.");
  if (value.until && !isDateKey(value.until)) throw new Error("Repeat-until date is invalid.");
  if (value.count !== undefined && (!Number.isInteger(value.count) || value.count < 1 || value.count > 100_000)) {
    throw new Error("Repeat count must be from 1 to 100000.");
  }
  return {
    frequency: value.frequency,
    interval,
    ...(value.until ? { until: value.until } : {}),
    ...(value.count !== undefined ? { count: value.count } : {}),
  };
}

function looksLikeDatabase(value: unknown): value is CalendarDatabase {
  if (!value || typeof value !== "object") return false;
  const db = value as Partial<CalendarDatabase>;
  return db.version === 1 && Number.isInteger(db.revision) && Array.isArray(db.calendars) && Array.isArray(db.events);
}

export class CalendarStore {
  private db: CalendarDatabase;

  constructor(private readonly path = databasePath()) {
    this.db = this.load();
  }

  private load(): CalendarDatabase {
    if (!existsSync(this.path)) {
      const initial = defaultDatabase();
      this.write(initial);
      return initial;
    }
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!looksLikeDatabase(parsed)) throw new Error("unsupported or malformed database structure");
      if (parsed.calendars.length === 0) throw new Error("database has no calendars");
      return parsed;
    } catch (error) {
      const backup = `${this.path}.corrupt-${Date.now()}`;
      try { renameSync(this.path, backup); } catch { /* best effort */ }
      log("error", `store: moved unreadable database to ${backup}: ${error instanceof Error ? error.message : String(error)}`);
      const initial = defaultDatabase();
      this.write(initial);
      return initial;
    }
  }

  private write(db: CalendarDatabase): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(db, null, 2) + "\n", { mode: 0o600 });
    renameSync(temp, this.path);
  }

  private commit(): void {
    this.db.revision++;
    this.write(this.db);
  }

  snapshot(): CalendarDatabase {
    return structuredClone(this.db);
  }

  private calendar(id: string | undefined): Calendar {
    const calendar = id ? this.db.calendars.find(item => item.id === id) : this.db.calendars[0];
    if (!calendar) throw new Error("Calendar not found.");
    return calendar;
  }

  private normalizeDraft(draft: EventDraft): Omit<CalendarEvent, "id" | "createdAt" | "updatedAt"> {
    const kind = draft.kind === undefined ? "event" : draft.kind;
    if (kind !== "event" && kind !== "deadline") throw new Error("Type must be event or deadline.");
    const title = cleanText(draft.title, "Title", 300, true)!;
    const calendarId = this.calendar(draft.calendarId).id;
    if (!isDateKey(draft.startDate)) throw new Error("Start date must use YYYY-MM-DD.");
    const endDate = draft.endDate ?? draft.startDate;
    if (!isDateKey(endDate)) throw new Error("End date must use YYYY-MM-DD.");
    if (endDate < draft.startDate) throw new Error("End date cannot be before the start date.");
    if (draft.startTime !== undefined && !isTimeKey(draft.startTime)) throw new Error("Start time must use HH:mm.");
    if (draft.endTime !== undefined && !isTimeKey(draft.endTime)) throw new Error("End time must use HH:mm.");
    if (kind === "deadline" && (endDate !== draft.startDate || draft.endTime !== undefined)) {
      throw new Error("Deadlines have one due date and optional due time, not an end date or duration.");
    }
    if (!draft.startTime && draft.endTime) throw new Error("An end time requires a start time.");
    if (draft.startTime && draft.endTime && draft.startDate === endDate && draft.endTime <= draft.startTime) {
      throw new Error("End time must be after the start time.");
    }
    return {
      kind,
      calendarId,
      title,
      startDate: draft.startDate,
      endDate,
      ...(draft.startTime ? { startTime: draft.startTime } : {}),
      ...(draft.endTime ? { endTime: draft.endTime } : {}),
      ...(cleanText(draft.location, "Location", 500) ? { location: cleanText(draft.location, "Location", 500) } : {}),
      ...(cleanText(draft.notes, "Notes", 10_000) ? { notes: cleanText(draft.notes, "Notes", 10_000) } : {}),
      ...(cleanRecurrence(draft.recurrence) ? { recurrence: cleanRecurrence(draft.recurrence) } : {}),
    };
  }

  createEvent(draft: EventDraft): CalendarEvent {
    const now = nowIso();
    const event: CalendarEvent = { id: randomUUID(), ...this.normalizeDraft(draft), createdAt: now, updatedAt: now };
    this.db.events.push(event);
    this.commit();
    return structuredClone(event);
  }

  updateEvent(id: string, patch: EventPatch): CalendarEvent {
    const index = this.db.events.findIndex(item => item.id === id);
    if (index === -1) throw new Error("Event not found.");
    const old = this.db.events[index]!;
    const normalized = this.normalizeDraft({
      kind: patch.kind === undefined ? old.kind : patch.kind,
      calendarId: patch.calendarId ?? old.calendarId,
      title: patch.title ?? old.title,
      startDate: patch.startDate ?? old.startDate,
      endDate: patch.endDate ?? ((patch.kind ?? old.kind) === "deadline" ? patch.startDate ?? old.startDate : old.endDate),
      startTime: "startTime" in patch ? patch.startTime ?? undefined : old.startTime,
      endTime: "endTime" in patch ? patch.endTime ?? undefined : patch.kind === "deadline" ? undefined : old.endTime,
      location: "location" in patch ? patch.location ?? undefined : old.location,
      notes: "notes" in patch ? patch.notes ?? undefined : old.notes,
      recurrence: "recurrence" in patch ? patch.recurrence ?? undefined : old.recurrence,
    });
    const completion = normalized.recurrence
      ? { completedDates: old.recurrence ? old.completedDates : old.completed ? [normalized.startDate] : undefined }
      : { completed: old.recurrence ? eventIsCompleted(old, normalized.startDate) : old.completed };
    const event: CalendarEvent = { id: old.id, ...normalized, ...completion, createdAt: old.createdAt, updatedAt: nowIso() };
    this.db.events[index] = event;
    this.commit();
    return structuredClone(event);
  }

  completeEvent(id: string, completed: boolean, occurrenceDate?: string): CalendarEvent {
    const event = this.db.events.find(item => item.id === id);
    if (!event) throw new Error("Event not found.");
    if (typeof completed !== "boolean") throw new Error("Completed must be a boolean.");
    if (event.recurrence && !occurrenceDate) throw new Error("Recurring completion requires the occurrence start date.");
    if (occurrenceDate !== undefined && (!isDateKey(occurrenceDate) ||
      !occurrencesOnDate([event], occurrenceDate).some(item => item.startDate === occurrenceDate))) {
      throw new Error("No occurrence starts on that date.");
    }
    if (eventIsCompleted(event, occurrenceDate) === completed) return structuredClone(event);
    if (event.recurrence) {
      const dates = new Set(event.completedDates ?? []);
      if (completed) dates.add(occurrenceDate!); else dates.delete(occurrenceDate!);
      event.completedDates = [...dates].sort();
    } else event.completed = completed;
    event.updatedAt = nowIso();
    this.commit();
    return structuredClone(event);
  }

  deleteEvent(id: string): void {
    const index = this.db.events.findIndex(item => item.id === id);
    if (index === -1) throw new Error("Event not found.");
    this.db.events.splice(index, 1);
    this.commit();
  }

  createCalendar(nameValue: string, colorValue?: string): Calendar {
    const name = cleanText(nameValue, "Calendar name", 100, true)!;
    if (this.db.calendars.some(item => item.name.toLowerCase() === name.toLowerCase())) {
      throw new Error("A calendar with that name already exists.");
    }
    const color = colorValue?.trim() || nextCalendarColor(this.db.calendars.map(calendar => calendar.color));
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Calendar color must be #rrggbb.");
    const now = nowIso();
    const calendar: Calendar = { id: randomUUID(), name, color, visible: true, createdAt: now, updatedAt: now };
    this.db.calendars.push(calendar);
    this.commit();
    return structuredClone(calendar);
  }

  updateCalendar(id: string, patch: Partial<Pick<Calendar, "name" | "color" | "visible">>): Calendar {
    const calendar = this.calendar(id);
    if (patch.name !== undefined) calendar.name = cleanText(patch.name, "Calendar name", 100, true)!;
    if (patch.color !== undefined) {
      if (!/^#[0-9a-f]{6}$/i.test(patch.color)) throw new Error("Calendar color must be #rrggbb.");
      calendar.color = patch.color.toLowerCase();
    }
    if (patch.visible !== undefined) calendar.visible = !!patch.visible;
    calendar.updatedAt = nowIso();
    this.commit();
    return structuredClone(calendar);
  }

  deleteCalendar(id: string): void {
    const index = this.db.calendars.findIndex(item => item.id === id);
    if (index === -1) throw new Error("Calendar not found.");
    if (this.db.calendars.length === 1) throw new Error("The last calendar cannot be deleted.");
    if (this.db.events.some(event => event.calendarId === id)) throw new Error("Move or delete this calendar's events first.");
    this.db.calendars.splice(index, 1);
    this.commit();
  }

  get revision(): number { return this.db.revision; }
}
