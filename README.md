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
| `d` | delete selected event (with confirmation) |
| `J` / `K` | next / previous event on the selected day |
| `v` | cycle month, week, and agenda views |
| `g g` | jump to today |
| `/` | command prompt (`/help` lists commands) |
| `Ctrl+J` / `Ctrl+K` | cycle panel focus |
| `Ctrl+S` | toggle sidebar |
| `Ctrl+Shift+R` | restart the connected daemon |
| `Ctrl+C` or `/quit` | quit the TUI (daemon stays alive) |

The calendar starts full-width with the optional sidebar closed. `Ctrl+S` opens
the calendar filter and selected-day details, and that preference is remembered.

Pressing `Enter` on the calendar opens a detailed day panel. Within that panel,
`j`/`k` selects an event, `h`/`l` moves between days, and `Enter` or `e` edits
that selected event. `Esc` returns to the calendar.

The event form uses `Tab`/`Shift+Tab` (or `j`/`k` in normal mode) to move between
fields, `i`/`a` to enter insert mode, `Esc` to return to normal mode, and
`Ctrl+S` or `Enter` in normal mode to save.

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

## License

[MIT](LICENSE)
