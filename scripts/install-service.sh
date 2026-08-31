#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/whale-cal-daemon.service" <<EOF
[Unit]
Description=Whale Cal daemon
After=default.target

[Service]
Type=simple
ExecStart=$ROOT/bin/cald
Restart=on-failure
RestartSec=1
WorkingDirectory=$ROOT

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now whale-cal-daemon.service
