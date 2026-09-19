#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# NativeKit — build libnative_agent_ffi.so for EVERY Android ABI.
#
# Problem this solves
# -------------------
# plugins/native-agent ships a single prebuilt slice:
#     android/src/main/jniLibs/arm64-v8a/libnative_agent_ffi.so
# so every 32-bit phone (armeabi-v7a), every x86/x86_64 emulator and every
# 64-bit emulator reports:
#     checkAvailability() -> { available: false, reason: "... libnative_agent_ffi.so not found" }
#
# This script builds the Rust FFI crate (UniFFI, contract version checked
# against the committed Kotlin bindings) for all four Android ABIs and installs
# each .so into the plugin's jniLibs tree, then verifies the artefacts.
#
# Usage (repo root, after `git submodule`/vendored source is in place)
#   tools/agent-ffi/build-android-all-abis.sh                 # all 4 ABIs, strict
#   tools/agent-ffi/build-android-all-abis.sh --best-effort    # keep going if a 32-bit target fails
#   tools/agent-ffi/build-android-all-abis.sh --abis "arm64-v8a armeabi-v7a"
#   tools/agent-ffi/build-android-all-abis.sh --write-bindings # regenerate UniFFI Kotlin bindings
#   tools/agent-ffi/build-android-all-abis.sh --no-cargo-ndk   # use raw NDK clang wrappers
#
# Requirements: cargo/rustc (rustup recommended), Android NDK r27 (any r2x works),
# python3 (for verification), and either cargo-ndk (cargo install cargo-ndk) or
# --no-cargo-ndk. See tools/agent-ffi/README.bn.md for the full walkthrough.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

PLUGIN_DIR="${REPO_ROOT}/plugins/native-agent"
CRATE_DIR="${PLUGIN_DIR}/rust/native-agent-ffi"
JNI_DIR="${PLUGIN_DIR}/android/src/main/jniLibs"
BINDINGS_DIR="${PLUGIN_DIR}/android/src/main/java"
ABIS="arm64-v8a armeabi-v7a x86_64 x86"
MIN_SDK="24"
BEST_EFFORT=0
USE_CARGO_NDK=1
WRITE_BINDINGS=0
CHECK_BINDINGS=1
JOBS=""
DRY_RUN=0
FEATURES=""
NO_DEFAULT_FEATURES=0
REQUIRE_BINDING_MATCH=0

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[1;32mok\033[0m  %s\n' "$*"; }
warn() { printf '  \033[1;33mwarn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --crate-dir)      CRATE_DIR="$2"; shift 2 ;;
    --plugin-dir)     PLUGIN_DIR="$2"; JNI_DIR="$PLUGIN_DIR/android/src/main/jniLibs"; BINDINGS_DIR="$PLUGIN_DIR/android/src/main/java"; shift 2 ;;
    --abis)           ABIS="$2"; shift 2 ;;
    --min-sdk)        MIN_SDK="$2"; shift 2 ;;
    --jobs|-j)        JOBS="$2"; shift 2 ;;
    --best-effort)    BEST_EFFORT=1; shift ;;
    --no-cargo-ndk)   USE_CARGO_NDK=0; shift ;;
    --write-bindings) WRITE_BINDINGS=1; shift ;;
    --no-binding-check) CHECK_BINDINGS=0; shift ;;
    --require-binding-match) CHECK_BINDINGS=1; REQUIRE_BINDING_MATCH=1; shift ;;
    --features)       FEATURES="$2"; shift 2 ;;
    --no-default-features) NO_DEFAULT_FEATURES=1; shift ;;
    --dry-run)        DRY_RUN=1; shift ;;
    -h|--help)        usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

# ── ABI → target triples ────────────────────────────────────────────────────
triple_for() {
  case "$1" in
    arm64-v8a)   echo "aarch64-linux-android" ;;
    armeabi-v7a) echo "armv7-linux-androideabi" ;;
    x86_64)      echo "x86_64-linux-android" ;;
    x86)         echo "i686-linux-android" ;;
    *) die "unsupported ABI: $1" ;;
  esac
}
# NDK clang wrapper prefix (armv7a-… is the NDK's historical spelling for armv7)
ndk_target_for() {
  case "$1" in
    arm64-v8a)   echo "aarch64-linux-android" ;;
    armeabi-v7a) echo "armv7a-linux-androideabi" ;;
    x86_64)      echo "x86_64-linux-android" ;;
    x86)         echo "i686-linux-android" ;;
    *) die "unsupported ABI: $1" ;;
  esac
}
# cargo/cc env-var suffix (uppercase for cargo, lowercase for the cc crate)
cargo_env_suffix() { triple_for "$1" | tr 'a-z-' 'A-Z_'; }
cc_env_suffix()    { triple_for "$1" | tr '-' '_'; }

