#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# NativeKit — build the iOS PhoneBuddyFFI.xcframework FROM SOURCE.
#
# Why this exists
# ---------------
# The PhoneBuddy engine is the only engine that gives this app OS-level
# background wakes and surfaced messages, but the SDK publishes NO prebuilt iOS
# binary — only Rust source (Apache-2.0). Hiding that behind a download would
# break the project rule "no private/opaque native dependency, always
# rebuildable", so the framework is built here from the pinned public tag:
#
#   github.com/APUS-AI-Lab/PhoneBuddySDK @ v0.2.0
#     ├── cargo rustc -p phone-buddy-ffi --target aarch64-apple-ios     → device slice
#     ├── cargo rustc -p phone-buddy-ffi --target aarch64-apple-ios-sim → simulator slice
#     ├── cbindgen header regenerated from THAT revision (must equal the header
#     │   committed at native/include/phone_buddy.h — otherwise the repo and the
#     │   binary would describe different ABIs and the build fails here)
#     └── xcodebuild -create-xcframework → ios/Frameworks/PhoneBuddyFFI.xcframework
#                    (headers live under Headers/phone_buddy_ffi/ so SwiftPM's
#                    C shim target and the binary always carry the same header)
#
# Must run on macOS (Xcode SDKs + xcodebuild -create-xcframework).
#
# Usage:
#   tools/agent-ffi/build-phonebuddy-ios-xcframework.sh                  # build + install
#   tools/agent-ffi/build-phonebuddy-ios-xcframework.sh --dry-run        # print the plan
#   tools/agent-ffi/build-phonebuddy-ios-xcframework.sh --sim-archs "arm64 x86_64"
#   tools/agent-ffi/build-phonebuddy-ios-xcframework.sh --ref v0.2.0 --src-dir /path/to/sdk
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SDK_URL="https://github.com/APUS-AI-Lab/PhoneBuddySDK.git"
REF="v0.2.0"
CACHE_DIR="${REPO_ROOT}/.ffi-cache"
SRC_DIR=""
PLUGIN_DIR="${REPO_ROOT}/plugins/phonebuddy-agent"
DEST_XCF="${PLUGIN_DIR}/ios/Frameworks/PhoneBuddyFFI.xcframework"
VENDORED_HEADER="${PLUGIN_DIR}/native/include/phone_buddy.h"
DEVICE_TARGET="aarch64-apple-ios"
SIM_TARGETS="aarch64-apple-ios-sim"
MIN_IOS="15.0"
PANIC="unwind"
JOBS=""
DRY_RUN=0
LIB_BASENAME="phone_buddy_ffi"
SO_NAME="lib${LIB_BASENAME}.a"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[1;32mok\033[0m  %s\n' "$*"; }
warn() { printf '  \033[1;33mwarn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)        REF="$2"; shift 2 ;;
    --src-dir)    SRC_DIR="$2"; shift 2 ;;
    --cache-dir)  CACHE_DIR="$2"; shift 2 ;;
    --plugin-dir) PLUGIN_DIR="$2"
                  DEST_XCF="${PLUGIN_DIR}/ios/Frameworks/PhoneBuddyFFI.xcframework"
                  VENDORED_HEADER="${PLUGIN_DIR}/native/include/phone_buddy.h"; shift 2 ;;
    --sim-archs)  case "$2" in
                    arm64)           SIM_TARGETS="aarch64-apple-ios-sim" ;;
                    "arm64 x86_64"|"x86_64 arm64") SIM_TARGETS="aarch64-apple-ios-sim x86_64-apple-ios" ;;
                    x86_64)          SIM_TARGETS="x86_64-apple-ios" ;;
                    *) die "unsupported --sim-archs: $2" ;;
                  esac; shift 2 ;;
    --min-ios)    MIN_IOS="$2"; shift 2 ;;
    --panic)      PANIC="$2"; shift 2 ;;
    --jobs|-j)    JOBS="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -h|--help)    usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

case "$PANIC" in unwind|abort|upstream) ;; *) die "--panic must be unwind, abort or upstream" ;; esac

log "Repo root : $REPO_ROOT"
log "SDK source: ${SRC_DIR:-$CACHE_DIR/PhoneBuddySDK}  (ref ${REF})"
log "Plugin    : $PLUGIN_DIR"
log "xcframework ← $DEST_XCF"
log "device    : $DEVICE_TARGET"
log "simulator : $SIM_TARGETS"

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run — nothing is built. Planned commands:"
  cat <<EOF
  git clone --depth 1 --branch $REF $SDK_URL <cache>
  (cd <sdk> && PB_BUILD_HEADER=1 cargo build -p phone-buddy-ffi)         # cbindgen header
  (cd <sdk> && cargo rustc -p phone-buddy-ffi --release --target $DEVICE_TARGET --crate-type staticlib)
  (cd <sdk> && cargo rustc -p phone-buddy-ffi --release --target $SIM_TARGETS --crate-type staticlib)
  xcodebuild -create-xcframework -library <device .a> -headers <hdrs> \\
                                   -library <sim .a>    -headers <hdrs> \\
                                   -output $DEST_XCF
  # each slice keeps Headers/phone_buddy_ffi/{phone_buddy.h,module.modulemap}
  # the regenerated header must be byte-identical to native/include/phone_buddy.h
