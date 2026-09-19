#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build libphone_buddy_ffi.so (PhoneBuddy SDK — Apache-2.0, public) for EVERY
# Android ABI, and install the slices into the Capacitor plugin's jniLibs.
#
# Why this replaces the old road:
#   capacitor-native-agent  -> crate behind a PRIVATE GitLab, no source in repo,
#                              only an arm64-v8a .so shipped  -> 32-bit dead end
#   PhoneBuddy SDK          -> PUBLIC Apache-2.0 source, rust-toolchain.toml
#                              already lists armv7-linux-androideabi, upstream
#                              build script supports `--all`
#                              -> every ABI can be built by anyone, forever.
#
# Usage
#   tools/agent-ffi/build-phonebuddy-all-abis.sh                 # tag v0.2.0, 4 ABIs
#   tools/agent-ffi/build-phonebuddy-all-abis.sh --ref main      # latest main
#   tools/agent-ffi/build-phonebuddy-all-abis.sh --src-dir ~/PhoneBuddySDK
#   tools/agent-ffi/build-phonebuddy-all-abis.sh --vendor        # also keep the SDK source in-repo
#   tools/agent-ffi/build-phonebuddy-all-abis.sh --best-effort   # 32-bit/x86 failures don't stop arm64
#
# Requirements: rustup + cargo, Android NDK r27 (or r26+), python3.
# The upstream workspace pins Rust 1.94 (rust-toolchain.toml) and sets
# `sccache` as rustc-wrapper, so this script shims sccache when it is absent.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SDK_URL="https://github.com/APUS-AI-Lab/PhoneBuddySDK.git"
REF="v0.2.0"
CACHE_DIR="${REPO_ROOT}/.ffi-cache"
SRC_DIR=""
DEST="${REPO_ROOT}/plugins/phonebuddy-agent/android/src/main/jniLibs"
ABIS="arm64-v8a armeabi-v7a x86_64 x86"
MIN_SDK="24"
PANIC="unwind"
BEST_EFFORT=0
VENDOR=0
JOBS=""
DRY_RUN=0
SO_NAME="libphone_buddy_ffi.so"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[1;32mok\033[0m  %s\n' "$*"; }
warn() { printf '  \033[1;33mwarn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)        REF="$2"; shift 2 ;;
    --src-dir)    SRC_DIR="$2"; shift 2 ;;
    --dest)       DEST="$2"; shift 2 ;;
    --abis)       ABIS="$2"; shift 2 ;;
    --min-sdk)    MIN_SDK="$2"; shift 2 ;;
    --panic)      PANIC="$2"; shift 2 ;;
    --cache-dir)  CACHE_DIR="$2"; shift 2 ;;
    --jobs|-j)    JOBS="$2"; shift 2 ;;
    --best-effort) BEST_EFFORT=1; shift ;;
    --vendor)     VENDOR=1; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -h|--help)    usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

case "$PANIC" in unwind|abort|upstream) ;; *) die "--panic must be unwind, abort or upstream" ;; esac

triple_for() {
  case "$1" in
    arm64-v8a)   echo "aarch64-linux-android" ;;
    armeabi-v7a) echo "armv7-linux-androideabi" ;;
    x86_64)      echo "x86_64-linux-android" ;;
    x86)         echo "i686-linux-android" ;;
    *) die "unsupported ABI: $1" ;;
  esac
}
ndk_clang_for() {
  case "$1" in
    arm64-v8a)   echo "aarch64-linux-android" ;;
    armeabi-v7a) echo "armv7a-linux-androideabi" ;;
    x86_64)      echo "x86_64-linux-android" ;;
    x86)         echo "i686-linux-android" ;;
    *) die "unsupported ABI: $1" ;;
  esac
}
env_suffix() { triple_for "$1" | tr 'a-z-' 'A-Z_'; }


