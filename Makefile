.PHONY: help install setup unsetup doctor dev build start stop clean icons shots dist \
	test test-smoke test-touch test-changes test-preview-url test-idle test-ask test-setup test-install test-clean \
	phone phone-off mobile \
	remote-on remote-off remote-status

.DEFAULT_GOAL := help

# Resolve Tailscale CLI (app install does not put it on PATH)
TS := $(shell command -v tailscale 2>/dev/null || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)
PORT := 7788
# Match server KEEP for screenshots / uploads
CACHE_KEEP := 50
ORBIT_HOME := $(HOME)/.orbit

help: ## Show available targets
	@echo ""
	@echo "  Orbit — make targets"
	@echo ""
	@echo "  Setup:   make install && make setup   (first time on a machine)"
	@echo "  Phone:   make phone   →  make stop when done"
	@echo "  Test:    make test    (throwaway server on a spare port, never touches ~/.orbit)"
	@echo "  Hygiene: make clean   (prune ~/.orbit caches; keeps auth/sessions)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo ""

install: ## Install dependencies (needs Bun: https://bun.sh)
	bun install

# One command between `git clone` and a working setup. Everything it writes is
# derived from where this checkout is, so nothing has a path to substitute by
# hand — which is what made the old copy-this-JSON instructions fail silently.
setup: build ## Build, register the MCP server, and install the hooks (run after make install)
	@bun server/dist/main.js setup

unsetup: ## Undo make setup (leaves the checkout and ~/.orbit alone)
	@bun server/dist/main.js setup --uninstall

doctor: ## What this Mac has and what it is missing (Claude Code, Chrome, Tailscale, hooks, MCP)
	@bun server/dist/main.js doctor

# ── local ──────────────────────────────────────────────

dev: ## Start dev servers (web :5173, api :7788)
	bun run dev

build: ## Build server + web for production
	bun run build

start: build ## Build and run production on :7788 (no Tailscale)
	bun run start

dist: ## One executable with everything in it → dist/orbit (make dist TARGETS=all for both Mac archs)
	@scripts/dist.sh $(TARGETS)

stop: ## Stop Orbit on :7788 and Tailscale HTTPS (443)
	@PIDS=$$(lsof -tiTCP:$(PORT) -sTCP:LISTEN 2>/dev/null || true); \
	if [ -n "$$PIDS" ]; then \
		echo "  Stopping PID(s) $$PIDS on :$(PORT)"; \
		kill $$PIDS 2>/dev/null || true; \
		sleep 0.3; \
		STILL=$$(lsof -tiTCP:$(PORT) -sTCP:LISTEN 2>/dev/null || true); \
		if [ -n "$$STILL" ]; then echo "  Force-killing $$STILL"; kill -9 $$STILL 2>/dev/null || true; fi; \
	else \
		echo "  Nothing listening on :$(PORT)"; \
	fi
	@$(MAKE) --no-print-directory phone-off

shots: ## Retake docs/images from the current UI (throwaway server, real HOME)
	@scripts/shots.sh $(filter-out $@,$(MAKECMDGOALS))

icons: ## Regenerate app icons from the mark + palette (web/public/*.png, icon.svg)
	@bun scripts/icons.mjs

# ── test ───────────────────────────────────────────────
# Builds, starts an Orbit of its own (first free port from 3099, scratch HOME
# named after it), runs the suites, and takes both down again. The one you are
# using on :7788 is never touched.

test: ## Run every suite against a throwaway server
	@scripts/test.sh all

test-install: ## The installer (install.sh) against a stand-in release (no network)
	@scripts/test.sh install

test-smoke: ## API / MCP / hooks only (no browser)
	@scripts/test.sh smoke

test-touch: ## Touch behaviour only (needs system Chrome)
	@scripts/test.sh touch

test-changes: ## The Changes tab only (needs system Chrome)
	@scripts/test.sh changes

test-preview-url: ## How an agent's path becomes a URL (no server, no Tailscale)
	@scripts/test.sh preview-url

test-idle: ## Noticing a session went quiet (no server needed)
	@scripts/test.sh idle

test-ask: ## Answering a question from a notification (no server needed)
	@scripts/test.sh ask

