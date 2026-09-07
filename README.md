# Whale Cal

A local-first, daemon-driven terminal calendar built with TypeScript and Bun.
Its architecture and interaction model intentionally follow Exocortex: a persistent
daemon owns durable state, thin TUIs speak a JSON-lines protocol over a Unix socket,
the same protocol can be carried over SSH, rendering uses a retained alternate-screen
frame, and navigation is Vim-first. The default palette is Exocortex's Whale theme.

## Run from source

```sh
git clone https://github.com/Yeyito777/whale-cal.git
cd whale-cal
bun install
bun run start
```

`bun run start` starts `cald` in the background when needed, then launches the TUI.
For separate foreground processes:

```sh
bun run daemon
bun run tui
```

Set `CAL_CONFIG_DIR` to move all data/runtime files. By default they live in this
checkout's `config/` directory. Events are atomically persisted to
`config/data/calendar.json`.

## Install

On macOS or Linux, install the commands and a persistent per-user daemon:

```sh
make install
whale-cal
```

This links `whale-cal` and `cald` into `~/.local/bin`. On macOS it installs the
`com.whale-cal.daemon` LaunchAgent; on Linux it installs the
`whale-cal-daemon.service` systemd user unit. The installer records Bun's absolute
path so the daemon can start in the restricted service-manager environment.

`~/.local/bin` must be in your `PATH`. To remove the commands and managed daemon
without deleting calendar data, run:

```sh
make uninstall
```

Linux installation requires a systemd user session. macOS installation uses the
current GUI launchd domain when available and starts automatically at login.

## Essential keys

| Key | Action |
| --- | --- |
| `h j k l` | move one day / one week |
| `[` / `]` | previous / next month |
| `t` | today |
| `Enter` | open the selected day and its event details |
| `n` or `a` | new event form |
| `e` | edit selected event, or create on an empty day |
| `x` | mark the selected event done / unfinished |
| `d` | delete selected event (with confirmation) |
| `J` / `K` | next / previous event on the selected day |
| `v` | cycle month, week, and agenda views |
| `g g` | jump to today |
| `/` | command prompt (`/help` lists commands) |
| `Ctrl+J` / `Ctrl+K` | switch sidebar / main panel (not prompt / calendar) |
| `Ctrl+N` | switch calendar / prompt; from sidebar, focus calendar |
| `Ctrl+S` | toggle sidebar, including while typing in the prompt |
| `Ctrl+P` / `Ctrl+Shift+O` | new event from any non-modal surface |
| `Ctrl+Shift+R` | restart the connected daemon |
| `Ctrl+C` or `/quit` | quit the TUI (daemon stays alive) |

The calendar starts full-width with the optional sidebar closed. `Ctrl+S` opens
the calendar filters, and that preference is remembered. The toolbar provides
clickable date navigation, view switching, and event creation without shortcut
labels. The month grid uses only the weeks belonging to that month, with visible
week boundaries and overflow counts for busy days.
Today has a solid Whale-blue date header with bold white text (and a `Today`
label where space allows), separate from the selected day's dark highlight.

New calendars automatically choose an unused color from 24 bright accents,
favoring colors furthest from the existing ones. Additional colors are generated
once that palette is used up instead of repeating the same cycle. Hidden and
custom-colored calendars are included when choosing; deleting a calendar frees
its color for reuse. Existing colors and explicit `--color '#rrggbb'` choices
are preserved. Omit `--color` for automatic assignment, including via the CLI.

Pressing `Enter` on the calendar opens a detailed day panel. Within that panel,
`j`/`k` selects an event, `h`/`l` moves between days, and `Enter` or `e` edits
that selected event. `Esc` returns to the calendar. A day uses a split event list
and details layout on wide terminals, stacking them on narrower terminals.
Click an event to inspect it. Notes retain paragraphs and wrap to the available
width; scroll the details with the mouse wheel or `Ctrl+D`/`Ctrl+U`. Clicking an
already selected month cell opens that day; agenda entries are clickable too.
The day list also shows free-time gaps from 00:00 through 24:00, their durations,
and the day's total free time. Overlapping events count as one busy interval;
only visible calendars are considered. Gap rows are informational: navigation
and editing still target real events. All-day entries remain visible as date
markers (for example birthdays and deadlines), but do not block timed gaps.
Free time describes the gaps between timed reservations, not the absence of
all-day commitments. Entries without an end time also remain time markers
(shown as `HH:MM–?`), rather than inventing a duration. The day view explicitly
notes when these entries are excluded from the free-time total; add an end time
to reserve a duration. Overnight events with known end times are clipped to
the inspected day's boundaries.

Today's day view shows a live `Now HH:MM` summary and blue `Now` markers on the
current event(s) or free-time block. It uses the same local wall-clock time as
the calendar, updates automatically, and leaves your selection and scroll position
alone. Overlapping events are all marked; deadlines and durationless markers
are not treated as ongoing blocks. Other dates do not show a Now marker.

