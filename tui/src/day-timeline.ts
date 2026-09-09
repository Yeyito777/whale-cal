import { deadlineIsOverdue, eventIsCompleted } from "@whale-cal/shared/dates";
import type { EventOccurrence } from "@whale-cal/shared/types";
import { daySchedule, durationLabel, scheduleNow, type ScheduleRow } from "./day-schedule";
import type { AppState } from "./state";
import { eventColor, theme } from "./theme";
import { pad, truncate, width as textWidth } from "./text";

export interface TimelineCard {
  kind: "event" | "free";
  eventIndex: number; start: number; end: number; lane: number; lanes: number; group: number; top: number; bottom: number;
}
export interface TimelineSpan { start: number; end: number; top: number; height: number; busy: boolean }
const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/** Reuse lanes only after a reservation ends. Connected overlap groups share a
 * lane layout, but standalone reservations expand back to the full width. */
export function timelineLayout(rows: readonly ScheduleRow[]) {
  const timed = rows.filter((row): row is Extract<ScheduleRow, { kind: "event" }> => row.kind === "event" && row.end > row.start);
  // A completed card remains history. Pair it with the maximal available span,
  // rather than chopping that span at the completed card's old boundaries.
  const free: Array<{ start: number; end: number }> = [];
  for (const row of rows) if (row.kind === "free") {
    const last = free.at(-1);
    if (last && last.end === row.start) last.end = row.end;
    else free.push({ start: row.start, end: row.end });
  }
  const available = free.filter(gap => timed.some(item => item.completed && item.start < gap.end && item.end > gap.start));
  const blocks = [...timed.map(item => ({ kind: "event" as const, eventIndex: item.eventIndex, start: item.start, end: item.end })),
    ...available.map((gap, index) => ({ kind: "free" as const, eventIndex: -1 - index, ...gap }))]
    .sort((a, b) => a.start - b.start || (a.kind === b.kind ? 0 : a.kind === "free" ? -1 : 1) || b.end - a.end);
  const markers = rows.filter(row => row.kind === "event" && row.end <= row.start);
  const cards: TimelineCard[] = [];
  let group = -1, groupEnd = -1, laneEnds: number[] = [], members: TimelineCard[] = [];
  const finish = () => { for (const card of members) card.lanes = laneEnds.length; };
  for (const item of blocks) {
    if (item.start >= groupEnd) { finish(); group++; groupEnd = -1; laneEnds = []; members = []; }
    let lane = laneEnds.findIndex(end => end <= item.start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = item.end; groupEnd = Math.max(groupEnd, item.end);
    const card = { kind: item.kind, eventIndex: item.eventIndex, start: item.start, end: item.end, lane, lanes: 1, group, top: 0, bottom: 0 };
    cards.push(card); members.push(card);
  }
  finish();
  const ticks = Array.from({ length: 23 }, (_, i) => (i + 1) * 60).filter(minute => timed.some(card => card.start < minute && minute < card.end));
  const boundaries = [...new Set([0, 1440, ...ticks, ...cards.flatMap(card => [card.start, card.end])])].sort((a, b) => a - b);
  const spans: TimelineSpan[] = [];
  const positions = new Map<number, number>();
  let top = markers.length ? markers.length + 2 : 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!, end = boundaries[i + 1]!;
    const busy = cards.some(card => card.start < end && card.end > start);
    // Exact boundaries stay aligned. Expand short busy spans enough to read a
    // card, and compress long empty stretches rather than wasting the screen.
    const height = timed.some(item => item.start < end && item.end > start) ? Math.max(3, Math.ceil((end - start) / 30) * 2) : 3;
    positions.set(start, top); spans.push({ start, end, top, height, busy }); top += height;
  }
  positions.set(1440, top);
  for (const card of cards) { card.top = positions.get(card.start)!; card.bottom = positions.get(card.end)! - 1; }
  return { cards, markers, spans, height: top + 1 };
}

export function moveTimelineSelection(rows: readonly ScheduleRow[], selected: number, amount: number): number {
  const layout = timelineLayout(rows);
  const indices = [...layout.markers.flatMap(row => row.kind === "event" ? [row.eventIndex] : []), ...layout.cards.filter(card => card.kind === "event").map(card => card.eventIndex)];
  if (!indices.length) return selected;
  const position = Math.max(0, indices.indexOf(selected));
  return indices[((position + amount) % indices.length + indices.length) % indices.length]!;
}

