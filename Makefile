# Shortcuts for this repository. Run `make install` once, then `make check-all` and `make test-all` before pushing.

PNPM ?= pnpm

.PHONY: install check check-all fix audit-fix test test-all dev synth clean

# The pnpm workspace, app included, and the git hook that runs the pre-commit hooks on each commit, with their
# environments, so a first commit has nothing to download.
install:
	@$(PNPM) install --frozen-lockfile
	@pre-commit install --install-hooks

# Dependency audit (the whole workspace, app included), formatting, lint, then the pre-commit hooks.
check:
	@$(PNPM) audit
	@$(PNPM) prettier
	@$(PNPM) lint
	@pre-commit run --all-files

# Also the app's lint, formatting and type checks.
check-all: check
	@(cd app && $(PNPM) check)

fix:
	@$(PNPM) prettier-fix
	@$(PNPM) lint-fix
	@(cd app && $(PNPM) format:fix && $(PNPM) lint:fix)

# Adds overrides that force patched versions; prefer `pnpm update <package>` when the patch is in range.
audit-fix:
	@$(PNPM) audit --fix

# Infrastructure tests (jest and cdk-nag).
test:
	@$(PNPM) test

# Infrastructure and app tests.
test-all: test
	@(cd app && $(PNPM) test)

# The API locally, with in-memory stores, on http://127.0.0.1:8787/api/v1.
dev:
	@(cd app && $(PNPM) dev)

synth:
	@$(PNPM) cdk-stateful synth --quiet
	@$(PNPM) cdk-stateless synth --quiet

clean:
	@rm -rf cdk.out
