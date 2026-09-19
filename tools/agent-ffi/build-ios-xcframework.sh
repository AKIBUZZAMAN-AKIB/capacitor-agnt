#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# NativeKit — rebuild the iOS NativeAgentFFI.xcframework FROM SOURCE.
#
# Why this exists
# ---------------
# The prebuilt xcframework that upstream ships with the public v0.5.2 release is
# STALE: its Rust archive, its C header and its Swift bindings were built from an
# older crate revision than the crate source committed at that tag. Symptoms:
#
#   * `NativeAgentPlugin.swift` calls handle methods (seedToolPermissions,
#     setToolPermission, listToolPermissions, resetToolPermissions) that the
#     shipped Swift bindings do not declare  →  the iOS build fails with
#     "value of type 'NativeAgentHandle' has no member 'seedToolPermissions'";
#   * the shipped header declares 49 checksum functions while the crate exports
#     56, so even a "successful" build would abort at runtime on
#     "UniFFI API checksum mismatch".
#
# Generating bindings from a stale binary can never fix this: the binding has to
# be built from the SAME crate revision as the linked Rust code. So this script
# compiles the vendored crate for iOS and regenerates everything:
#
#   vendored crate (plugins/native-agent/rust/native-agent-ffi)
#        ├── cargo build --target aarch64-apple-ios        → device slice
#        ├── cargo build --target aarch64-apple-ios-sim    → simulator slice
#        └── uniffi-bindgen (host dylib)                   → Swift bindings + C header
#
# Outputs (all committed, so the repo stays buildable without any prebuilt blob):
#   plugins/native-agent/ios/Frameworks/NativeAgentFFI.xcframework
#   plugins/native-agent/ios/Sources/NativeAgentPlugin/Generated/native_agent_ffi.swift
#   plugins/native-agent/ios/Sources/NativeAgentPlugin/Generated/native_agent_ffiFFI.h
#   plugins/native-agent/ios/Sources/native_agent_ffiFFI/include/native_agent_ffiFFI.h
#
# Must run on macOS (Xcode's `xcodebuild -create-xcframework` + the iOS SDKs).
#
# Usage:
#   tools/agent-ffi/build-ios-xcframework.sh                 # rebuild + install
#   tools/agent-ffi/build-ios-xcframework.sh --dry-run       # print the plan only
#   tools/agent-ffi/build-ios-xcframework.sh --sim-archs "arm64 x86_64"
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLUGIN_DIR="${REPO_ROOT}/plugins/native-agent"
CRATE_DIR="${PLUGIN_DIR}/rust/native-agent-ffi"
DEST_XCF="${PLUGIN_DIR}/ios/Frameworks/NativeAgentFFI.xcframework"
GENERATED_DIR="${PLUGIN_DIR}/ios/Sources/NativeAgentPlugin/Generated"
SHIM_DIR="${PLUGIN_DIR}/ios/Sources/native_agent_ffiFFI/include"
DEVICE_TARGET="aarch64-apple-ios"
SIM_TARGETS="aarch64-apple-ios-sim"
MIN_IOS="14.0"
DRY_RUN=0

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[1;32mok\033[0m  %s\n' "$*"; }
warn() { printf '  \033[1;33mwarn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --crate-dir)   CRATE_DIR="$2"; shift 2 ;;
    --plugin-dir)  PLUGIN_DIR="$2"; CRATE_DIR="${PLUGIN_DIR}/rust/native-agent-ffi"
                   DEST_XCF="${PLUGIN_DIR}/ios/Frameworks/NativeAgentFFI.xcframework"
                   GENERATED_DIR="${PLUGIN_DIR}/ios/Sources/NativeAgentPlugin/Generated"
                   SHIM_DIR="${PLUGIN_DIR}/ios/Sources/native_agent_ffiFFI/include"; shift 2 ;;
    --device-target) DEVICE_TARGET="$2"; shift 2 ;;
    --sim-archs)   case "$2" in
                     arm64)          SIM_TARGETS="aarch64-apple-ios-sim" ;;
                     "arm64 x86_64") SIM_TARGETS="aarch64-apple-ios-sim x86_64-apple-ios" ;;
                     x86_64)         SIM_TARGETS="x86_64-apple-ios" ;;
                     *) die "unsupported --sim-archs: $2" ;;
                   esac; shift 2 ;;
    --min-ios)     MIN_IOS="$2"; shift 2 ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)     sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

[[ -f "${CRATE_DIR}/Cargo.toml" ]] || die "crate not found: ${CRATE_DIR}/Cargo.toml (vendor it first)"
SO_NAME="libnative_agent_ffi.a"
LIB_BASENAME="native_agent_ffi"