# ── NDK discovery ───────────────────────────────────────────────────────────
find_ndk() {
  local candidates=()
  for var in ANDROID_NDK_HOME ANDROID_NDK_ROOT ANDROID_NDK NDK_HOME; do
    local v="${!var:-}"
    [[ -n "$v" && -d "$v" ]] && candidates+=("$v")
  done
  local sdk_roots=("${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" \
                   "$HOME/Android/Sdk" "$HOME/Library/Android/sdk" \
                   "/usr/lib/android-sdk" "/opt/android-sdk" \
                   "${PREFIX:-}/lib/android-sdk" "${PREFIX:-}/opt/android-sdk")
  for root in "${sdk_roots[@]}"; do
    [[ -n "$root" && -d "$root/ndk" ]] || continue
    while IFS= read -r d; do candidates+=("$d"); done < <(find "$root/ndk" -maxdepth 1 -mindepth 1 -type d | sort -V)
  done
  [[ ${#candidates[@]} -gt 0 ]] || return 1
  # Prefer r27 (what the shipped arm64 slice was built with), else newest.
  local r27
  r27="$(printf '%s\n' "${candidates[@]}" | grep -E '/27\.' | tail -n1 || true)"
  if [[ -n "$r27" ]]; then printf '%s\n' "$r27"; else printf '%s\n' "${candidates[@]}" | tail -n1; fi
}

[[ -f "$CRATE_DIR/Cargo.toml" ]] || die "$CRATE_DIR/Cargo.toml not found.
The Rust FFI crate is NOT in this repository (only a prebuilt arm64-v8a .so is).
Ask the upstream author for the crate, or vendor an existing checkout with:
    tools/agent-ffi/vendor-ffi-source.sh --from-dir /path/to/native-agent-ffi
Upstream (private): https://gitlab.k8s.t6x.io/rruiz/native-agent-ffi"

command -v cargo >/dev/null 2>&1 || die "cargo not found. Install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
command -v python3 >/dev/null 2>&1 || die "python3 not found (needed for artefact verification)."

NDK_DIR="${ANDROID_NDK_HOME:-}"
if [[ -z "$NDK_DIR" || ! -d "$NDK_DIR" ]]; then
  NDK_DIR="$(find_ndk || true)"
fi
[[ -n "$NDK_DIR" && -d "$NDK_DIR" ]] || die "Android NDK not found. Set ANDROID_NDK_HOME=/path/to/ndk (r27 recommended) or install it via sdkmanager 'ndk;27.0.12077973'."
NDK_DIR="$(cd "$NDK_DIR" && pwd)"
export ANDROID_NDK_HOME="$NDK_DIR"
export ANDROID_NDK_ROOT="$NDK_DIR"
TOOLCHAIN="${NDK_DIR}/toolchains/llvm/prebuilt"
HOST_TAG="$(ls "$TOOLCHAIN" 2>/dev/null | head -n1 || true)"
[[ -n "$HOST_TAG" ]] || die "NDK toolchain not found under $TOOLCHAIN"
BIN_DIR="${TOOLCHAIN}/${HOST_TAG}/bin"

log "Repo root : $REPO_ROOT"
log "NDK       : $NDK_DIR (host tag: $HOST_TAG)"
log "Crate     : $CRATE_DIR"
log "jniLibs   : $JNI_DIR"


# ── crate identity (matters: a mismatch here means a broken APK) ────────────
crate_version="$(awk -F'"' '/^[ \t]*version[ \t]*=/{print $2; exit}' "$CRATE_DIR/Cargo.toml")"
log "Crate      : $(basename "$CRATE_DIR") ${crate_version:-?}"
grep -E '^[ \t]*uniffi[ \t]*=' "$CRATE_DIR/Cargo.toml" | head -1 | sed 's/^/  /' || true

# ── library name from the crate manifest ────────────────────────────────────
SO_NAME="libnative_agent_ffi.so"
if grep -qE '^[ \t]*\[lib\]' "$CRATE_DIR/Cargo.toml"; then
  libname="$(awk '/^[ \t]*\[lib\]/{f=1;next} /^[ \t]*\[/{f=0} f && /^[ \t]*name[ \t]*=/{gsub(/[" ]/,"",$0); sub(/^name=/,"",$0); print; exit}' "$CRATE_DIR/Cargo.toml")"
  [[ -n "${libname:-}" ]] && SO_NAME="lib${libname}.so"