if [[ "$DRY_RUN" == "1" ]]; then
  echo "dry run — nothing will be cloned or built:"
  echo "  source    : $SDK_URL @ $REF"
  echo "  cache dir : ${SRC_DIR:-$CACHE_DIR/PhoneBuddySDK}"
  echo "  abis      : $ABIS   (minSdk $MIN_SDK, panic mode: $PANIC)"
  echo "  dest      : $DEST"
  echo "  steps     : clone -> cargo build -p phone-buddy-ffi --release per ABI -> elfcheck -> abi-manifest.json"
  exit 0
fi

# ── toolchain checks ────────────────────────────────────────────────────────
command -v cargo >/dev/null 2>&1 || die "cargo not found. Install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
command -v git   >/dev/null 2>&1 || die "git not found (needed to fetch the public SDK)."
command -v python3 >/dev/null 2>&1 || die "python3 not found (needed for verification)."

find_ndk() {
  local candidates=()
  for var in ANDROID_NDK_HOME ANDROID_NDK_ROOT ANDROID_NDK NDK_HOME; do
    local v="${!var:-}"; [[ -n "$v" && -d "$v" ]] && candidates+=("$v")
  done
  for root in "${ANDROID_HOME:-}" "${ANDROID_SDK_ROOT:-}" "$HOME/Android/Sdk" \
              "$HOME/Library/Android/sdk" /usr/lib/android-sdk /opt/android-sdk \
              "${PREFIX:-}/lib/android-sdk"; do
    [[ -n "$root" && -d "$root/ndk" ]] || continue
    while IFS= read -r d; do candidates+=("$d"); done < <(find "$root/ndk" -maxdepth 1 -mindepth 1 -type d | sort -V)
  done
  [[ ${#candidates[@]} -gt 0 ]] || return 1
  local r27; r27="$(printf '%s\n' "${candidates[@]}" | grep -E '/27\.' | tail -n1 || true)"
  if [[ -n "$r27" ]]; then printf '%s\n' "$r27"; else printf '%s\n' "${candidates[@]}" | tail -n1; fi
}
NDK_DIR="${ANDROID_NDK_HOME:-}"
[[ -n "$NDK_DIR" && -d "$NDK_DIR" ]] || NDK_DIR="$(find_ndk || true)"
[[ -n "$NDK_DIR" && -d "$NDK_DIR" ]] || die "Android NDK not found. Set ANDROID_NDK_HOME or install 'ndk;27.0.12077973' via sdkmanager."
export ANDROID_NDK_HOME="$NDK_DIR" ANDROID_NDK_ROOT="$NDK_DIR"
NDK_BIN="$NDK_DIR/toolchains/llvm/prebuilt/linux-x86_64/bin"
[[ -d "$NDK_BIN" ]] || NDK_BIN="$NDK_DIR/toolchains/llvm/prebuilt/$(ls "$NDK_DIR/toolchains/llvm/prebuilt" | head -n1)/bin"
[[ -d "$NDK_BIN" ]] || die "NDK toolchain bin not found under $NDK_DIR"
export PATH="$NDK_BIN:$PATH"

log "NDK       : $NDK_DIR"
log "SDK ref   : $REF"

# ── fetch the (public) SDK source ───────────────────────────────────────────
if [[ -n "$SRC_DIR" ]]; then
  [[ -f "$SRC_DIR/Cargo.toml" ]] || die "$SRC_DIR/Cargo.toml not found — not a PhoneBuddy SDK checkout."
  log "Using existing checkout: $SRC_DIR"
else
  mkdir -p "$CACHE_DIR"
  SRC_DIR="${CACHE_DIR}/PhoneBuddySDK"
  if [[ -d "$SRC_DIR/.git" ]]; then
    log "Updating cached SDK checkout ($SRC_DIR)"
    git -C "$SRC_DIR" fetch --depth 1 origin "$REF" >/dev/null 2>&1 || true
    git -C "$SRC_DIR" checkout -q FETCH_HEAD 2>/dev/null || git -C "$SRC_DIR" checkout -q "$REF" 2>/dev/null || true
  else
    log "Cloning $SDK_URL @ $REF"
    rm -rf "$SRC_DIR"
    git clone --depth 1 --branch "$REF" "$SDK_URL" "$SRC_DIR" \
      || { warn "branch/tag $REF not directly clonable — falling back to full clone"; git clone "$SDK_URL" "$SRC_DIR" && git -C "$SRC_DIR" checkout -q "$REF"; }
  fi
fi
SDK_COMMIT="$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
log "SDK source: $SRC_DIR ($SDK_COMMIT)"
grep -q 'armv7-linux-androideabi' "$SRC_DIR/rust-toolchain.toml" 2>/dev/null \
  && ok "upstream rust-toolchain.toml lists armv7-linux-androideabi (32-bit ARM is a supported target)"
grep -Rq 'name *= *"phone-buddy-ffi"' "$SRC_DIR/crates/phone-buddy-ffi/Cargo.toml" 2>/dev/null \
  || die "crates/phone-buddy-ffi not found — unexpected SDK layout."


# ── rust targets ────────────────────────────────────────────────────────────
if command -v rustup >/dev/null 2>&1; then
  for abi in $ABIS; do
    t="$(triple_for "$abi")"
    rustup target list --installed 2>/dev/null | grep -qx "$t" || { log "Adding rust target $t"; rustup target add "$t" || warn "could not add $t"; }
  done
fi

# ── sccache shim (upstream .cargo/config.toml sets rustc-wrapper = "sccache") ─
if ! command -v sccache >/dev/null 2>&1; then
  shim_dir="$(mktemp -d)"
  printf '#!/bin/sh\nexec "$@"\n' > "$shim_dir/sccache"
  chmod +x "$shim_dir/sccache"
  export PATH="$shim_dir:$PATH"
  warn "sccache not installed — using a transparent shim (upstream config requires the wrapper)."
fi

# ── build each ABI ──────────────────────────────────────────────────────────
[[ -n "$JOBS" ]] && export CARGO_BUILD_JOBS="$JOBS"
built=(); failed=()

for abi in $ABIS; do
  triple="$(triple_for "$abi")"
  cc="${NDK_BIN}/$(ndk_clang_for "$abi")${MIN_SDK}-clang"
  [[ -x "$cc" ]] || die "NDK compiler missing: $cc"
  up="$(env_suffix "$abi")"
  log "Building $abi ($triple) …"
  start=$SECONDS

  cargo_args=(build -p phone-buddy-ffi --target "$triple" --release)

  # Android 15+ devices can use 16 KB memory pages; Play requires new binaries to
  # be aligned for them. The NDK's own clang does this by default, but this crate
  # ships its own linker configuration, so make it explicit (64-bit only — 32-bit
  # ABIs keep 4 KB pages).
  extra_rustflags=""
  if [[ "$abi" == "arm64-v8a" || "$abi" == "x86_64" ]]; then
    extra_rustflags="-C link-arg=-Wl,-z,max-page-size=16384"
  fi
  case "$PANIC" in
    unwind) cargo_args+=(--config 'profile.release.panic="unwind"') ;;
    abort)  cargo_args+=(--config 'profile.release.panic="abort"') ;;
    upstream) : ;;   # keep upstream's own profile (panic = "abort")
  esac

  # NOTE: the toolchain variables must be exported with a QUOTED name.
  # `CARGO_TARGET_${up}_LINKER="$cc" cargo ...` does NOT work: bash decides
  # whether a word is an assignment at parse time, so a name containing an
  # expansion is not recognised as one and the whole word is executed as a
  # command ("CARGO_TARGET_..._LINKER=/path/clang: No such file or directory",
  # exit 126/127 in CI). Quoted `export "NAME=$value"` is not affected.
  if (
    cd "$SRC_DIR"
    [[ -n "$extra_rustflags" ]] && export RUSTFLAGS="${RUSTFLAGS:-} $extra_rustflags"
    export "CARGO_TARGET_${up}_LINKER=$cc"
    export "CC_$(printf '%s' "$triple" | tr '-' '_')=$cc"
    export "AR_$(printf '%s' "$triple" | tr '-' '_')=$NDK_BIN/llvm-ar"
    cargo "${cargo_args[@]}"
  ); then
    out="${SRC_DIR}/target/${triple}/release/${SO_NAME}"
    [[ -f "$out" ]] || die "[$abi] expected artefact missing: $out"
    mkdir -p "${DEST}/${abi}"
    cp "$out" "${DEST}/${abi}/${SO_NAME}"
    ok "[$abi] built in $((SECONDS - start))s → ${DEST#"$REPO_ROOT/"}/${abi}/${SO_NAME} ($(du -h "${DEST}/${abi}/${SO_NAME}" | cut -f1))"
  else
    if [[ "$abi" == "arm64-v8a" || "$BEST_EFFORT" == "0" ]]; then
      die "[$abi] build failed. Re-run with --best-effort to keep the other ABIs."
    fi
    warn "[$abi] build failed — skipped (other ABIs unaffected)."
    failed+=("$abi"); continue
  fi

  align_args=(); [[ "$abi" == "arm64-v8a" ]] && align_args+=(--require-page-align 16384)
  if python3 "$SCRIPT_DIR/elfcheck.py" --expect-abi "$abi" "${align_args[@]}" \
        --require-symbol pb_version \
        --require-symbol pb_engine_new \
        --require-symbol pb_engine_chat_v2 \
        --require-symbol pb_string_free \
        "${DEST}/${abi}/${SO_NAME}"; then
    ok "[$abi] ELF verified (ABI + PhoneBuddy C-ABI symbols present)"
  else
    die "[$abi] verification failed — refusing to ship a broken slice."
  fi
  built+=("$abi")