log "Repo root : $REPO_ROOT"
log "Crate     : $CRATE_DIR"
log "xcframework ← $DEST_XCF"
log "device    : $DEVICE_TARGET"
log "simulator : $SIM_TARGETS"

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run — nothing is built. Planned commands:"
  cat <<EOF
  export IPHONEOS_DEPLOYMENT_TARGET=$MIN_IOS            # keeps the C deps in sync with the app
  rustup target add $DEVICE_TARGET $SIM_TARGETS
  (cd $CRATE_DIR && cargo build --release --lib)                       # host dylib for bindgen
  (cd $CRATE_DIR && cargo run --bin uniffi-bindgen -- generate --library target/release/${LIB_BASENAME}.dylib --language swift --out-dir <tmp>)
  (cd $CRATE_DIR && cargo rustc --release --lib --target <each ios target> --crate-type staticlib)
  xcodebuild -create-xcframework -library <device .a> -headers <device headers> \\
                                   -library <sim .a>    -headers <sim headers> \\
                                   -output $DEST_XCF
  cp <tmp>/${LIB_BASENAME}.swift          $GENERATED_DIR/native_agent_ffi.swift
  cp <tmp>/${LIB_BASENAME}FFI.h           $GENERATED_DIR/native_agent_ffiFFI.h
  cp <tmp>/${LIB_BASENAME}FFI.h           $SHIM_DIR/native_agent_ffiFFI.h
EOF
  exit 0
fi

command -v cargo >/dev/null 2>&1 || die "cargo not found (rustup: https://sh.rustup.rs)"
[[ "$(uname -s)" == "Darwin" ]] || die "this script needs macOS (xcodebuild -create-xcframework)"
command -v xcodebuild >/dev/null 2>&1 || die "xcodebuild not found — install Xcode"

# ── deployment target ───────────────────────────────────────────────────────
# Without this the C dependencies (libgit2 via git2, ring, bundled sqlite) are
# compiled for the SDK's default (iOS 17.5), and linking them into an app that
# targets iOS 14 fails with
#   "object file ... was built for newer 'iOS' version (17.5) than being linked (10.0)"
# and unresolved ___chkstk_darwin. Keep it in sync with Package.swift (.iOS(.v14)).
export IPHONEOS_DEPLOYMENT_TARGET="$MIN_IOS"
log "Deployment target : iOS $MIN_IOS (IPHONEOS_DEPLOYMENT_TARGET)"

# ── rust targets ────────────────────────────────────────────────────────────
if command -v rustup >/dev/null 2>&1; then
  rustup target add "$DEVICE_TARGET" $SIM_TARGETS
else
  warn "rustup not found — assuming the iOS targets are installed"
fi

# ── bindings from the crate (host build = fastest, same metadata) ───────────
GEN_DIR="$(mktemp -d)"
log "Generating UniFFI Swift bindings from the vendored crate …"
( cd "$CRATE_DIR" && cargo build --release --lib )
HOST_DYLIB="$(ls "$CRATE_DIR"/target/release/lib${LIB_BASENAME}.dylib 2>/dev/null | head -1 || true)"
[[ -n "$HOST_DYLIB" ]] || die "host dylib not found after build (expected lib${LIB_BASENAME}.dylib)"
( cd "$CRATE_DIR" && cargo run --quiet --bin uniffi-bindgen -- \
    generate --library "$HOST_DYLIB" --language swift --out-dir "$GEN_DIR" )
[[ -f "$GEN_DIR/${LIB_BASENAME}.swift" ]] || die "uniffi-bindgen produced no ${LIB_BASENAME}.swift"
ok "bindings → $GEN_DIR"

# ── compile the Rust library for each iOS target ────────────────────────────
for target in "$DEVICE_TARGET" $SIM_TARGETS; do
  log "Building $target …"
  # staticlib only: the crate also declares `crate-type = ["cdylib", ...]`, and
  # linking a dylib for the iOS targets drags the whole Rust + C dependency set
  # through the linker (that is where ___chkstk_darwin went missing). The app
  # links the static library anyway, so skip the dylib entirely.
  ( cd "$CRATE_DIR" && cargo rustc --release --lib --target "$target" --crate-type staticlib )
  [[ -f "$CRATE_DIR/target/$target/release/$SO_NAME" ]] || die "missing $CRATE_DIR/target/$target/release/$SO_NAME"
  ok "$target → $(du -h "$CRATE_DIR/target/$target/release/$SO_NAME" | cut -f1)"
done

