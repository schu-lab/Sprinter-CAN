#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT/runtime"
PYTHON_DIR="$RUNTIME_DIR/python"
ARCHIVE="$RUNTIME_DIR/python-arm64.tar.gz"
PYTHON_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20260623/cpython-3.12.13%2B20260623-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz"
PYTHON_SHA256="b85154b9c7ca9de3f85f2c9f032d503151db16ef198de86b885fc61890c075ed"

if [[ -x "$PYTHON_DIR/bin/python3" ]]; then
  echo "Reusing bundled ARM64 Python runtime in $PYTHON_DIR"
  exit 0
fi

rm -rf "$PYTHON_DIR"
mkdir -p "$RUNTIME_DIR"

if command -v curl >/dev/null 2>&1; then
  curl -fL "$PYTHON_URL" -o "$ARCHIVE"
elif command -v wget >/dev/null 2>&1; then
  wget -O "$ARCHIVE" "$PYTHON_URL"
else
  echo "curl or wget is required to download the ARM64 Python runtime." >&2
  exit 1
fi

echo "$PYTHON_SHA256  $ARCHIVE" | sha256sum --check -
tar -xzf "$ARCHIVE" -C "$RUNTIME_DIR"
rm -f "$ARCHIVE"
test -x "$PYTHON_DIR/bin/python3"
echo "Bundled ARM64 Python 3.12 runtime in $PYTHON_DIR"
