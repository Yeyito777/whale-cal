#!/usr/bin/env bash
# Shared helpers for Whale Cal worktree scripts.

WORKTREE_SCRIPT_DIR="$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WHALE_CAL_COMMON_GIT_DIR="$(git -C "$WORKTREE_SCRIPT_DIR" rev-parse --git-common-dir 2>/dev/null)" || {
  printf '\n  ✗ Worktree scripts must run from a Whale Cal Git checkout.\n\n' >&2
  exit 1
}
if [[ "$WHALE_CAL_COMMON_GIT_DIR" != /* ]]; then
  WHALE_CAL_COMMON_GIT_DIR="$(cd -P -- "$WORKTREE_SCRIPT_DIR/$WHALE_CAL_COMMON_GIT_DIR" && pwd)"
fi
WHALE_CAL_ROOT="$(cd -P -- "$WHALE_CAL_COMMON_GIT_DIR/.." && pwd)"
WHALE_CAL_WORKTREES_DIR="$WHALE_CAL_ROOT/.worktrees"

worktree_die() {
  printf "\n  ✗ %s\n\n" "$1" >&2
  exit 1
}

validate_worktree_name() {
  local name="${1:-}"

  [[ -n "$name" ]] || worktree_die "A worktree name is required."
  [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
    worktree_die "Use a simple worktree name containing only letters, numbers, '.', '_', and '-': $name"
  }
  git check-ref-format --branch "$name" >/dev/null 2>&1 || worktree_die "Invalid Git branch name: $name"
}

resolve_worktree_dir() {
  local input="${1:-}"
  local candidate=""
  local name=""

  [[ -n "$input" ]] || worktree_die "Usage: <worktree-name|path>"

  if [[ "$input" == /* ]]; then
    candidate="${input%/}"
  elif [[ "$input" == .worktrees/* ]]; then
    candidate="$WHALE_CAL_ROOT/${input%/}"
  elif [[ "$input" != */* ]]; then
    candidate="$WHALE_CAL_WORKTREES_DIR/$input"
  else
    worktree_die "Use a worktree name or a path directly under $WHALE_CAL_WORKTREES_DIR"
  fi

  case "$candidate" in
    "$WHALE_CAL_WORKTREES_DIR"/*)
      name="${candidate#"$WHALE_CAL_WORKTREES_DIR"/}"
      ;;
    *)
      worktree_die "Refusing to manage a path outside $WHALE_CAL_WORKTREES_DIR: $candidate"
      ;;
  esac

  [[ "$name" != */* ]] || worktree_die "Worktrees must be direct children of $WHALE_CAL_WORKTREES_DIR"
  validate_worktree_name "$name"
  printf '%s\n' "$candidate"
}

worktree_instance_config_dir() {
  local worktree_dir="$1"
  local name=""
  name="$(basename "$worktree_dir")"
  printf '%s\n' "$WHALE_CAL_ROOT/config/worktrees/$name"
}

sync_isolated_config() {
  local worktree_dir="$1"
  local instance_config=""
  local source_config=""
  instance_config="$(worktree_instance_config_dir "$worktree_dir")"

  mkdir -p "$instance_config/data" "$instance_config/runtime"
  chmod 700 "$instance_config" "$instance_config/data" "$instance_config/runtime" 2>/dev/null || true

  # Preserve familiar UI preferences without sharing mutable calendar data,
  # sockets, PIDs, or logs with the main checkout.
  if [[ -f "$WHALE_CAL_ROOT/config/config.json" ]]; then
    source_config="$WHALE_CAL_ROOT/config/config.json"
  elif [[ -f "$WHALE_CAL_ROOT/config/config.example.json" ]]; then
    source_config="$WHALE_CAL_ROOT/config/config.example.json"
  fi
  if [[ -n "$source_config" && ! -e "$instance_config/config.json" ]]; then
    cp "$source_config" "$instance_config/config.json"
    chmod 600 "$instance_config/config.json" 2>/dev/null || true
  fi
}

sync_dependency_artifacts() {
  local worktree_dir="$1"
  local main_bun_cache="$WHALE_CAL_ROOT/node_modules/.bun"
  local worktree_bun_cache="$worktree_dir/node_modules/.bun"
  local workspace=""

  [[ "$worktree_dir" != "$WHALE_CAL_ROOT" ]] || return 0

  # Share Bun's content-addressed package cache. Bun recreates this worktree's
  # top-level links during install, while package contents remain local-cache hits.
  if [[ -d "$main_bun_cache" ]]; then
    mkdir -p "$worktree_dir/node_modules"
    if [[ ! -L "$worktree_bun_cache" ]] || [[ "$(readlink "$worktree_bun_cache" 2>/dev/null || true)" != "$main_bun_cache" ]]; then
      rm -rf "$worktree_bun_cache"
      ln -s "$main_bun_cache" "$worktree_bun_cache"
    fi
  fi

  # Workspace package links are relative. Copying each tiny layout preserves
  # links such as @whale-cal/shared -> ../../../shared within the new worktree.
  for workspace in shared daemon tui cli; do
    if [[ -d "$WHALE_CAL_ROOT/$workspace/node_modules" && ! -e "$worktree_dir/$workspace/node_modules" ]]; then
      cp -a "$WHALE_CAL_ROOT/$workspace/node_modules" "$worktree_dir/$workspace/node_modules"
    fi
  done
}

cleanup_worktree_config() {
  local worktree_dir="$1"
  local instance_config=""
  instance_config="$(worktree_instance_config_dir "$worktree_dir")"

  rm -rf "$instance_config"
  git -C "$WHALE_CAL_ROOT" worktree prune >/dev/null 2>&1 || true
}