EOF
  exit 0
fi

command -v cargo >/dev/null 2>&1 || die "cargo not found (install rustup: https://sh.rustup.rs)"
[[ "$(uname -s)" == "Darwin" ]] || die "this script needs macOS (xcodebuild -create-xcframework)"
command -v xcodebuild >/dev/null 2>&1 || die "xcodebuild not found — install Xcode"
[[ -f "$VENDORED_HEADER" ]] || die "committed header not found: $VENDORED_HEADER"

# ── deployment target ───────────────────────────────────────────────────────
# Without this the C dependencies of the crate are compiled for the SDK default
# and linking into an app that supports iOS 15 fails with
# "object file ... was built for newer 'iOS' version than being linked".
# Keep in sync with Package.swift (.iOS(.v15)).
export IPHONEOS_DEPLOYMENT_TARGET="$MIN_IOS"
log "Deployment target : iOS $MIN_IOS (IPHONEOS_DEPLOYMENT_TARGET)"

# ── SDK source: reuse a vendored checkout when present, else clone ──────────
if [[ -z "$SRC_DIR" ]]; then
  if [[ -d "${REPO_ROOT}/third_party/PhoneBuddySDK/crates/phone-buddy-ffi" ]]; then
    SRC_DIR="${REPO_ROOT}/third_party/PhoneBuddySDK"
    log "Using the SDK source vendored in this repository (offline build)"
  else
    SRC_DIR="${CACHE_DIR}/PhoneBuddySDK"
  fi
fi

if [[ ! -f "$SRC_DIR/crates/phone-buddy-ffi/Cargo.toml" ]]; then
  mkdir -p "$(dirname "$SRC_DIR")"
  if [[ -d "$SRC_DIR/.git" ]]; then
    log "Updating cached SDK checkout ($SRC_DIR)"
    git -C "$SRC_DIR" fetch --depth 1 origin "$REF" >/dev/null 2>&1 || true
    git -C "$SRC_DIR" checkout -q FETCH_HEAD 2>/dev/null || git -C "$SRC_DIR" checkout -q "$REF"
  else
    rm -rf "$SRC_DIR"
    log "Cloning $SDK_URL @ $REF"
    git clone --depth 1 --branch "$REF" "$SDK_URL" "$SRC_DIR" \
      || { warn "tag/branch $REF not directly clonable — falling back to a full clone"; git clone "$SDK_URL" "$SRC_DIR" && git -C "$SRC_DIR" checkout -q "$REF"; }
  fi
fi
[[ -f "$SRC_DIR/crates/phone-buddy-ffi/Cargo.toml" ]] || die "crates/phone-buddy-ffi not found in $SRC_DIR — unexpected SDK layout"
SDK_COMMIT="$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
log "SDK commit : $SDK_COMMIT"

# ── rust targets ────────────────────────────────────────────────────────────
if command -v rustup >/dev/null 2>&1; then
  rustup target add "$DEVICE_TARGET" $SIM_TARGETS
else
  warn "rustup not found — assuming the iOS targets are installed"
fi

[[ -n "$JOBS" ]] && export CARGO_BUILD_JOBS="$JOBS"

case "$PANIC" in
  unwind) PANIC_ARGS=(--config 'profile.release.panic="unwind"') ;;
  abort)  PANIC_ARGS=(--config 'profile.release.panic="abort"') ;;
  upstream) PANIC_ARGS=() ;;
esac

# ── the committed C header must match the crate revision being built ────────
# cbindgen runs as part of the crate's build script (PB_BUILD_HEADER=1), exactly
# like upstream's own scripts/build-ios-sdk.sh does.
log "Regenerating the C header from the crate (cbindgen) …"
( cd "$SRC_DIR" && PB_BUILD_HEADER=1 cargo build -p phone-buddy-ffi --quiet )
GEN_HEADER="$SRC_DIR/crates/phone-buddy-ffi/include/phone_buddy.h"
[[ -f "$GEN_HEADER" ]] || die "PB_BUILD_HEADER=1 produced no header at $GEN_HEADER"
if ! diff -q "$VENDORED_HEADER" "$GEN_HEADER" >/dev/null; then
  warn "regenerated header differs from native/include/phone_buddy.h:"
  diff -u "$VENDORED_HEADER" "$GEN_HEADER" | head -60 || true
  die "the committed header describes a different ABI than the built library — re-vendor the header (see build-phonebuddy-all-abis.sh)"
fi
ok "header matches the committed native/include/phone_buddy.h"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
# Every slice ships the SAME header + module map: Swift and the linked Rust code
# can then never disagree, and the module name is what Swift imports.
HDRS="${STAGE}/headers"
mkdir -p "$HDRS/phone_buddy_ffi"
cp "$VENDORED_HEADER" "$HDRS/phone_buddy_ffi/phone_buddy.h"
cat > "$HDRS/phone_buddy_ffi/module.modulemap" <<'EOF'
module phone_buddy_ffi {
    header "phone_buddy.h"
    export *
}
EOF

