#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 dsh-code-review contributors
#
# build-fork.sh -- the single source of truth for building the codecheck
# review engine (a fork of alibaba/open-code-review).
#
# Everything it needs is derived from a real source; nothing is hand-typed:
#   * plugin version  <- <repo root>/package.json  ("version")
#   * engine fork N   <- git rev-list --no-merges --count HEAD -- engine/
#   * commit          <- git rev-parse --short HEAD
#   * build time      <- date -u +%Y-%m-%dT%H:%M:%SZ
#
# The stamped binary version is "<plugin version>+fork.<N>", where N is the
# number of commits in this repository that touch the engine/ subtree. Bump the
# version in the root package.json to change the engine version; you never edit
# a version string in the Go source.
#
# Usage:
#   bash engine/scripts/build-fork.sh [-h|--help]
#
# Environment overrides:
#   GOOS      cross-compile target OS (default: host). The output gets a ".exe"
#   GOARCH    cross-compile target arch (default: host). suffix only on windows.
#   OUTPUT    explicit output path for the binary (overrides the default).
#
# Default output: <repo root>/bin/codecheck[.exe]  (git-ignored).

set -euo pipefail

show_help() {
	cat <<'EOF'
build-fork.sh -- build the codecheck review engine (open-code-review fork).

Usage:
  bash engine/scripts/build-fork.sh [-h|--help]

It reads the plugin version from the repo root package.json, computes the
engine fork counter N with:
    git rev-list --no-merges --count HEAD -- engine/
and stamps the binary with:
    -X main.Version   = <plugin version>+fork.<N>
    -X main.GitCommit = $(git rev-parse --short HEAD)
    -X main.BuildDate = $(date -u +%Y-%m-%dT%H:%M:%SZ)

The build command is:
    go build -ldflags "-s -w <the three -X above>" \
        -o <repo root>/bin/codecheck[.exe] ./cmd/opencodereview

Environment overrides:
  GOOS, GOARCH   target platform (default: host); ".exe" suffix only on windows
  OUTPUT         explicit output path for the binary

Examples:
  bash engine/scripts/build-fork.sh
  GOOS=linux GOARCH=arm64 bash engine/scripts/build-fork.sh
  OUTPUT=/tmp/codecheck bash engine/scripts/build-fork.sh
EOF
}

case "${1:-}" in
	-h | --help)
		show_help
		exit 0
		;;
	"") ;;
	*)
		echo "unknown argument: $1" >&2
		echo >&2
		show_help >&2
		exit 2
		;;
esac

if ! ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || [ -z "$ROOT" ]; then
	echo "error: not inside a git repository" >&2
	exit 1
fi
ENGINE="$ROOT/engine"
PKG_JSON="$ROOT/package.json"

if [ ! -f "$PKG_JSON" ]; then
	echo "error: $PKG_JSON not found" >&2
	exit 1
fi
if [ ! -d "$ENGINE" ]; then
	echo "error: $ENGINE not found" >&2
	exit 1
fi

# Plugin version -- the only source of truth for the version number.
PLUGIN_VERSION="$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$PKG_JSON" | head -n1)"
if [ -z "$PLUGIN_VERSION" ]; then
	echo "error: could not read \"version\" from $PKG_JSON" >&2
	exit 1
fi

# Engine fork counter: how many commits in this repo touch the engine subtree.
FORK_N="$(git -C "$ROOT" rev-list --no-merges --count HEAD -- engine/)"
if [ -z "$FORK_N" ]; then
	echo "error: could not compute engine fork counter" >&2
	exit 1
fi

BUILD_VERSION="${PLUGIN_VERSION}+fork.${FORK_N}"
GIT_COMMIT="$(git -C "$ROOT" rev-parse --short HEAD)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

TARGET_OS="${GOOS:-$(go env GOOS)}"
TARGET_ARCH="${GOARCH:-$(go env GOARCH)}"
EXT=""
[ "$TARGET_OS" = "windows" ] && EXT=".exe"
OUT="${OUTPUT:-$ROOT/bin/codecheck$EXT}"
mkdir -p "$(dirname "$OUT")"

echo "codecheck engine build"
echo "  plugin version : $PLUGIN_VERSION"
echo "  engine fork N  : $FORK_N"
echo "  stamped version: $BUILD_VERSION"
echo "  commit         : $GIT_COMMIT"
echo "  build date     : $BUILD_DATE"
echo "  target         : $TARGET_OS/$TARGET_ARCH"
echo "  output         : $OUT"
echo

cd "$ENGINE"
go build \
	-ldflags "-s -w -X main.Version=${BUILD_VERSION} -X main.GitCommit=${GIT_COMMIT} -X main.BuildDate=${BUILD_DATE}" \
	-o "$OUT" ./cmd/opencodereview

echo
echo "built $OUT"
echo "verify: \"$OUT\" --version"