done

# ── optional: vendor the SDK source in-repo (fully offline CI) ──────────────
if [[ "$VENDOR" == "1" ]]; then
  vend="$REPO_ROOT/third_party/PhoneBuddySDK"
  rm -rf "$vend"; mkdir -p "$(dirname "$vend")"
  ( cd "$SRC_DIR" && tar cf - --exclude='.git' --exclude='target' --exclude='dist' . ) | ( mkdir -p "$vend" && cd "$vend" && tar xf - )
  printf '%s\n' "$SDK_COMMIT" > "$vend/.upstream-commit"
  ok "Vendored SDK source → third_party/PhoneBuddySDK (commit $SDK_COMMIT). Commit it, then CI needs no network."
  warn "Apache-2.0: keep LICENSE and NOTICE files intact when redistributing."
fi

# ── manifest ────────────────────────────────────────────────────────────────
python3 - "$DEST" "$SDK_COMMIT" "$REF" "$PANIC" "${built[@]}" <<'PY'
import datetime, hashlib, json, os, subprocess, sys
dest, commit, ref, panic, *abis = sys.argv[1:]
def sh(*a):
    try: return subprocess.check_output(a, text=True).strip()
    except Exception: return None
m = {
    "generatedAt": datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "engine": "PhoneBuddy SDK (Apache-2.0) — libphone_buddy_ffi.so",
    "source": "https://github.com/APUS-AI-Lab/PhoneBuddySDK",
    "ref": ref, "upstreamCommit": commit, "panicMode": panic,
    "cargo": sh("cargo", "--version"), "rustc": sh("rustc", "--version"),
    "ndk": os.environ.get("ANDROID_NDK_HOME"), "abis": {},
}
for abi in abis:
    so = os.path.join(dest, abi, "libphone_buddy_ffi.so")
    if not os.path.isfile(so): continue
    h = hashlib.sha256()
    with open(so, "rb") as fh:
        for c in iter(lambda: fh.read(1 << 20), b""): h.update(c)
    m["abis"][abi] = {"sha256": h.hexdigest(), "bytes": os.path.getsize(so)}
p = os.path.join(dest, "abi-manifest.json")
json.dump(m, open(p, "w"), indent=2)
print(f"  ok  manifest → {p} ({len(m['abis'])} ABI slices)")
PY

echo
log "Build summary"
printf '  built   : %s\n' "${built[*]:-none}"
[[ ${#failed[@]} -gt 0 ]] && printf '  skipped : %s\n' "${failed[*]}"
printf '  dest    : %s\n' "$DEST"
echo
log "Next: tools/agent-ffi/verify-abis.sh --require-lib libphone_buddy_ffi.so --strict --jni \"$DEST\""
