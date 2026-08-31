PREFIX := $(HOME)/.local
BIN_DIR := $(PREFIX)/bin

.PHONY: install uninstall check

install:
	@command -v bun >/dev/null || { echo "bun is required"; exit 1; }
	@bun install
	@chmod +x bin/cal bin/cald scripts/install-service.sh scripts/uninstall-service.sh
	@mkdir -p "$(BIN_DIR)"
	@ln -sfn "$(CURDIR)/bin/cal" "$(BIN_DIR)/whale-cal"
	@ln -sfn "$(CURDIR)/bin/cald" "$(BIN_DIR)/cald"
	@bash scripts/install-service.sh
	@printf '\n✓ Installed whale-cal and cald in %s\n' "$(BIN_DIR)"

uninstall:
	@bash scripts/uninstall-service.sh
	@rm -f "$(BIN_DIR)/whale-cal" "$(BIN_DIR)/cald"
	@printf '\n✓ Uninstalled whale-cal and cald from %s\n' "$(BIN_DIR)"

check:
	@bun run check
