#!/bin/bash
# Build the NativeAgent FFI library for iOS (device + simulator)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUST_DIR="$SCRIPT_DIR/../rust/native-agent-ffi"
PLUGIN_DIR="$SCRIPT_DIR/.."
XCFRAMEWORK_DIR="$PLUGIN_DIR/ios/Frameworks/NativeAgentFFI.xcframework"

cd "$RUST_DIR"

echo "==> Building for aarch64-apple-ios (device)..."
# Use --lib --crate-type staticlib to skip cdylib (not supported on iOS)
cargo rustc --release --target aarch64-apple-ios --lib --crate-type staticlib

echo "==> Building for aarch64-apple-ios-sim (Apple Silicon simulator)..."
cargo rustc --release --target aarch64-apple-ios-sim --lib --crate-type staticlib

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

echo "==> Creating xcframework..."
rm -rf "$XCFRAMEWORK_DIR"
xcodebuild -create-xcframework \
  -library "$RUST_DIR/target/aarch64-apple-ios/release/libnative_agent_ffi.a" \
  -headers "$HEADERS_TMP" \
  -library "$RUST_DIR/target/aarch64-apple-ios-sim/release/libnative_agent_ffi.a" \
  -headers "$HEADERS_TMP" \
  -output "$XCFRAMEWORK_DIR"

# Copy the Swift binding into each slice's Headers subdirectory (for documentation/IDE use)
for SLICE in ios-arm64 ios-arm64-simulator; do
  if [ -d "$XCFRAMEWORK_DIR/$SLICE/Headers/native_agent_ffi" ]; then
    cp "$PLUGIN_DIR/ios/Sources/NativeAgentPlugin/Generated/native_agent_ffi.swift" \
      "$XCFRAMEWORK_DIR/$SLICE/Headers/native_agent_ffi/"
  fi
done

rm -rf "$HEADERS_TMP"

echo "==> Done!"
ls -lh "$XCFRAMEWORK_DIR/"