# ── compile the Rust library for each iOS target ────────────────────────────
create_args=()
for target in "$DEVICE_TARGET" $SIM_TARGETS; do
  log "Building $target …"
  # staticlib only: a cdylib for iOS drags the whole dependency graph through the
  # linker, and the app links the static archive anyway.
  ( cd "$SRC_DIR" && cargo rustc -p phone-buddy-ffi --release --lib --target "$target" \
      --crate-type staticlib "${PANIC_ARGS[@]}" )
  [[ -f "$SRC_DIR/target/$target/release/$SO_NAME" ]] || die "missing $SRC_DIR/target/$target/release/$SO_NAME"
  ok "$target → $(du -h "$SRC_DIR/target/$target/release/$SO_NAME" | cut -f1)"
  create_args+=( -library "$SRC_DIR/target/$target/release/$SO_NAME" -headers "$HDRS" )
done

# ── assemble the xcframework ────────────────────────────────────────────────
rm -rf "$DEST_XCF"
mkdir -p "$(dirname "$DEST_XCF")"
log "Assembling xcframework …"
xcodebuild -create-xcframework "${create_args[@]}" -output "$DEST_XCF" >/dev/null

# `-create-xcframework` copies the header directory INTO <slice>/Headers. We pass
# a headers dir that already contains the `phone_buddy_ffi/` subdirectory, so the
# published layout (Headers/phone_buddy_ffi/{phone_buddy.h,module.modulemap}) is
# what we expect — if a future Xcode flattens it, re-nest instead of shipping an
# xcframework whose headers nobody can find.
for slice in "$DEST_XCF"/ios-*; do
  [[ -d "$slice/Headers" ]] || continue
  [[ -d "$slice/Headers/phone_buddy_ffi" ]] && continue
  warn "flat headers in $(basename "$slice") — re-nesting under Headers/phone_buddy_ffi/"
  nested="$(mktemp -d)"
  find "$slice/Headers" -mindepth 1 -maxdepth 1 -exec mv {} "$nested"/ \;
  mkdir -p "$slice/Headers/phone_buddy_ffi"
  find "$nested" -mindepth 1 -maxdepth 1 -exec mv {} "$slice/Headers/phone_buddy_ffi"/ \;
  rmdir "$nested" 2>/dev/null || true
done
ok "xcframework → ${DEST_XCF#"$REPO_ROOT"/}"

# ── self-checks: slices, symbols, header ────────────────────────────────────
python3 - "$DEST_XCF" "$MIN_IOS" <<'PY'
import plistlib, pathlib, sys
xcf, min_ios = pathlib.Path(sys.argv[1]), sys.argv[2]
info = plistlib.loads((xcf / 'Info.plist').read_bytes())
ids = sorted(e['LibraryIdentifier'] for e in info['AvailableLibraries'])
print('  slices:', ids)
expected = {'ios-arm64', 'ios-arm64-simulator'}
assert expected.issubset(set(ids)), f'expected {expected}, found {ids}'
# xcodebuild records MinimumOSVersion only for the device slice; the simulator
# entry legitimately has none, so the check is "whatever is declared must match
# the deployment target we compiled for".
for entry in info['AvailableLibraries']:
    declared = entry.get('MinimumOSVersion')
    print(f"  {entry['LibraryIdentifier']}: MinimumOSVersion={declared}")
    if declared is not None:
        assert declared == min_ios, f"slice {entry['LibraryIdentifier']} targets iOS {declared}, expected {min_ios}"
PY

for slice in "$DEST_XCF"/ios-*; do
  [[ -d "$slice" ]] || continue
  lib="$slice/$SO_NAME"
  [[ -f "$lib" ]] || die "slice $(basename "$slice") has no $SO_NAME"
  lipo -info "$lib" 2>/dev/null | sed 's/^/  /' || true
  # The C ABI is what the Swift plugin calls: prove the exported symbols are in
  # the archive rather than trusting that the build succeeded.
  for symbol in _pb_version _pb_engine_new _pb_engine_chat _pb_engine_set_host_callbacks _pb_engine_host_tool_result _pb_engine_free _pb_string_free; do
    if ! nm -g "$lib" 2>/dev/null | grep -q " $symbol\$"; then
      die "slice $(basename "$slice") is missing the exported symbol $symbol"
    fi
  done
  ok "$(basename "$slice"): C ABI symbols present"
  test -f "$slice/Headers/phone_buddy_ffi/phone_buddy.h" || die "slice $(basename "$slice") lost phone_buddy.h"
  test -f "$slice/Headers/phone_buddy_ffi/module.modulemap" || die "slice $(basename "$slice") lost module.modulemap"
  grep -q 'pb_engine_chat_v2' "$slice/Headers/phone_buddy_ffi/phone_buddy.h" \
    || die "slice $(basename "$slice") header does not declare pb_engine_chat_v2"
done

log "Done. Commit the xcframework so the repo stays buildable without a rebuild."
log "SDK commit that produced it: $SDK_COMMIT ($REF)"