# ── assemble the xcframework (headers travel with each slice) ───────────────
STAGE="$(mktemp -d)"
create_args=()
for target in "$DEVICE_TARGET" $SIM_TARGETS; do
  case "$target" in
    *) hdr="${STAGE}/hdrs-${target}" ;;   # flat staging; normalised after creation
  esac
  mkdir -p "$hdr"
  cp "$GEN_DIR/${LIB_BASENAME}.swift"    "$hdr/"
  cp "$GEN_DIR/${LIB_BASENAME}FFI.h"     "$hdr/"
  cp "$GEN_DIR/${LIB_BASENAME}FFI.modulemap" "$hdr/module.modulemap" 2>/dev/null || true
  create_args+=( -library "$CRATE_DIR/target/$target/release/$SO_NAME" -headers "$hdr" )
done
rm -rf "$DEST_XCF"
log "Assembling xcframework …"
xcodebuild -create-xcframework "${create_args[@]}" -output "$DEST_XCF" >/dev/null

# `-create-xcframework` copies the header directory *flat* into <slice>/Headers.
# The published layout (and the CocoaPods module-map flags) expect
# <slice>/Headers/native_agent_ffi/…, so normalise it instead of letting the
# xcframework layout drift every time it is regenerated.
for slice in "$DEST_XCF"/ios-*; do
  [[ -d "$slice/Headers" ]] || continue
  if [[ ! -d "$slice/Headers/native_agent_ffi" ]]; then
    tmp="$(mktemp -d)"
    mv "$slice/Headers"/* "$tmp"/ 2>/dev/null || true
    mkdir -p "$slice/Headers/native_agent_ffi"
    mv "$tmp"/* "$slice/Headers/native_agent_ffi"/ 2>/dev/null || true
    rmdir "$tmp" 2>/dev/null || true
  fi
done
ok "xcframework → ${DEST_XCF#"$REPO_ROOT/"} (headers under Headers/native_agent_ffi/)"

# ── install the regenerated bindings next to the Swift plugin ───────────────
mkdir -p "$GENERATED_DIR" "$SHIM_DIR"
cp "$GEN_DIR/${LIB_BASENAME}.swift"        "$GENERATED_DIR/native_agent_ffi.swift"
cp "$GEN_DIR/${LIB_BASENAME}FFI.h"         "$GENERATED_DIR/native_agent_ffiFFI.h"
cp "$GEN_DIR/${LIB_BASENAME}FFI.modulemap" "$GENERATED_DIR/native_agent_ffiFFI.modulemap"
# The SwiftPM shim target must expose the very same header the slices were built
# against, or Swift would compile against a different ABI than it links.
cp "$GEN_DIR/${LIB_BASENAME}FFI.h"         "$SHIM_DIR/native_agent_ffiFFI.h"
ok "bindings installed in ${GENERATED_DIR#"$REPO_ROOT/"} and ${SHIM_DIR#"$REPO_ROOT/"}"

# ── the SwiftPM shim target needs its (empty) translation unit ─────────────
# Without a .c file Xcode looks for a <target>.o that is never produced and the
# app build fails with "Build input file cannot be found: native_agent_ffiFFI.o".
SHIM_C="${SHIM_DIR%/include}/shim.c"
if [[ ! -f "$SHIM_C" ]]; then
  warn "creating $SHIM_C (SwiftPM shim targets need one translation unit)"
  printf '// Intentionally empty: this target only exposes the UniFFI C header.\n' > "$SHIM_C"
fi

# ── self-checks: bindings, header and binaries must agree ──────────────────
methods_swift="$(grep -cE '^    public func [a-zA-Z]' "$GENERATED_DIR/native_agent_ffi.swift" || true)"
checksums_header="$(grep -c 'uniffi_native_agent_ffi_checksum_method' "$GENERATED_DIR/native_agent_ffiFFI.h" || true)"
log "Swift methods: ${methods_swift}   header checksum functions: ${checksums_header}"
[[ "$checksums_header" -gt 40 ]] || die "suspiciously few checksum functions in the regenerated header"
grep -q "seedToolPermissions" "$GENERATED_DIR/native_agent_ffi.swift" \
  || die "regenerated bindings still lack seedToolPermissions — wrong crate revision?"
ok "bindings declare the tool-permission APIs the plugin calls"

for slice in "$DEST_XCF"/*; do
  [[ -d "$slice" ]] || continue
  [[ -f "$slice/$SO_NAME" ]] || { warn "slice $(basename "$slice") has no $SO_NAME"; continue; }
  lipo -info "$slice/$SO_NAME" 2>/dev/null | sed 's/^/  /' || true
done

log "Done. Commit the xcframework + Generated/bindings so the repo stays buildable."
