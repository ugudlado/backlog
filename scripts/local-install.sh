#!/usr/bin/env bash
# Local end-to-end install of @ugudlado1/backlog from this checkout.
#
# Mirrors the release pipeline: builds dist/backlog, packs both the platform
# sub-package and the main shim package as .tgz files, and installs them
# globally so `backlog --version` resolves to the locally-built code.
#
# To uninstall:
#   npm rm -g @ugudlado1/backlog @ugudlado1/backlog-<os>-<arch>

set -euo pipefail

cd "$(dirname "$0")/.."

case "$(uname -s)" in
	Darwin) OS="darwin" ;;
	Linux) OS="linux" ;;
	*) echo "Unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
	arm64|aarch64) ARCH="arm64" ;;
	x86_64) ARCH="x64" ;;
	*) echo "Unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

PKG="@ugudlado1/backlog-${OS}-${ARCH}"
MAIN="@ugudlado1/backlog"
# npm pack flattens "@scope/name" -> "scope-name" in the .tgz filename.
PKG_FILE="ugudlado1-backlog-${OS}-${ARCH}"
MAIN_FILE="ugudlado1-backlog"
STAGE=".local-install"
VERSION="0.0.0-local"

echo "==> Building dist/backlog"
bun run build >/dev/null

echo "==> Staging $STAGE/{platform,main}"
rm -rf "$STAGE"
mkdir -p "$STAGE/platform" "$STAGE/main"

cp dist/backlog "$STAGE/platform/backlog"
cat > "$STAGE/platform/package.json" <<EOF
{
  "name": "$PKG",
  "version": "$VERSION",
  "os": ["$OS"],
  "cpu": ["$ARCH"],
  "files": ["backlog", "package.json"]
}
EOF

cp scripts/cli.cjs "$STAGE/main/cli.cjs"
cp scripts/resolveBinary.cjs "$STAGE/main/resolveBinary.cjs"
cp scripts/proxyBypass.cjs "$STAGE/main/proxyBypass.cjs"
cp scripts/postuninstall.cjs "$STAGE/main/postuninstall.cjs"
cp scripts/postinstall.cjs "$STAGE/main/postinstall.cjs"
cp -f LICENSE README.md "$STAGE/main/" 2>/dev/null || true

cat > "$STAGE/main/package.json" <<EOF
{
  "name": "$MAIN",
  "version": "$VERSION",
  "bin": { "backlog": "cli.cjs" },
  "files": ["cli.cjs", "resolveBinary.cjs", "proxyBypass.cjs", "postuninstall.cjs", "postinstall.cjs", "package.json", "README.md", "LICENSE"],
  "optionalDependencies": {
    "$PKG": "$VERSION"
  },
  "scripts": {
    "postinstall": "node postinstall.cjs",
    "postuninstall": "node postuninstall.cjs"
  }
}
EOF

echo "==> Packing tarballs"
( cd "$STAGE/platform" && npm pack --silent ) >/dev/null
( cd "$STAGE/main"     && npm pack --silent ) >/dev/null
PLATFORM_TGZ="$(ls "$STAGE"/platform/${PKG_FILE}-${VERSION}.tgz)"
MAIN_TGZ="$(ls "$STAGE"/main/${MAIN_FILE}-${VERSION}.tgz)"
echo "  platform: $PLATFORM_TGZ"
echo "  main:     $MAIN_TGZ"

echo "==> Removing any previous global install"
npm rm -g "$MAIN" "$PKG" 2>/dev/null || true

echo "==> Installing platform package globally"
npm i -g "$PLATFORM_TGZ"

echo "==> Installing main package globally"
npm i -g "$MAIN_TGZ"

echo
echo "Installed. Verify:"
echo "  $(command -v backlog)"
echo "  $(backlog --version 2>&1 || true)"
echo
echo "To remove:"
echo "  npm rm -g $MAIN $PKG"
