# GitRoll developer shortcuts. Run `make` to see them.
.DEFAULT_GOAL := help
ROLL ?=

.PHONY: help setup build core test e2e typecheck check audit run demo link unlink release verify-release clean

help: ## Show these commands
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  make %-10s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

setup: ## Install development dependencies and build
	npm ci

build: ## Build the installable app into dist/
	npm run build

core: ## Build the shared @gitroll/core package (packages/core/dist)
	rm -rf packages/core/dist
	npm run build:core

test: ## Run the tests
	npm test

e2e: ## Run only the end-to-end tests (built app, sharing, browser API, terminal app)
	node --disable-warning=ExperimentalWarning --test test/e2e.test.ts

typecheck: ## Check TypeScript types
	npm run typecheck

check: typecheck test build core audit ## Everything that must pass before a release

audit: ## Look for known vulnerabilities in dependencies
	npm audit --audit-level=moderate

run: build ## Open GitRoll from this checkout (ROLL=/path/to/roll to pick one)
	node dist/gitroll.mjs open $(if $(ROLL),-C "$(ROLL)",)

demo: build ## Open a throwaway demo Roll with sample events
	@rm -rf .demo && mkdir -p .demo
	@GITROLL_HOME=.demo/settings node dist/gitroll.mjs init --dir .demo/roll >/dev/null
	@node dist/gitroll.mjs log -C .demo/roll "Carlos finished the shower tile. Paid the rest. #tile" --type expense -p "Bathroom Remodel" --amount '$$1,850' >/dev/null
	@node dist/gitroll.mjs log -C .demo/roll "AC serviced, capacitor replaced. One-year warranty. #hvac" --type expense -p House --amount 325 >/dev/null
	GITROLL_HOME=.demo/settings node dist/gitroll.mjs open -C .demo/roll

link: build ## Install the `gitroll` command from this checkout
	npm link

unlink: ## Remove the linked `gitroll` command
	npm unlink -g gitroll

release: check ## Build versioned release artifacts in release/ (package, SHA256SUMS, Homebrew, Scoop)
	node scripts/release.mjs

verify-release: ## Install release/ into a clean location and use it end to end
	node scripts/verify-install.mjs release

clean: ## Remove build output
	rm -rf dist packages/core/dist .demo release gitroll-*.tgz
