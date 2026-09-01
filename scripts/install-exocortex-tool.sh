#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
EXOCORTEX_ROOT="${1:-${EXOCORTEX_SOURCE_DIR:-}}"

if [[ -z "$EXOCORTEX_ROOT" ]]; then
  sibling="$(dirname -- "$ROOT")/Exocortex"
  if [[ -d "$sibling/external-tools" ]]; then
    EXOCORTEX_ROOT="$sibling"
  else
    echo "usage: $0 /path/to/Exocortex" >&2
    echo "Set EXOCORTEX_SOURCE_DIR or pass the checkout path as the first argument." >&2
    exit 2
  fi
fi

EXOCORTEX_ROOT="$(cd -P -- "$EXOCORTEX_ROOT" && pwd)"
if [[ ! -f "$EXOCORTEX_ROOT/external-tools/TOOL_STANDARD.md" ]]; then
  echo "Not an Exocortex source checkout: $EXOCORTEX_ROOT" >&2
  exit 1
fi

BUN="$(command -v bun || true)"
if [[ -z "$BUN" ]]; then
  echo "bun is required" >&2
  exit 1
fi

TOOL_ROOT="$EXOCORTEX_ROOT/external-tools/cal-cli"
mkdir -p "$TOOL_ROOT/bin" "$TOOL_ROOT/config"
rm -f "$TOOL_ROOT/manifest.json"
install -m 0755 "$ROOT/integrations/exocortex/bin/cal" "$TOOL_ROOT/bin/cal"
install -m 0755 "$ROOT/integrations/exocortex/bin/cald-supervisor" "$TOOL_ROOT/bin/cald-supervisor"
printf '%s\n' "$ROOT" > "$TOOL_ROOT/config/source"
printf '%s\n' "$BUN" > "$TOOL_ROOT/config/bun"

# Exocortex now owns cald. Avoid two service managers racing over one socket.
bash "$ROOT/scripts/uninstall-service.sh"

# Install the manifest last so discovery only sees a complete tool directory.
manifest_tmp="$TOOL_ROOT/.manifest.json.$$"
install -m 0644 "$ROOT/integrations/exocortex/manifest.json" "$manifest_tmp"
mv -f "$manifest_tmp" "$TOOL_ROOT/manifest.json"

echo "✓ Installed Exocortex external tool 'cal' in $TOOL_ROOT"
echo "  Exocortex now supervises cald; the native per-user service was removed."
