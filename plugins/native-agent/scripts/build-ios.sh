#!/bin/bash
# Build the NativeAgent FFI library for iOS:
#   - aarch64-apple-ios        (device, REQUIRED)
#   - aarch64-apple-ios-sim    (Apple Silicon simulator, REQUIRED)
#   - x86_64-apple-ios-sim     (Intel Mac simulator, OPTIONAL — best-effort)
#
# Lightweight profile: LTO + single codegen unit + size-tuned opt level
# (override with SIZE_OPT_LEVEL=3 for max performance).
#
# Requires macOS + Xcode (iOS staticlibs cannot be cross-compiled from Linux).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUST_DIR="$SCRIPT_DIR/../rust/native-agent-ffi"
PLUGIN_DIR="$SCRIPT_DIR/.."
XCFRAMEWORK_DIR="$PLUGIN_DIR/ios/Frameworks/NativeAgentFFI.xcframework"

if [ ! -f "$RUST_DIR/Cargo.toml" ]; then
  echo "error: $RUST_DIR/Cargo.toml not found." >&2
  echo "Run: git submodule update --init --recursive" >&2
  exit 1
fi

cd "$RUST_DIR"

SIZE_OPT_LEVEL="${SIZE_OPT_LEVEL:-s}"
LIGHT_FLAGS=(
  --config "profile.release.opt-level=${SIZE_OPT_LEVEL}"
  --config "profile.release.lto=thin"
  --config "profile.release.codegen-units=1"
)

echo "==> Building for aarch64-apple-ios (device)..."
# Use --lib --crate-type staticlib to skip cdylib (not supported on iOS)
cargo rustc --release --target aarch64-apple-ios --lib --crate-type staticlib "${LIGHT_FLAGS[@]}" \
  || { echo "FATAL: device build failed." >&2; exit 1; }

echo "==> Building for aarch64-apple-ios-sim (Apple Silicon simulator)..."
cargo rustc --release --target aarch64-apple-ios-sim --lib --crate-type staticlib "${LIGHT_FLAGS[@]}" \
  || { echo "FATAL: Apple Silicon simulator build failed." >&2; exit 1; }

SLICES=(
  "$RUST_DIR/target/aarch64-apple-ios/release/libnative_agent_ffi.a"
  "$RUST_DIR/target/aarch64-apple-ios-sim/release/libnative_agent_ffi.a"
)

echo "==> Building for x86_64-apple-ios-sim (Intel Mac simulator, optional)..."
if cargo rustc --release --target x86_64-apple-ios-sim --lib --crate-type staticlib "${LIGHT_FLAGS[@]}"; then
  SLICES+=("$RUST_DIR/target/x86_64-apple-ios-sim/release/libnative_agent_ffi.a")
  echo "    Intel simulator slice included."
else
  echo "    WARN: x86_64 simulator build failed — continuing without the Intel slice." >&2
fi

echo "==> Generating Swift bindings (UniFFI)..."
# Need debug build for binding generation (release strip removes metadata)
cargo build
cargo run --bin uniffi-bindgen -- generate \
  --library "$RUST_DIR/target/debug/libnative_agent_ffi.dylib" \
  --language swift \
  --out-dir "$PLUGIN_DIR/ios/Sources/NativeAgentPlugin/Generated/"

# Copy generated headers for xcframework (nested subdir avoids modulemap collision)
HEADERS_TMP="$RUST_DIR/target/xcframework-headers"
rm -rf "$HEADERS_TMP"
mkdir -p "$HEADERS_TMP/native_agent_ffi"
cp "$PLUGIN_DIR/ios/Sources/NativeAgentPlugin/Generated/native_agent_ffiFFI.h" "$HEADERS_TMP/native_agent_ffi/"
cat > "$HEADERS_TMP/native_agent_ffi/module.modulemap" << 'EOF'
module native_agent_ffiFFI {
    header "native_agent_ffiFFI.h"
    export *
}
EOF

echo "==> Creating xcframework with ${#SLICES[@]} slice(s)..."
rm -rf "$XCFRAMEWORK_DIR"
XCFW_ARGS=()
for LIB in "${SLICES[@]}"; do
  XCFW_ARGS+=(-library "$LIB" -headers "$HEADERS_TMP")
done
xcodebuild -create-xcframework \
  "${XCFW_ARGS[@]}" \
  -output "$XCFRAMEWORK_DIR" \
  || { echo "FATAL: xcframework assembly failed." >&2; exit 1; }

# NOTE: previously this script also copied the generated .swift into each
# slice's Headers for "IDE use". That duplicated ~250KB of generated code
# into the npm tarball with no functional benefit — removed for lightness.
# (The Swift binding is shipped once under ios/Sources/NativeAgentPlugin/Generated/.)

rm -rf "$HEADERS_TMP"

echo "==> Done!"
ls -lh "$XCFRAMEWORK_DIR/"
