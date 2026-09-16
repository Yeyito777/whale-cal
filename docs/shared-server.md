# Shared calendar server — experimental worktree

One daemon owns one SQLite database. The TUI, CLI, AI tools and Python scripts
are clients. Unix JSONL and HTTP commands use the same authorization and calendar
operations. No client edits SQLite directly.

## Current policy

- Every authenticated member reads **all** calendars, including notes and locations.
- Calendar owners alone can create/update/delete/complete their events. Moving an
  event requires ownership of both calendars. Groups are owned too.
- Server administrators provision accounts/tokens and explicitly assign ownership.
  Admin status does not bypass ordinary event/calendar write checks.
- Tokens are random 256-bit bearer credentials, stored only as SHA-256 hashes.
  Issue a separate token for each device/AI tool; revoke by ID. No passwords or
  public registration are needed for this friends-only version.
- Local personal mode trusts access to the OS-user-only socket as the `local`
  owner/admin. This is an **explicit OS-account trust boundary**, not per-person
  identity. On a shared installation, enable `CAL_SOCKET_AUTH=required` after
  issuing an admin token. Socket `probe` remains anonymous for daemon liveness;
  every data or administration command then requires authentication.
- People with shell access as the daemon's OS user can read its database and
  credentials. Application tokens cannot isolate users who share that OS account.
  Give friends HTTPS accounts, not shell access as the service user.

HTTP is disabled unless `CAL_HTTP_PORT` is set. Its listener is **loopback only**.
Use a TLS reverse proxy for remote access; do not forward the raw HTTP port.

## Test locally without port forwarding

Run these commands from the experimental worktree, **not the live checkout**.
No service installation, router change, or main-daemon restart is needed.

```sh
export CAL_CONFIG_DIR="$PWD/config"  # this worktree's isolated config/data/runtime
export CAL_TIME_ZONE=America/Toronto # choose your calendar's wall-clock timezone
CAL_HTTP_PORT=8088 bun run daemon
```

Leave that foreground daemon running. In another terminal in the same worktree:

```sh
export CAL_CONFIG_DIR="$PWD/config"
bun run cli/src/main.ts user create --name Alice
bun run cli/src/main.ts users --json
mkdir -p "$CAL_CONFIG_DIR/credentials"
chmod 700 "$CAL_CONFIG_DIR/credentials"
# Substitute the user ID returned above. The token secret is written, not printed.
bun run cli/src/main.ts token create USER_ID --label alice-laptop \
  --output "$CAL_CONFIG_DIR/credentials/alice.token"
```

Set up `config/connections.json` (ignored by Git):

```json
{
  "defaultProfile": "local",
  "profiles": {
    "local": {},
    "alice": {
      "url": "http://127.0.0.1:8088",
      "tokenFile": "credentials/alice.token"
    }
  }
}
```

Relative token-file and socket paths resolve from `CAL_CONFIG_DIR`, not the
shell's working directory. Profiles can alternatively specify `tokenEnv`.

```sh
bun run cli/src/main.ts --profile alice whoami
bun run cli/src/main.ts --profile alice calendars --json
bun run cli/src/main.ts --profile alice event create \
  --title "Shared test" --date 2026-09-20 --json
bun run start --profile alice
```

Create Bob and a second profile to test full-detail reads and forbidden writes.
The TUI supports `/connect alice`, `/connect local`, and the existing `/ssh`.
Calendar display filters stay client-side and are scoped to the connection.

Alternatively, `CAL_HTTP_PORT=8088 ./scripts/dev/caltest WORKTREE_NAME` starts
the test daemon and TUI together and stops the daemon on exit. That helper prints
its **different** config path (`<main>/config/worktrees/<name>`); use that exact
`CAL_CONFIG_DIR` for its CLI/profile commands. It never copies production events.

## CLI and AI access

The existing external-tool launcher forwards to the same CLI. Use:

```sh
cal --profile friends events --json
cal --profile friends event create --title "Dinner" --date 2026-09-20
cal --profile local events --json
```

Or use `CAL_SERVER_URL=https://calendar.example.com` with `CAL_TOKEN_FILE`.
Explicit `--profile` / `CAL_PROFILE` wins over the direct URL; otherwise the
URL wins over `defaultProfile`. With neither, the default is the local socket.
Do not put token secrets in command arguments or checked-in config.

A remote-default TUI/CLI installation does not need a local daemon. The
Exocortex supervisor wrapper also exits cleanly in remote-default mode. A broken
remote connection or invalid profile **never falls back to local writes**.
Do not reinstall the existing integration from this experimental worktree:
that would switch the live tool and its supervised service.

## Python / HTTP

```python
import os
import uuid
from pathlib import Path
import requests

session = requests.Session()
session.headers["Authorization"] = (
    "Bearer " + Path(os.environ["CAL_TOKEN_FILE"]).read_text().strip()
)
url = os.environ["CAL_SERVER_URL"].rstrip("/")
command = {
    "type": "create_event",
    "reqId": str(uuid.uuid4()),
    "event": {"title": "Dinner", "startDate": "2026-09-20"}
}
response = session.post(url + "/v1/commands", json=command,
                        timeout=10, allow_redirects=False)
response.raise_for_status()
event = response.json()
```

`POST /v1/commands` accepts the same objects as `cal ipc`. Query `get_schema`
or run `cal schema` for the complete machine-readable contract. The checked-in
`schema/cal-ipc.schema.json` is the same contract.