The event form uses `Tab`/`Shift+Tab` (or `j`/`k` in normal mode) to move between
fields, `i`/`a` to enter insert mode, `Esc` to return to normal mode, and
`Ctrl+S` or `Enter` in normal mode to save.
Save and Cancel are also clickable and reachable with Tab. Fields scroll with
the cursor, including Unicode text. Invalid dates and times produce an inline
error without discarding the draft. The form stays open until the daemon
acknowledges a save, then returns to the saved event's day. Moving a single-day
event's start date also moves its end date unless it was set separately.

### Prompt and statusline

Typing `/` opens a live suggestion popup. Tab/Shift+Tab or Up/Down cycles and
previews candidates; Enter executes the current text. Escape keeps the preview,
closes the popup, and enters normal mode. Type a space after a completed command
to see argument suggestions for views, calendar operations/names, SSH aliases,
dates, quick-add weekdays, and existing event titles for search. Suggestions are
also clickable. Only Cal commands are offered, not Exocortex's chat/model commands.
The popup matches Exocortex's compact, borderless list: up to ten rows directly
above the prompt separator, content-sized columns, white names, dim descriptions,
an accent selection marker, and small scroll arrows instead of a title or counter.

The single-line prompt supports insert/normal modes, character and word motions,
counts, `d`/`c`/`y` operators, word and simple delimiter text objects, `f`/`t`
find motions, `r` replacement, visual selection, yank/paste, and undo/redo.
Insert mode supports Ctrl+A/E, Ctrl+W/U deletion, and Ctrl+Y yank-back.
Up/Down browses session command history and restores unfinished input when no
popup is open. Ctrl+N switches between the calendar and prompt (returning to
insert mode); `i` or clicking the prompt also resumes the draft. Ctrl+J/K switches
only the sidebar/main panel, preserving the main panel's inner focus. With the
sidebar closed it does nothing. Ctrl+S opens and focuses the sidebar or closes
it and returns to the main panel. Leaving the prompt preserves its text, cursor,
and undo history, closes completions, and enters normal mode. These shortcuts
work in both prompt modes and in the day view. Pasting from a browsing surface
inserts into the prompt draft. Event dialogs retain their own keys, including
Ctrl+S to save; they cannot be bypassed by focus shortcuts. The yank register
and history belong to the current TUI session.

The prompt is framed by matching horizontal separators above and below it.
The frame, mode indicator, and draft are muted when the prompt is unfocused
(including behind a dialog). A focused prompt uses Whale's blue accent frame,
white text, and pale-blue highlighting for recognized commands and subcommands;
event titles and other free-form arguments remain white.
Below the bottom separator, an Exocortex-style two-line status block shows `Next Event:`
on its first row and the live `Happens in: 1h30m` countdown underneath, with muted
labels and accent-colored values. It uses the current local time and visible calendars,
not the selected date, and respects recurrence limits. All-day events start at
local midnight; already-started events are skipped. Titles shorten on narrow
terminals so the countdown stays visible. Connection status remains in the top bar.

Quick creation is available from the command prompt:

```text
/new tomorrow 09:00-10:00 Standup
/new fri 14:00 Dentist
/new 2026-09-12 all-day Birthday
```

## SSH

Install or expose `cald` on the remote host, ensure its daemon is running, then:

```text
/ssh my-host
/ssh cancel
```

`my-host` must be a concrete alias in OpenSSH config. Each TUI owns its route,
so local and remote TUI sessions can coexist. The transport executes
`ssh -T -C my-host cald proxy`, which transparently bridges stdio to the remote
daemon socket. `/ssh` with no argument reports the active route.

For a two-machine test, install Whale Cal on both machines, run the daemon on
the machine that should own the calendar, and define it as an SSH alias on the
machine running the TUI:

```sshconfig
Host my-calendar
  HostName calendar-host.example
  User my-user
```

Ensure `cald` is available in the remote noninteractive SSH `PATH`, verify with
`ssh -T my-calendar cald status`, then enter `/ssh my-calendar` in the local
TUI. Only JSONL IPC crosses SSH; calendar storage remains on the remote daemon.

## Daemon commands

```sh
bun run daemon                 # foreground daemon
bun run daemon -- status       # probe daemon
bun run daemon -- proxy        # stdio ↔ socket bridge (used by SSH)
```

## CLI, schema, and AI IPC

### Events and deadlines

Items have an explicit `event` or `deadline` type. Existing records without a
type remain events; titles and notes are never used to guess or migrate types.

- **Event:** a scheduled time block. Explicit durations count as busy time.
- **Deadline:** a due date with an optional due time, never a busy interval.
  Deadlines use a `◆` marker and `Due HH:MM` label rather than a time range.
  Date-only deadlines appear above the day timeline. Unfinished overdue deadlines
  use the warning color; date-only deadlines become overdue only after the due
  day ends in the local timezone. Completed deadlines are crossed out.