fi
log "Shared lib: $SO_NAME"

# ── rustup targets ──────────────────────────────────────────────────────────
if command -v rustup >/dev/null 2>&1; then
  for abi in $ABIS; do
    t="$(triple_for "$abi")"
    if ! rustup target list --installed 2>/dev/null | grep -qx "$t"; then
      log "Adding rust target $t"
      rustup target add "$t" || warn "could not add target $t"
    fi
  done
else
  warn "rustup not found — make sure the four Android targets are available in this toolchain."
fi

# ── cargo-ndk ───────────────────────────────────────────────────────────────
CARGO_NDK=0
if [[ "$USE_CARGO_NDK" == "1" ]]; then
  if cargo ndk --version >/dev/null 2>&1; then
    CARGO_NDK=1
    ok "cargo-ndk $(cargo ndk --version 2>/dev/null | awk '{print $2}')"
  else
    warn "cargo-ndk not installed — falling back to raw NDK clang wrappers."
    warn "  (install it for the nicest experience: cargo install cargo-ndk --locked)"
  fi
fi

[[ "$DRY_RUN" == "1" ]] && { log "dry run — nothing is built."; exit 0; }

# ── release profile: small, LTO'd, stripped (matches the shipped arm64 slice) ─
# NOTE: never add panic=abort here. UniFFI converts Rust panics into JS
# exceptions with catch_unwind; abort would turn a panic into a process kill.
export CARGO_PROFILE_RELEASE_OPT_LEVEL="${CARGO_PROFILE_RELEASE_OPT_LEVEL:-s}"
export CARGO_PROFILE_RELEASE_LTO="${CARGO_PROFILE_RELEASE_LTO:-thin}"
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${CARGO_PROFILE_RELEASE_CODEGEN_UNITS:-1}"
export CARGO_PROFILE_RELEASE_STRIP="${CARGO_PROFILE_RELEASE_STRIP:-symbols}"
export CARGO_PROFILE_RELEASE_DEBUG="${CARGO_PROFILE_RELEASE_DEBUG:-false}"
[[ -n "$JOBS" ]] && export CARGO_BUILD_JOBS="$JOBS"