`GET /v1/changes`, with the same bearer header, is an SSE stream. Every connection
begins with a complete current snapshot, followed by canonical mutations. Reconnect
to refresh from a snapshot; this version does not keep an SSE replay log. Slow
subscribers are disconnected instead of accumulating an unbounded event queue.
The API rejects browser Origin headers; a browser login/CORS flow is not included.

Commands return 401 for missing/invalid tokens, 403 for denied permissions, 409
for conflicts, and 400 for invalid commands. Requests are limited to 1 MiB.
HTTP redirects are not followed by native clients, avoiding credential forwarding.

### Retries and concurrent edits

Calendar mutations have durable per-user `reqId` deduplication, committed in the
same SQLite transaction as the mutation. If a response is lost, resend **the same
command and request ID**, not a new ID. Reusing an ID with different input is a
409. The request journal currently has no expiration policy.
Live broadcasts use reserved `broadcast:` request IDs so another member's
notification cannot be mistaken for your request's reply.

Include `ifRevision` from a snapshot/read response to reject stale edits. This
first version uses a conservative **whole-database revision**, so an unrelated
concurrent edit can also cause a conflict. The TUI sends this precondition.
Direct API/`cal ipc` users can supply it; ordinary CLI mutations currently do not.
Clients do not automatically queue offline writes or carry edits to another route.

Token creation is special: its secret is returned exactly once and is **not**
saved in the deduplication journal. Retrying that request returns a conflict with
the token ID so an administrator can revoke it and issue a new request.
`cal tokens --json` lists token IDs/labels, never secrets.

### Timezone

There is one explicit IANA timezone per calendar server, persisted in SQLite.
Set `CAL_TIME_ZONE` before the first initialization or JSON import; otherwise
the host's current timezone is used. Moving an existing SQLite database preserves
its timezone. Changing the environment later does not reinterpret existing data.

Dates and times are wall-clock values in this timezone, not UTC timestamps.
The TUI uses the server timezone after bootstrap; CLI default date ranges obtain
it from `whoami`. All-day items remain date-only. Per-event timezones and travel
display conversions are intentionally not implemented yet.

## Ownership migration

Legacy JSON imports preserve IDs, groups, recurrence, deadlines and completion;
everything initially belongs to `local`. No ownership is guessed from names.
After creating members, an administrator assigns their existing data explicitly:

```sh
cal owner calendar CALENDAR_ID --user USER_ID --yes
cal owner group GROUP_ID --user USER_ID --yes
```

Group assignment transfers the group **and all its member calendars**. Individual
calendar assignment ungroups it if its old group belongs to another owner.
Events keep their IDs and inherit their calendar's new owner. New accounts receive
their own calendar automatically. Normal calendar patches cannot change owners.

## Hosting later

Run the daemon as a dedicated, unprivileged OS user with a private config directory.
Keep `CAL_HTTP_HOST=127.0.0.1` (default) and set a fixed `CAL_HTTP_PORT`. For example,
a future Caddy reverse proxy can terminate TLS and stream SSE:

```caddyfile
calendar.example.com {
    reverse_proxy 127.0.0.1:8088
}
```

This is a deployment example, **not an installed/tested public endpoint**. DNS,
certificates, firewall, process supervision, backups and external reachability
must be verified at deployment. HTTP is suitable for loopback testing; remote
clients require HTTPS by default. `CAL_ALLOW_INSECURE_HTTP=1` is an explicit client
escape hatch only for deliberate private-network testing.

Before requiring socket auth, issue an admin token for user ID `local`, configure
the local profile to read that token file, and verify it works. Do not expose
tokens in reverse-proxy access logs. Back up using SQLite's backup API, or stop
the daemon cleanly before copying its data; never copy only the main SQLite file
while ignoring an active WAL.

## Production cutover — only after approval

1. Keep the existing main/SSH daemon running during worktree tests. Test migration
   on a separately obtained backup, and prepare an explicit ownership mapping.
2. Prepare the destination host, TLS, clients and service configuration first.
   Verify with disposable data, not the live SQLite/JSON files.
3. Announce a brief write pause. Stop **only the calendar daemon** through its
   actual supervisor, then take the final JSON/data backup. Do not restart
   Exocortex itself. Existing client connections necessarily disconnect.
4. Import that final JSON into a new SQLite database, using the original calendar
   timezone. Verify IDs/counts/recurrence/completion, provision users/tokens, and
   assign ownership. Never run an old JSON writer and a new SQLite writer as two
   independent authorities for the same calendar.
5. After user approval, merge the tested branch to main, start the new calendar
   service on the chosen host, and have friends update their clients/profiles.
   Old socket/SSH clients remain supported in trusted-local mode, but they are
   not a substitute for authenticated per-user access.
6. Keep the pre-cutover backup. Once the new server has accepted writes, restoring
   the old JSON alone would lose those writes; a rollback then requires an
   explicit export/reconciliation, not silently switching storage back.

No synchronization between independent local and remote databases, public signup,
fine-grained sharing, browser client, high-availability clustering, or production
internet deployment is included in this experimental version.

## Verification

```sh
bun run check
./scripts/dev/caltest WORKTREE_NAME --check
```

The regression suite uses temporary databases and loopback ephemeral ports.
It covers migration/rollback, ownership and transfer, authentication/revocation,
retry/conflict handling, SSE, real CLI requests, headless TUI transport,
auth-required daemon startup and existing calendar behavior. No host GUI or
production service is started by these tests.
