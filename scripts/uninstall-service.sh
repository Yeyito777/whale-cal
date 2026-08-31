#!/usr/bin/env bash
set -euo pipefail

uninstall_launchd() {
  local label="com.whale-cal.daemon"
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  local uid
  uid="$(id -u)"

  launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || \
    launchctl bootout "user/$uid/$label" >/dev/null 2>&1 || \
    launchctl bootout "gui/$uid" "$plist" >/dev/null 2>&1 || \
    launchctl bootout "user/$uid" "$plist" >/dev/null 2>&1 || true
  rm -f "$plist"
  echo "✓ Removed launchd agent $label"
}

uninstall_systemd() {
  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now whale-cal-daemon.service >/dev/null 2>&1 || true
  fi
  rm -f "$unit_dir/whale-cal-daemon.service"
  if command -v systemctl >/dev/null 2>&1; then
    systemctl --user daemon-reload >/dev/null 2>&1 || true
    systemctl --user reset-failed whale-cal-daemon.service >/dev/null 2>&1 || true
  fi
  echo "✓ Removed systemd user service whale-cal-daemon.service"
}

case "$(uname -s)" in
  Darwin) uninstall_launchd ;;
  Linux) uninstall_systemd ;;
  *) echo "No managed Whale Cal daemon service is installed for $(uname -s)" ;;
esac
