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

install: build
	cp dist/backlog $(shell dirname $(shell which backlog))/backlog
