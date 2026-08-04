.PHONY: help install dev build start stop clean \
	phone phone-off mobile \
	remote-on remote-off remote-status

.DEFAULT_GOAL := help

# Resolve Tailscale CLI (app install does not put it on PATH)
TS := $(shell command -v tailscale 2>/dev/null || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)
PORT := 3001
# Match server KEEP for screenshots / uploads
CACHE_KEEP := 50
ORBIT_HOME := $(HOME)/.orbit

help: ## Show available targets
	@echo ""
	@echo "  Orbit — make targets"
	@echo ""
	@echo "  Phone:   make phone   →  make stop when done"
	@echo "  Hygiene: make clean   (prune ~/.orbit caches; keeps auth/sessions)"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo ""

install: ## Install dependencies
	npm install

# ── local ──────────────────────────────────────────────

dev: ## Start dev servers (web :5173, api :3001)
	npm run dev

build: ## Build server + web for production
	npm run build

start: build ## Build and run production on :3001 (no Tailscale)
	npm start -w server

stop: ## Stop Orbit on :3001 and Tailscale HTTPS (443)
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

# ── phone (Tailscale HTTPS → :3001) ─────────────────────
# Same origin for Safari/Chrome and a Home Screen install:
# https://<machine>.<tailnet>.ts.net  (443 → localhost:3001)
#
# Does not stop agent-opened GUI browsers (Chrome tabs from a CLI in a
# session). Those are outside Orbit's process; use make stop for Orbit +
# Tailscale only. Prefer orbit_capture / headless Playwright for agent UI checks.

phone: build ## Phone access — prod :3001 + Tailscale HTTPS
	@echo ""
	@echo "  Enabling Tailscale HTTPS → localhost:$(PORT) …"
	@$(TS) serve --bg $(PORT)
	@HOST=$$($(TS) status --json 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);process.stdout.write((j.Self&&j.Self.DNSName||'').replace(/\.$$/,''))}catch{}})"); \
	echo ""; \
	echo "  Open on phone (Tailscale VPN on):"; \
	if [ -n "$$HOST" ]; then \
		echo "    https://$$HOST"; \
	else \
		echo "    https://<machine>.<tailnet>.ts.net"; \
		echo "  (MagicDNS unknown — is Tailscale logged in?)"; \
	fi; \
	echo ""; \
	echo "  Works in the browser or the Home Screen app."; \
	echo "  Stop everything:  make stop"; \
	echo ""; \
	PIDS=$$(lsof -tiTCP:$(PORT) -sTCP:LISTEN 2>/dev/null || true); \
	if [ -n "$$PIDS" ]; then \
		echo "  Port $(PORT) already in use (PID $$PIDS)."; \
		echo "  Tailscale is ready — open the URL above, or:"; \
		echo "    make stop && make phone    # restart with this build"; \
		echo ""; \
		$(TS) serve status; \
	else \
		npm start -w server; \
	fi

phone-off: ## Stop Tailscale serve (443) used by make phone
	@$(TS) serve --https=443 off 2>/dev/null || true
	@echo "  Tailscale HTTPS (443) off."

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
	npm run dev

# ── remote (Tailscale) ─────────────────────────────────

remote-on: ## Expose :3001 via Tailscale HTTPS
	@$(TS) serve --bg $(PORT)

remote-off: ## Stop Tailscale serve
	@$(TS) serve --https=443 off

remote-status: ## Show Tailscale serve status
	@$(TS) serve status
