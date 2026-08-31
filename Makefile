PREFIX := $(HOME)/.local
BIN_DIR := $(PREFIX)/bin

.PHONY: install uninstall check

install:
	@command -v bun >/dev/null || { echo "bun is required"; exit 1; }
	@bun install
	@chmod +x bin/cal bin/cald scripts/install-service.sh
	@mkdir -p $(BIN_DIR)
	@ln -sf $(CURDIR)/bin/cal $(BIN_DIR)/whale-cal
	@ln -sf $(CURDIR)/bin/cald $(BIN_DIR)/cald
	@bash scripts/install-service.sh
	@printf '\n✓ Installed whale-cal and cald in $(BIN_DIR)\n'

uninstall:
	@systemctl --user disable --now whale-cal-daemon.service 2>/dev/null || true
	@rm -f $${XDG_CONFIG_HOME:-$$HOME/.config}/systemd/user/whale-cal-daemon.service
	@systemctl --user daemon-reload 2>/dev/null || true
	@rm -f $(BIN_DIR)/whale-cal $(BIN_DIR)/cald

check:
	@bun run check