test-setup: ## Wiring a checkout into Claude Code (no server needed)
	@scripts/test.sh setup

# A run cleans up after itself — unless it was killed outright (kill -9, or the
# terminal it lived in went away), in which case its EXIT trap never fired. That
# leaves an orphaned server holding a port and a scratch HOME nobody will empty.
# Both are recognisable: the server has been reparented to init, and the HOME is
# named after a port that nothing is listening on.
test-clean: ## Reap test servers and scratch HOMEs left by killed runs
	@for p in $$(seq 3099 3148); do \
		for pid in $$(lsof -tiTCP:$$p -sTCP:LISTEN 2>/dev/null); do \
			ppid=$$(ps -o ppid= -p $$pid 2>/dev/null | tr -d ' '); \
			if [ "$$ppid" = "1" ]; then \
				echo "  Orphaned test server on :$$p (PID $$pid) — killing"; \
				kill $$pid 2>/dev/null || true; \
			else \
				echo "  :$$p in use by a live run (PID $$pid) — left alone"; \
			fi; \
		done; \
	done
	@sleep 0.3
	@removed=0; \
	for dir in /tmp/orbit-smoke /tmp/orbit-smoke-*; do \
		[ -d "$$dir" ] || continue; \
		port=$${dir##*-}; \
		case "$$port" in \
			[0-9][0-9][0-9][0-9]) \
				if lsof -tiTCP:$$port -sTCP:LISTEN >/dev/null 2>&1; then \
					echo "  $$dir — still in use by :$$port, kept"; \
					continue; \
				fi;; \
		esac; \
		rm -rf "$$dir" && echo "  $$dir — removed" && removed=$$((removed + 1)); \
	done; \
	echo "  Removed $$removed scratch HOME(s)."

clean: ## Prune ~/.orbit screenshots & uploads (keep newest 50 each)
	@for name in screenshots uploads; do \
		dir="$(ORBIT_HOME)/$$name"; \
		if [ ! -d "$$dir" ]; then echo "  $$dir — (missing)"; continue; fi; \
		count=0; removed=0; \
		for f in $$(ls -t "$$dir" 2>/dev/null); do \
			count=$$((count + 1)); \
			if [ $$count -gt $(CACHE_KEEP) ]; then \
				rm -f "$$dir/$$f" && removed=$$((removed + 1)); \
			fi; \
		done; \
		echo "  $$dir — kept ≤$(CACHE_KEEP), removed $$removed"; \
	done; \
	echo "  (config.json, sessions, push subscriptions left alone)"

# ── phone (Tailscale HTTPS → :7788) ─────────────────────
# Same origin for Safari/Chrome and a Home Screen install:
# https://<machine>.<tailnet>.ts.net  (443 → localhost:7788)
#
# Does not stop agent-opened GUI browsers (Chrome tabs from a CLI in a
# session). Those are outside Orbit's process; use make stop for Orbit +
# Tailscale only. Prefer orbit_capture / headless Playwright for agent UI checks.

phone: build ## Phone access — prod :7788 + Tailscale HTTPS (orbit phone)
	@bun server/dist/main.js phone

phone-off: ## Stop Tailscale serve (443) used by make phone
	@bun server/dist/main.js phone off 2>/dev/null || $(TS) serve --https=443 off 2>/dev/null || true

# ── LAN browser (dev, same WiFi) ───────────────────────

mobile: ## Phone on same WiFi — print LAN URL, then start dev
	@IP=$$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "<mac-ip>"); \
	echo ""; \
	echo "  Open on phone (same WiFi):"; \
	echo "    http://$$IP:5173"; \
	echo ""; \
	echo "  Voice / Home Screen need HTTPS → use: make phone"; \
	echo "  Stop: Ctrl+C  (or make stop if production is also up)"; \
	echo ""; \
	bun run dev

# ── remote (Tailscale) ─────────────────────────────────

remote-on: ## Expose :7788 via Tailscale HTTPS
	@$(TS) serve --bg $(PORT)

remote-off: ## Stop Tailscale serve
	@$(TS) serve --https=443 off

remote-status: ## Show Tailscale serve status
	@$(TS) serve status