Use the editor's **Type** selector (click, Left/Right, or Space) to choose.
Deadline forms show **Due date / Due time**, with no end date or end time.
`/deadline` opens a deadline form; `/deadline tomorrow 15:05 Submit quiz` creates
one directly. Recurrence and per-occurrence completion work for either type.

```sh
cal event create --type event --title 'Study session' --date 2026-09-14 --start 14:00 --end 15:00 --json
cal event create --type deadline --title 'Submit quiz' --date 2026-09-14 --start 15:05 --json
cal event create --type deadline --title 'Form due' --date 2026-09-14 --json
cal event update EVENT_ID --type deadline --json
cal event update EVENT_ID --type event --end 16:00 --json
```

The CLI defaults to `--type event`. For deadlines, `--date` means the due date
and `--start` the optional due time; `--all-day` on update removes the due time.
Converting to a deadline keeps the item's ID, start/due date and time, notes,
calendar, recurrence and completion, but removes its previous duration. Explicit
incompatible end fields are rejected rather than silently ignored.

The JSON/IPC field is `kind: "event" | "deadline"` inside the event draft or
patch. Deadlines store their due point in `startDate`/`startTime`, require
`endDate` to equal `startDate`, and have no `endTime`. `cal schema` describes both
types. The next-item status block says **Next Due / Due in** for a deadline.

### Completed events

Press `x` on a selected event, click **Done / Reopen** in the day toolbar, or
use `/done` and `/undone`. Completed items stay visible with muted, crossed-out
titles and a checkmark. They are omitted from the **Next Event** countdown;
their scheduled time is unchanged, including in the day view's gap calculation.
Completion is saved by the daemon and synced to all connected clients.

For recurring events, only the selected occurrence is marked done, never the
whole series. The CLI uses the base event ID and requires its occurrence start
date (also for multi-day occurrences):

```sh
cal event complete EVENT_ID --json
cal event reopen EVENT_ID --json
cal event complete RECURRING_EVENT_ID --date 2026-09-14 --json
cal event reopen RECURRING_EVENT_ID --date 2026-09-14 --json
```

The IPC command is `complete_event`, with `id`, boolean `completed`, and
`occurrenceDate` for recurring events. Old calendars need no migration: events
without completion metadata remain unfinished. No events are deleted by marking
them done, and reopening preserves all event details.

The `cal` workspace is a thin daemon client suitable for scripts and AI tool
calls. It does not read or modify the JSON database directly:

```sh
bun run cli -- status --json
bun run cli -- calendars
bun run cli -- events --from 2026-08-31 --to 2026-09-30 --json
bun run cli -- event create --title "Dentist" --date 2026-09-04 --start 14:00
bun run cli -- event delete EVENT_ID --yes
```

The versioned Draft 2020-12 protocol contract lives at
[`schema/cal-ipc.schema.json`](schema/cal-ipc.schema.json) and is served by the
daemon itself, so clients can discover the contract used by the running daemon:

```sh
bun run cli -- schema
printf '%s\n' '{"type":"list_calendars","reqId":"example-1"}' \
  | bun run cli -- ipc
```

IPC is one UTF-8 JSON object per line over a user-only Unix socket. Query replies
are sent only to the requesting client; canonical mutation events are broadcast
to all connected TUIs and clients. Raw `ipc` input is forwarded without JSON
rewriting and therefore must be a single line with a non-empty `reqId` (except
for `bootstrap`).

### Exocortex external tool

Install the thin `cal` launcher into a local Exocortex source checkout with:

```sh
make install-exocortex EXOCORTEX_DIR=/path/to/Exocortex
```

When the checkouts are sibling directories named `whale-cal` and `Exocortex`,
`EXOCORTEX_DIR` may be omitted. Exocortex discovers the manifest automatically,
adds `cal` to model Bash environments, and supervises `cald`. The installer
removes Whale Cal's launchd/systemd service first so two service managers cannot
race over the same socket. The TUI and CLI continue to use this checkout's
existing calendar data.

## Development

```sh
bun run check
```

### Isolated worktrees

The development scripts create feature branches under `.worktrees/`, seed Bun's
workspace dependencies, and keep test calendar data, sockets, PIDs, and logs away
from the main calendar:

```sh
git config core.hooksPath .githooks   # once per clone
./scripts/dev/create-worktree fix-agenda-scroll
./scripts/dev/caltest fix-agenda-scroll
./scripts/dev/clean-worktree fix-agenda-scroll
```

`caltest` starts the selected worktree's supervised daemon with an isolated,
initially empty calendar under `config/worktrees/<name>/`, launches its TUI, and
stops the daemon when the TUI exits. It copies only the main checkout's UI
preferences. `clean-worktree` refuses to remove a dirty/in-use worktree or delete
an unmerged branch.

## License

[MIT](LICENSE)
