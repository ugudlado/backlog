.PHONY: dev build test lint lint-fix format format-check type-check check doctor setup mcp install

dev:
	bun run cli

mcp:
	bun run mcp

build:
	bun run build

test:
	bun test

lint:
	bun run lint

lint-fix:
	bun run lint

format:
	bun run format

format-check:
	bunx biome format .

type-check:
	bun run check:types

check:
	bun run check

doctor: type-check test check
	@echo "All checks passed."

setup:
	bun install

# Install the freshly built binary onto the *resolved platform binary* the
# cli.cjs shim loads (via scripts/resolveBinary.cjs), NOT onto $(which backlog).
# Two macOS-specific hazards this avoids:
#  1. Under `npm link`, $(which backlog) is a symlink chain ending at the repo's
#     tracked scripts/cli.cjs; `cp` follows it and overwrites the source shim
#     with the 67MB binary, corrupting the global install.
#  2. `bun build --compile` emits a `linker-signed` ad-hoc Mach-O. A plain `cp`
#     invalidates that signature, so macOS AMFI SIGKILLs the copy (exit 137).
#     Re-signing the destination ad-hoc restores a valid signature.
install: build
	cp dist/backlog "$(shell node -e 'process.stdout.write(require("./scripts/resolveBinary.cjs").resolveBinaryPath())')"
	@if command -v codesign >/dev/null 2>&1; then \
		codesign --force --sign - "$(shell node -e 'process.stdout.write(require("./scripts/resolveBinary.cjs").resolveBinaryPath())')" >/dev/null 2>&1 \
			&& echo "re-signed installed binary (ad-hoc)" || true; \
	fi