export function renderDayTimeline(state: AppState, occurrences: readonly EventOccurrence[], width: number, height: number, now = new Date()) {
  const schedule = daySchedule(occurrences, state.selectedDate);
  const layout = timelineLayout(schedule.rows);
  const current = scheduleNow(schedule.rows, state.selectedDate, now);
  const axis = 7, contentWidth = Math.max(1, width - axis);
  const selected = layout.cards.find(card => card.kind === "event" && card.eventIndex === state.selectedEventIndex);
  const groupSelection = selected?.group;
  const maxLanes = Math.max(1, Math.floor((contentWidth + 1) / 18));
  const windowFor = (card: TimelineCard) => {
    const count = Math.min(card.lanes, maxLanes);
    const first = card.group === groupSelection ? Math.max(0, Math.min(selected!.lane - count + 1, card.lanes - count)) : 0;
    return { first, count };
  };
  const laneNote = selected && selected.lanes > maxLanes
    ? (() => { const w = windowFor(selected); return ` · lanes ${w.first + 1}–${w.first + w.count}/${selected.lanes}`; })()
    : layout.cards.some(card => card.lanes > maxLanes) ? " · more lanes" : "";
  const lines: string[] = [];
  const hits: Array<{ index: number; left: number; right: number; row: number }> = [];
  const styled = (text: string, size: number, color = theme.text, bg = theme.appBg) => `${bg}${color}${pad(truncate(text, size), size)}${theme.reset}`;
  const color = (eventIndex: number) => eventColor(state.database.calendars.find(c => c.id === occurrences[eventIndex]!.event.calendarId)?.color ?? "#1d9bf0");
  let nowRow = -1;
  if (current) {
    const minute = now.getHours() * 60 + now.getMinutes();
    const span = layout.spans.find(span => span.start <= minute && minute < span.end)!;
    nowRow = span.top + Math.min(span.height - 1, Math.floor((minute - span.start) / (span.end - span.start) * span.height));
  }
  const screenRow = (row: number) => row + (nowRow >= 0 && row >= nowRow ? 1 : 0);
  const markerIndex = layout.markers.findIndex(row => row.kind === "event" && row.eventIndex === state.selectedEventIndex);
  const anchor = selected ? screenRow(selected.top) : markerIndex >= 0 ? markerIndex + 1 : nowRow >= 0 ? nowRow : 0;
  const maxScroll = Math.max(0, layout.height + (nowRow >= 0 ? 1 : 0) - height);
  const scroll = Math.max(0, Math.min(state.dayTimelineScroll ?? anchor - Math.min(3, Math.max(0, height - 3)), maxScroll));
  const contentTop = scroll === nowRow ? scroll + 1 : scroll;
  for (let row = 0; row < layout.height; row++) {
    if (row === nowRow) lines.push(styled(`${current!.time}▶${"─".repeat(Math.max(0, width - 6))}`, width, theme.accent));
    if (layout.markers.length && row === 0) { lines.push(styled(" Due & notes", width, theme.muted)); continue; }
    if (row >= 1 && row <= layout.markers.length) {
      const marker = layout.markers[row - 1]!;
      if (marker.kind !== "event") continue;
      const occurrence = occurrences[marker.eventIndex]!;
      const done = eventIsCompleted(occurrence.event, occurrence.startDate);
      const active = marker.eventIndex === state.selectedEventIndex;
      const due = occurrence.event.kind === "deadline";
      const text = `${active ? "▸" : " "} ${marker.time} ${done ? "✓" : due ? "◆" : "●"} ${occurrence.event.title}`;
      lines.push(styled(text, width, (done ? theme.muted + theme.strike : deadlineIsOverdue(occurrence.event, occurrence.startDate) ? theme.warning : color(marker.eventIndex)), active ? theme.sidebarSelBg : theme.appBg));
      hits.push({ index: marker.eventIndex, left: 1, right: width, row: screenRow(row) }); continue;
    }
    const span = layout.spans.find(span => span.top <= row && row < span.top + span.height);
    if (!span) { lines.push(styled(row === layout.height - 1 ? "24:00" : "", width, theme.muted)); continue; }
    const label = row === span.top ? clock(span.start) : "";
    const axisText = styled(pad(label, 5) + " │", axis, theme.muted);
    if (!span.busy) {
      const free = row === span.top + 1 ? ` Free ${clock(span.start)}–${clock(span.end)} · ${durationLabel(span.end - span.start)}` : "";
      lines.push(axisText + styled(free, contentWidth, theme.success)); continue;
    }
    const activeCards = layout.cards.filter(card => card.top <= row && row <= card.bottom);
    const sample = activeCards[0]!;
    const window = windowFor(sample);
    const usable = contentWidth - window.count + 1;
    let line = axisText, column = axis + 1;
    for (let slot = 0; slot < window.count; slot++) {
      const size = Math.floor(usable / window.count) + (slot < usable % window.count ? 1 : 0);
      const card = activeCards.find(card => card.lane === slot + window.first);
      if (!card) line += styled("", size);
      else if (card.kind === "free") {
        const inner = Math.max(0, size - 2);
        if (row === card.top) {
          const title = truncate(`Free · ${durationLabel(card.end - card.start)}`, inner);
          line += styled("┌" + title + "─".repeat(Math.max(0, inner - textWidth(title))) + "┐", size, theme.success);
        } else if (row === card.bottom) line += styled("└" + "─".repeat(inner) + "┘", size, theme.success);
        else {
          // Keep a long availability card identifiable when its header is above
          // the viewport (e.g. selecting the second completed event inside it).
          const continuation = screenRow(card.top) < scroll;
          const label = continuation && screenRow(row) === contentTop ? `Free · ${durationLabel(card.end - card.start)}`
            : row === card.top + 1 || continuation && screenRow(row) === contentTop + 1 ? `${clock(card.start)}–${clock(card.end)}` : "";
          line += styled("│" + pad(truncate(label, inner), inner) + "│", size, theme.success);
        }
      }
      else {
        const occurrence = occurrences[card.eventIndex]!;
        const done = eventIsCompleted(occurrence.event, occurrence.startDate);
        const active = card.eventIndex === state.selectedEventIndex;
        const currentCard = current?.rows.some(item => item.kind === "event" && item.eventIndex === card.eventIndex);
        const border = done ? theme.muted : color(card.eventIndex);
        const bg = active ? theme.sidebarSelBg : theme.appBg;
        const inner = Math.max(0, size - 2);
        let text: string;
        if (row === card.top) {
          const prefix = `${active ? "▸ " : ""}${done ? "✓ " : ""}`;
          const clipped = truncate(occurrence.event.title, Math.max(0, inner - textWidth(prefix)));
          text = `${bg}${border}┌${prefix}${done ? theme.strike : ""}${clipped}${theme.strikeOff}${"─".repeat(Math.max(0, inner - textWidth(prefix + clipped)))}┐${theme.reset}`;
        } else if (row === card.bottom) text = styled("└" + "─".repeat(inner) + "┘", size, border, bg);
        else {
          const text = row === card.top + 1 ? `${clock(card.start)}–${clock(card.end)}` : row === card.top + 2 && currentCard ? "Now" : "";
          const fg = done ? theme.muted : currentCard ? theme.accent : theme.text;
          line += `${bg}${border}│${fg}${pad(truncate(text, inner), inner)}${border}│${theme.reset}`;
          hits.push({ index: card.eventIndex, left: column, right: column + size - 1, row: screenRow(row) });
          column += size + 1;
          if (slot < window.count - 1) line += styled(" ", 1);
          continue;
        }
        line += text;
        hits.push({ index: card.eventIndex, left: column, right: column + size - 1, row: screenRow(row) });
      }
      column += size + 1;
      if (slot < window.count - 1) line += styled(" ", 1);
    }
    lines.push(line);
  }
  return { rows: lines.slice(scroll, scroll + height), hits: hits.filter(hit => hit.row >= scroll && hit.row < scroll + height).map(hit => ({ ...hit, row: hit.row - scroll })), scroll, maxScroll, laneNote, total: lines.length };
}
