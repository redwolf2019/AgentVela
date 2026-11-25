.DEFAULT_GOAL := help

.PHONY: help install dev dev-web build dist check clean distclean check-deps

# Append local node_modules/.bin so a globally installed vp keeps precedence.
export PATH := $(PATH):$(CURDIR)/node_modules/.bin

UNAME_S := $(shell uname -s 2>/dev/null || echo Unknown)

DEBUG_PORT ?=
HOME_DIR ?=
ARGS ?=

DEV_ENV := $(if $(strip $(DEBUG_PORT)),T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT="$(strip $(DEBUG_PORT))",)
DEV_HOME_FLAG := $(if $(strip $(HOME_DIR)),--home-dir "$(strip $(HOME_DIR))",)

help:
	@printf "Usage: make <target> [VAR=value]\n\n"
	@printf "Targets:\n"
	@printf "  help        Show this help message (default)\n"
	@printf "  install     Install workspace dependencies (vp i / pnpm install)\n"
	@printf "  dev         Run local Desktop app in dev hot-reload mode\n"
	@printf "  dev-web     Run local Web + Server in dev mode\n"
	@printf "  build       Build Desktop, Server, and Web bundles\n"
	@printf "  dist        Build unsigned Desktop installer for current OS\n"
	@printf "  check       Run branch checks (vp run check:changed)\n"
	@printf "  clean       Remove build outputs (keeps node_modules)\n"
	@printf "  distclean   Remove build outputs, node_modules, and .vite-plus caches\n\n"
	@printf "Optional variables (for dev / dev-web / dist):\n"
	@printf "  DEBUG_PORT  Electron remote debugging port (e.g. DEBUG_PORT=9222)\n"
	@printf "  HOME_DIR    Override T3 data directory (e.g. HOME_DIR=/tmp/t3-dev)\n"
	@printf "  ARGS        Extra flags passed to the underlying task (e.g. ARGS=\"--no-seed\")\n"

check-deps:
	@if [ ! -d "$(CURDIR)/node_modules" ]; then \
		printf "Missing node_modules. Run 'make install' first.\n" >&2; \
		exit 1; \
	fi
	@if ! command -v vp >/dev/null 2>&1; then \
		printf "Missing 'vp' (Vite+). Install Vite+ (curl -fsSL https://vite.plus | bash) or run 'make install'.\n" >&2; \
		exit 1; \
	fi

install:
	@if command -v vp >/dev/null 2>&1; then \
		vp i; \
	elif command -v pnpm >/dev/null 2>&1; then \
		pnpm install; \
	else \
		printf "Neither 'vp' nor 'pnpm' is available. Install Vite+: curl -fsSL https://vite.plus | bash\n" >&2; \
		exit 1; \
	fi

dev: check-deps
	$(DEV_ENV) vp run dev:desktop $(DEV_HOME_FLAG) $(ARGS)

dev-web: check-deps
	vp run dev $(DEV_HOME_FLAG) $(ARGS)

build: check-deps
	vp run build:desktop

dist: check-deps
ifeq ($(UNAME_S),Darwin)
	vp run dist:desktop:dmg $(ARGS)
else ifeq ($(UNAME_S),Linux)
	vp run dist:desktop:linux $(ARGS)
else ifneq (,$(filter MINGW% MSYS% CYGWIN%,$(UNAME_S)))
	vp run dist:desktop:win $(ARGS)
else
	@printf "Unsupported OS '%s'. Run 'vp run dist:desktop:artifact --help' for manual options.\n" "$(UNAME_S)" >&2
	@exit 1
endif

check: check-deps
	vp run check:changed

clean:
	rm -rf apps/*/dist apps/*/dist-electron packages/*/dist release

distclean: clean
	rm -rf node_modules apps/*/node_modules packages/*/node_modules .vite-plus apps/*/.vite-plus packages/*/.vite-plus