# Extra cargo flags (feature control matters for 32-bit builds: e.g. dropping an
# optional C dependency that has no armv7 support).
CARGO_FEATURE_ARGS=()
[[ "$NO_DEFAULT_FEATURES" == "1" ]] && CARGO_FEATURE_ARGS+=(--no-default-features)
[[ -n "$FEATURES" ]] && CARGO_FEATURE_ARGS+=(--features "$FEATURES")
[[ ${#CARGO_FEATURE_ARGS[@]} -gt 0 ]] && log "cargo flags : ${CARGO_FEATURE_ARGS[*]}"

build_with_cargo_ndk() {           # $1 = abi
  ( cd "$CRATE_DIR" && cargo ndk --platform "$MIN_SDK" -t "$1" build --release "${CARGO_FEATURE_ARGS[@]}" )
}

build_with_raw_ndk() {             # $1 = abi
  local abi="$1" triple ndk_target cc ar ranlib up low
  triple="$(triple_for "$abi")"
  ndk_target="$(ndk_target_for "$abi")"
  cc="${BIN_DIR}/${ndk_target}${MIN_SDK}-clang"
  ar="${BIN_DIR}/llvm-ar"
  ranlib="${BIN_DIR}/llvm-ranlib"
  [[ -x "$cc" ]] || die "NDK compiler not found: $cc"
  up="$(cargo_env_suffix "$abi")"
  low="$(cc_env_suffix "$abi")"
  (
    cd "$CRATE_DIR"
    export "CARGO_TARGET_${up}_LINKER=$cc"
    export "CC_${low}=$cc"
    export "AR_${low}=$ar"
    export "RANLIB_${low}=$ranlib"
    export "CFLAGS_${low}=--target=${ndk_target}${MIN_SDK}"
    cargo build --release --target "$triple" "${CARGO_FEATURE_ARGS[@]}"
  )
}

export CFLAGS CXXFLAGS  # intentionally empty; the raw path sets per-target CFLAGS

built=(); failed=(); manifest_rows=()

for abi in $ABIS; do
  triple="$(triple_for "$abi")"
  log "Building $abi ($triple) …"
  start=$SECONDS
  if [[ "$CARGO_NDK" == "1" ]]; then
    if ! build_with_cargo_ndk "$abi"; then
      if [[ "$abi" == "arm64-v8a" || "$BEST_EFFORT" == "0" ]]; then
        die "[$abi] build failed (arm64-v8a is mandatory; other ABIs only continue with --best-effort)."
      fi
      warn "[$abi] build failed — skipping. Devices with this ABI will keep reporting available:false."
      failed+=("$abi"); continue
    fi
  else
    if ! build_with_raw_ndk "$abi"; then
      if [[ "$abi" == "arm64-v8a" || "$BEST_EFFORT" == "0" ]]; then
        die "[$abi] build failed (raw NDK path)."
      fi
      warn "[$abi] build failed — skipping."
      failed+=("$abi"); continue
    fi
  fi

  out_so="${CRATE_DIR}/target/${triple}/release/${SO_NAME}"
  [[ -f "$out_so" ]] || die "[$abi] expected artefact missing: $out_so"
  mkdir -p "${JNI_DIR}/${abi}"
  cp "$out_so" "${JNI_DIR}/${abi}/${SO_NAME}"
  ok "[$abi] built in $((SECONDS - start))s → jniLibs/${abi}/${SO_NAME} ($(du -h "${JNI_DIR}/${abi}/${SO_NAME}" | cut -f1))"

  # ── verify the artefact really is what this ABI needs ─────────────────────
  align_args=()
  if [[ "$abi" == "arm64-v8a" ]]; then
    align_args+=(--require-page-align 16384)   # Android 15+ 16 KB page devices
  fi
  sym_args=(
    --require-symbol ffi_native_agent_ffi_uniffi_contract_version
    --require-symbol uniffi_native_agent_ffi_checksum_func_init_workspace
    --require-symbol uniffi_native_agent_ffi_checksum_method_nativeagenthandle_abort
  )
  if python3 "$SCRIPT_DIR/elfcheck.py" --expect-abi "$abi" "${align_args[@]}" "${sym_args[@]}" \
        "${JNI_DIR}/${abi}/${SO_NAME}"; then
    ok "[$abi] ELF verified (correct machine, UniFFI symbols exported)"
  else
    die "[$abi] verification failed — refusing to ship a broken slice."
  fi

  built+=("$abi")
  manifest_rows+=("$abi")
done

# ── UniFFI Kotlin bindings: catch contract drift before it hits a device ────
contract_version="$(grep -oE 'val bindings_contract_version = [0-9]+' \
  "${BINDINGS_DIR}/uniffi/native_agent_ffi/native_agent_ffi.kt" 2>/dev/null | grep -oE '[0-9]+' || true)"
[[ -n "$contract_version" ]] && log "Committed Kotlin bindings expect UniFFI contract version $contract_version"

if [[ "$CHECK_BINDINGS" == "1" || "$WRITE_BINDINGS" == "1" ]]; then
  tmp_bind="$(mktemp -d)"
  log "Generating UniFFI Kotlin bindings into $tmp_bind (for drift check)…"
  gen_ok=0
  if ( cd "$CRATE_DIR" && cargo run --quiet --bin uniffi-bindgen -- generate \
        --library "${CRATE_DIR}/target/$(triple_for "${built[0]}")/release/${SO_NAME}" \
        --language kotlin --out-dir "$tmp_bind" ) >/dev/null 2>&1; then
    gen_ok=1
  elif command -v uniffi-bindgen >/dev/null 2>&1 && uniffi-bindgen generate \
        --library "${CRATE_DIR}/target/$(triple_for "${built[0]}")/release/${SO_NAME}" \
        --language kotlin --out-dir "$tmp_bind" >/dev/null 2>&1; then
    gen_ok=1
  fi

  if [[ "$gen_ok" == "1" ]]; then
    new_kt="$(find "$tmp_bind" -name 'native_agent_ffi.kt' | head -n1 || true)"
    cur_kt="${BINDINGS_DIR}/uniffi/native_agent_ffi/native_agent_ffi.kt"
    if [[ -n "$new_kt" && -f "$cur_kt" ]]; then
      if diff -q "$new_kt" "$cur_kt" >/dev/null; then
        ok "Kotlin bindings match the freshly built library (no contract drift)"
      else
        new_ver="$(grep -oE 'bindings_contract_version = [0-9]+' "$new_kt" | grep -oE '[0-9]+' | head -n1 || true)"
        warn "Generated bindings DIFFER from the committed ones."
        warn "  committed contract version: ${contract_version:-unknown} / rebuilt: ${new_ver:-unknown}"
        if [[ "$WRITE_BINDINGS" == "1" ]]; then
          cp "$new_kt" "$cur_kt"
          ok "Overwrote ${cur_kt} with the regenerated bindings (commit this file!)."
          warn "Remember to rebuild/propagate anything that mirrors this binding (dist/, TS types)."
        elif [[ "$WRITE_BINDINGS" == "1" ]]; then
          cp "$new_kt" "$cur_kt"
          ok "Overwrote ${cur_kt}"
        elif [[ "$REQUIRE_BINDING_MATCH" == "1" ]]; then
          die "generated UniFFI bindings do NOT match the committed ones
       committed contract version: ${contract_version:-unknown} / rebuilt: ${new_ver:-unknown}
       Shipping these slices would make the app throw 'UniFFI contract/API checksum mismatch'
       at runtime. Either pin your source to the version the plugin was written against,
       re-run with --write-bindings (and update the plugin code + dist/), or pass
       --no-binding-check for an investigation-only build."
        else
          warn "  If the Rust API really changed, re-run with --write-bindings and commit the result."
          warn "  Otherwise a device will throw: 'UniFFI contract/API checksum mismatch'."
        fi
      fi
    fi
  else
    warn "uniffi-bindgen could not run (no bin target in the crate or not installed) — skipping the drift check."
  fi
  rm -rf "$tmp_bind"
fi

# ── manifest for the shipped slices ─────────────────────────────────────────
python3 - "$JNI_DIR" "${built[@]}" <<'PY'
import hashlib, json, os, subprocess, sys, datetime
jni = sys.argv[1]
abis = sys.argv[2:]
def sh(*a):
    try: return subprocess.check_output(a, text=True).strip()
    except Exception: return None
manifest = {
    "generatedAt": datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "crate": "native-agent-ffi (UniFFI, Kotlin bindings in android/src/main/java/uniffi/)",
    "cargo": sh("cargo", "--version"),
    "rustc": sh("rustc", "--version"),
    "ndk": os.environ.get("ANDROID_NDK_HOME"),
    "abis": {},
}
for abi in abis:
    so = os.path.join(jni, abi, "libnative_agent_ffi.so")
    if not os.path.isfile(so):
        continue
    h = hashlib.sha256()
    with open(so, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    manifest["abis"][abi] = {"sha256": h.hexdigest(), "bytes": os.path.getsize(so)}
path = os.path.join(jni, "abi-manifest.json")
with open(path, "w") as fh:
    json.dump(manifest, fh, indent=2)
    fh.write("\n")
print(f"  ok  manifest → {path} ({len(manifest['abis'])} ABI slices)")
PY

# ── summary ─────────────────────────────────────────────────────────────────
echo
log "Build summary"
printf '  built   : %s\n' "${built[*]:-none}"
[[ ${#failed[@]} -gt 0 ]] && printf '  skipped : %s\n' "${failed[*]}"
printf '  jniLibs : %s\n' "$JNI_DIR"
echo
if [[ ${#failed[@]} -gt 0 ]]; then
  warn "Some ABIs were skipped: devices on those ABIs will report available:false (no crash)."
  warn "Re-run without --best-effort, or investigate the failing dependency's 32-bit support."
fi
log "Next: tools/agent-ffi/verify-abis.sh --strict  •  npm run android:debug"
