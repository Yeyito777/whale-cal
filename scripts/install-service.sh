#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="$(command -v bun || true)"

if [[ -z "$BUN" ]]; then
  echo "bun is required" >&2
  exit 1
fi

config_root() {
  local configured="${CAL_CONFIG_DIR:-}"
  if [[ -z "$configured" ]]; then
    printf '%s/config\n' "$ROOT"
  elif [[ "$configured" = /* ]]; then
    printf '%s\n' "$configured"
  else
    printf '%s/%s\n' "$ROOT" "$configured"
  fi
}

wait_for_daemon() {
  local attempt
  for ((attempt = 0; attempt < 50; attempt++)); do
    if "$ROOT/bin/cald" status >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

stop_unmanaged_daemon() {
  if ! "$ROOT/bin/cald" status >/dev/null 2>&1; then
    return 0
  fi

  local pid_file pid command attempt
  pid_file="$(config_root)/runtime/cald.pid"
  if [[ ! -r "$pid_file" ]]; then
    echo "cald is running, but its PID file is unavailable: $pid_file" >&2
    return 1
  fi

  pid="$(tr -d '[:space:]' < "$pid_file")"
  if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]]; then
    echo "cald has an invalid PID file: $pid_file" >&2
    return 1
  fi

  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  if [[ "$command" != *"$ROOT/daemon/src/main.ts"* ]]; then
    echo "refusing to stop PID $pid because it does not look like this Whale Cal daemon" >&2
    return 1
  fi

  kill -TERM "$pid"
  for ((attempt = 0; attempt < 50; attempt++)); do
    if ! "$ROOT/bin/cald" status >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  echo "cald did not stop cleanly" >&2
  return 1
}

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf '%s' "$value"
}

install_launchd() {
  local label="com.whale-cal.daemon"
  local agent_dir="$HOME/Library/LaunchAgents"
  local plist="$agent_dir/$label.plist"
  local domain runtime_dir
  domain="gui/$(id -u)"
  runtime_dir="$(config_root)/runtime"

  if ! launchctl print "$domain" >/dev/null 2>&1; then
    domain="user/$(id -u)"
  fi

  mkdir -p "$agent_dir" "$runtime_dir"
  launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
  stop_unmanaged_daemon

  local root_xml bun_xml stdout_xml stderr_xml config_xml=""
  root_xml="$(xml_escape "$ROOT")"
  bun_xml="$(xml_escape "$BUN")"
  stdout_xml="$(xml_escape "$runtime_dir/cald-service.stdout.log")"
  stderr_xml="$(xml_escape "$runtime_dir/cald-service.stderr.log")"
  if [[ -n "${CAL_CONFIG_DIR:-}" ]]; then
    config_xml="
    <key>EnvironmentVariables</key>
    <dict>
      <key>CAL_CONFIG_DIR</key>
      <string>$(xml_escape "${CAL_CONFIG_DIR}")</string>
    </dict>"
  fi

  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$bun_xml</string>
    <string>run</string>
    <string>$root_xml/daemon/src/main.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$root_xml</string>$config_xml
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>1</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>$stdout_xml</string>
  <key>StandardErrorPath</key>
  <string>$stderr_xml</string>
</dict>
</plist>
EOF

  plutil -lint "$plist" >/dev/null
  launchctl enable "$domain/$label"
  launchctl bootstrap "$domain" "$plist"

  if ! wait_for_daemon; then
    echo "launchd loaded $label, but cald did not become ready" >&2
    echo "inspect $runtime_dir/cald-service.stderr.log for details" >&2
    return 1
  fi
  echo "✓ Installed and started launchd agent $label"
}

install_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl is required for the Linux user service" >&2
    exit 1
  fi

  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  local unit="$unit_dir/whale-cal-daemon.service"
  mkdir -p "$unit_dir"
  systemctl --user disable --now whale-cal-daemon.service >/dev/null 2>&1 || true
  stop_unmanaged_daemon

  local config_line=""
  if [[ -n "${CAL_CONFIG_DIR:-}" ]]; then
    config_line="Environment=\"CAL_CONFIG_DIR=${CAL_CONFIG_DIR}\""
  fi

  cat > "$unit" <<EOF
[Unit]
Description=Whale Cal daemon
After=default.target

[Service]
Type=simple
ExecStart="$BUN" run "$ROOT/daemon/src/main.ts"
Restart=on-failure
RestartSec=1
WorkingDirectory=$ROOT
$config_line

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now whale-cal-daemon.service
  if ! wait_for_daemon; then
    echo "systemd started whale-cal-daemon.service, but cald did not become ready" >&2
    echo "inspect it with: journalctl --user -u whale-cal-daemon.service" >&2
    return 1
  fi
  echo "✓ Installed and started systemd user service whale-cal-daemon.service"
}

case "$(uname -s)" in
  Darwin) install_launchd ;;
  Linux) install_systemd ;;
  *)
    echo "automatic daemon installation is supported on macOS and Linux only" >&2
    exit 1
    ;;
esac
