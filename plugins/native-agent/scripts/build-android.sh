#!/bin/bash
# Builds libnative_agent_ffi.so for ALL Android ABIs (arm64-v8a, armeabi-v7a,
# x86, x86_64) so the plugin works on every device class:
#   - arm64-v8a   → modern phones (Play Store requirement)
#   - armeabi-v7a → 32-bit-only phones (still common in budget markets)
#   - x86_64      → emulators on Intel hosts / CI
#   - x86         → legacy 32-bit x86 emulators
#
# arm64-v8a is REQUIRED (the build fails if it doesn't work). The other ABIs
# are best-effort: some Rust dependencies can legitimately fail to build for
# 32-bit targets; in that case the script warns and continues, and the app
# degrades gracefully (checkAvailability() reports the missing ABI at runtime
# instead of crashing).
#
# Lightweight profile: LTO + single codegen unit + symbol stripping + size-
# tuned opt level (override with SIZE_OPT_LEVEL=3 for max performance at the
# cost of a bigger binary).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUST_DIR="$SCRIPT_DIR/../rust/native-agent-ffi"
PLUGIN_DIR="$SCRIPT_DIR/.."

if [ ! -f "$RUST_DIR/Cargo.toml" ]; then
  echo "error: $RUST_DIR/Cargo.toml not found." >&2
  echo "Run: git submodule update --init --recursive" >&2
  exit 1
fi

: "${ANDROID_NDK_HOME:=$HOME/Android/Sdk/ndk/27.0.12077973}"
export ANDROID_NDK_HOME

SIZE_OPT_LEVEL="${SIZE_OPT_LEVEL:-s}"
LIGHT_FLAGS=(
  --config "profile.release.opt-level=${SIZE_OPT_LEVEL}"
  --config "profile.release.lto=thin"
  --config "profile.release.codegen-units=1"
  --config "profile.release.strip=symbols"
)

declare -A TRIPLE=(
  [arm64-v8a]=aarch64-linux-android
  [armeabi-v7a]=armv7-linux-androideabi
  [x86]=i686-linux-android
  [x86_64]=x86_64-linux-android
)

cd "$RUST_DIR"

built=()
failed=()
for ABI in arm64-v8a armeabi-v7a x86_64 x86; do
  echo "==> Building Android $ABI (${TRIPLE[$ABI]})..."
  if cargo ndk -t "$ABI" build --release "${LIGHT_FLAGS[@]}"; then
    mkdir -p "$PLUGIN_DIR/android/src/main/jniLibs/$ABI"
    cp "$RUST_DIR/target/${TRIPLE[$ABI]}/release/libnative_agent_ffi.so" \
      "$PLUGIN_DIR/android/src/main/jniLibs/$ABI/"
    built+=("$ABI")
  else
    if [ "$ABI" = "arm64-v8a" ]; then
      echo "FATAL: arm64-v8a build failed — this ABI is required." >&2
      exit 1
    fi
    echo "WARN: $ABI build failed — skipping (check 32-bit/emulator compatibility of the Rust deps)." >&2
    failed+=("$ABI")
  fi
done

echo "==> Regenerating Kotlin UniFFI bindings..."
cargo build
cargo run --bin uniffi-bindgen -- generate \
  --library "$RUST_DIR/target/debug/libnative_agent_ffi.so" \
  --language kotlin \
  --out-dir "$PLUGIN_DIR/android/src/main/java/"

echo "==> Android build complete."
echo "    built : ${built[*]:-none}"
[ ${#failed[@]} -gt 0 ] && echo "    skipped: ${failed[*]}"
