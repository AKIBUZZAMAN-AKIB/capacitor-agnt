#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# NativeKit — verify which Android ABIs actually carry the native agent engine.
#
#   tools/agent-ffi/verify-abis.sh                     # scan source jniLibs trees
#   tools/agent-ffi/verify-abis.sh --strict            # fail if any ABI is partial
#   tools/agent-ffi/verify-abis.sh --apk android/app/build/outputs/apk/debug/app-debug.apk
#   tools/agent-ffi/verify-abis.sh --aab android/app/build/outputs/bundle/release/app-release.aab
#
# This is the check that would have caught "only arm64-v8a ships" before a
# 32-bit phone ever tried to load the library.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v python3 >/dev/null 2>&1 || { echo "error: python3 not found." >&2; exit 2; }

# Convenience: allow `verify-abis.sh app-release.apk` / `... app-release.aab`.
if [[ $# -ge 1 && "$1" != -* ]]; then
  case "${1,,}" in
    *.apk) set -- --apk "$@" ;;
    *.aab) set -- --aab "$@" ;;
    *)     set -- --jni "$@" ;;
  esac
fi

exec python3 "$SCRIPT_DIR/verify_abis.py" "$@"
