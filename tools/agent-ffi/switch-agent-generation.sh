#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# NativeKit — switch the agent plugin to a PUBLIC upstream generation.
#
# Why: the 0.9.x engine crate lives behind a private GitLab, but the public
# GitHub repo rogelioRuiz/capacitor-native-agent carries BOTH the plugin code and
# (up to tag v0.5.2) the complete Rust crate source. Pinning the whole plugin to
# such a tag gives you a 100 % public, reproducible, all-ABI stack:
#
#   plugin (Kotlin + TS + dist)  ==  tag
#   rust/native-agent-ffi        ==  same tag        ← buildable for every ABI
#   UniFFI contract              ==  same on both sides (no mismatch)
#
# Default is a DRY RUN: it fetches the tag, prints what would change, the API
# diff against the current plugin, and the JS shim you will need. Nothing is
# written until you pass --apply.
#
# Usage
#   tools/agent-ffi/switch-agent-generation.sh                       # dry run, ref v0.5.2
#   tools/agent-ffi/switch-agent-generation.sh --ref v0.5.2 --apply
#   tools/agent-ffi/switch-agent-generation.sh --ref v0.5.2 --apply --keep-jniLibs
#
# Options: --ref, --url, --apply, --keep-jniLibs, --backup-dir PATH, --plugin-dir PATH
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLUGIN_DIR="${REPO_ROOT}/plugins/native-agent"
URL="https://github.com/rogelioRuiz/capacitor-native-agent.git"
REF="v0.5.2"
APPLY=0
KEEP_JNI=0
BACKUP_DIR=""

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[1;32mok\033[0m  %s\n' "$*"; }
warn() { printf '  \033[1;33mwarn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)        REF="$2"; shift 2 ;;
    --url)        URL="$2"; shift 2 ;;
    --apply)      APPLY=1; shift ;;
    --keep-jniLibs) KEEP_JNI=1; shift ;;
    --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
    --plugin-dir) PLUGIN_DIR="$2"; shift 2 ;;
    -h|--help)    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

command -v git >/dev/null 2>&1 || die "git not found"
[[ -d "$PLUGIN_DIR" ]] || die "no plugin at $PLUGIN_DIR"
BACKUP_DIR="${BACKUP_DIR:-${REPO_ROOT}/.nativekit-backups/native-agent-${REF}-$(date +%Y%m%d-%H%M%S)}"

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
log "Fetching public plugin generation: $URL @ $REF"
git clone --quiet --depth 1 --branch "$REF" "$URL" "$STAGE/up" || die "clone failed (ref '$REF' exists?)"
UP="$STAGE/up"

missing=()
for f in package.json android src dist; do
  [[ -e "$UP/$f" ]] || missing+=("$f")
done
[[ ${#missing[@]} -eq 0 ]] || die "upstream $REF is missing: ${missing[*]} — wrong tag?"

CRATE_STATE="absent"
[[ -f "$UP/rust/native-agent-ffi/Cargo.toml" ]] && CRATE_STATE="present"

log "Upstream @ $REF"
printf '  plugin package : %s\n' "$(python3 -c "import json;print(json.load(open('$UP/package.json')).get('version','?'))")"
printf '  rust crate     : %s\n' "$CRATE_STATE"
printf '  jniLibs        : %s\n' "$(ls "$UP/android/src/main/jniLibs" 2>/dev/null | tr '\n' ' ' || echo none)"
grep -E '^[ \t]*uniffi[ \t]*=' "$UP/rust/native-agent-ffi/Cargo.toml" 2>/dev/null | head -1 | sed 's/^/  uniffi         : /' || true

# ── binding contract versions (the thing that must match) ───────────────────
UP_CONTRACT="$(grep -oE 'bindings_contract_version = [0-9]+' "$UP/android/src/main/java/uniffi/native_agent_ffi/native_agent_ffi.kt" 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo '?')"
CUR_CONTRACT="$(grep -oE 'bindings_contract_version = [0-9]+' "$PLUGIN_DIR/android/src/main/java/uniffi/native_agent_ffi/native_agent_ffi.kt" 2>/dev/null | grep -oE '[0-9]+' | head -1 || echo '?')"
echo
log "UniFFI contract versions"
printf '  current plugin (committed) : %s\n' "$CUR_CONTRACT"
printf '  upstream %-18s : %s   ← both sides of the switch use this one\n' "$REF" "$UP_CONTRACT"

# ── API surface diff ────────────────────────────────────────────────────────
echo
log "API surface diff (NativeAgentPlugin interface)"
python3 - "$UP/src/definitions.ts" "$PLUGIN_DIR/src/definitions.ts" <<'PY' || true
import re, sys, os
def methods(path):
    if not os.path.isfile(path): return set()
    s = open(path).read()
    m = re.search(r'export interface NativeAgentPlugin\s*\{(.*?)\n\}', s, re.S)
    return set(re.findall(r'^\s+([a-zA-Z]+)\??\(', m.group(1), re.M)) if m else set()
up, cur = methods(sys.argv[1]), methods(sys.argv[2])
print(f"  upstream methods : {len(up)}")
print(f"  current methods  : {len(cur)}")
lost = sorted(cur - up)
gain = sorted(up - cur)
print(f"  LOST after switch ({len(lost)}): {', '.join(lost) if lost else 'none'}")
print(f"  gained             ({len(gain)}): {', '.join(gain) if gain else 'none'}")
if lost:
    print("  ↳ these are called by shell code and need a shim (see output below)")
PY

# ── shim text for the methods that disappear ────────────────────────────────
cat <<EOF

  JS/TS shim for the methods that only exist in the newer generation
  (paste into bridge/nativekit.ts next to window.NativeKit.agent wiring):

    // checkAvailability() — the old generation has no such native method;
    // probe with a local, offline call instead:
    const checkAvailability = async () => {
      try {
        await NativeAgent.listSessions()                 // local only, no network
        return { available: true, abi: 'unknown', is64Bit: undefined, reason: '' }
      } catch (e) {
        return { available: false, abi: 'unknown', is64Bit: false,
                 reason: \`native library not loadable: \${e?.message ?? e}\` }
      }
    }
    // scheduleBackgroundWakes / cancelBackgroundWakes → no-op (old JobService only)
    // loadSurfacedMessages → map to engine session history
    // setMcpTools           → use startMcp / restartMcp

EOF

if [[ "$APPLY" != "1" ]]; then
  log "DRY RUN — nothing written. Re-run with --apply to perform the switch."
  echo
  echo "  Would do:"
  echo "    1. back up $PLUGIN_DIR → $BACKUP_DIR"
  echo "    2. copy the $REF plugin (android/, src/, dist/, package.json, ios/, rust/) over it"
  [[ "$KEEP_JNI" == "1" ]] && echo "    3. keep the existing jniLibs slices" || echo "    3. replace jniLibs with the upstream ones (then rebuild all ABIs in Actions)"
  echo "    4. print the follow-up checklist (npm ci, npm run check, Actions run)"
  exit 0
fi

# ── apply ───────────────────────────────────────────────────────────────────
mkdir -p "$(dirname "$BACKUP_DIR")"
log "Backing up current plugin → ${BACKUP_DIR#"$REPO_ROOT/"}"
mkdir -p "$BACKUP_DIR"
( cd "$PLUGIN_DIR" && tar cf - --exclude='node_modules' --exclude='target' . ) | ( cd "$BACKUP_DIR" && tar xf - )
ok "backup complete ($(du -sh "$BACKUP_DIR" | cut -f1))"

log "Copying $REF plugin files over ${PLUGIN_DIR#"$REPO_ROOT/"}"
TMP_COPY="$STAGE/copy"; mkdir -p "$TMP_COPY"
( cd "$UP" && tar cf - \
    --exclude='.git' --exclude='.git/*' --exclude='node_modules' \
    --exclude='rust/native-agent-ffi/target' --exclude='example' . ) | ( cd "$TMP_COPY" && tar xf - )

if [[ "$KEEP_JNI" == "1" ]]; then
  rm -rf "$TMP_COPY/android/src/main/jniLibs"
  ok "keeping existing jniLibs (--keep-jniLibs)"
fi

# keep our tooling/workflow files out of harm's way (they live at repo root, so
# nothing to do there), then swap the plugin contents in place.
find "$PLUGIN_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
( cd "$TMP_COPY" && tar cf - . ) | ( cd "$PLUGIN_DIR" && tar xf - )
ok "plugin now matches $REF"

# make the vendored crate visible to the ABI builder + record provenance
if [[ -f "$PLUGIN_DIR/rust/native-agent-ffi/Cargo.toml" ]]; then
  ok "crate source present at plugins/native-agent/rust/native-agent-ffi (buildable for every ABI)"
  {
    echo "source=$URL"
    echo "ref=$REF"
    echo "switchedAt=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$PLUGIN_DIR/rust/native-agent-ffi/.generation-source"
else
  warn "no crate source in $REF — build the .so from another source (resolve-ffi-source.sh)"
fi

if [[ ! -f "${REPO_ROOT}/.gitignore" ]] || ! grep -q '^\.nativekit-backups/' "${REPO_ROOT}/.gitignore"; then
  printf '\n.nativekit-backups/\n' >> "${REPO_ROOT}/.gitignore"
  ok "added .nativekit-backups/ to .gitignore"
fi

cat <<EOF

== Done. Next steps ==
  1. Review the diff:        git status --short && git diff --stat
  2. Install + validate:     npm ci && npm run check
  3. Build every ABI in CI:  GitHub → Actions → "Native agent FFI — source, build, verify"
                             source_mode = repo   (the crate is now vendored)
                             abis        = arm64-v8a armeabi-v7a x86_64 x86
                             build_apk   = true
  4. Add the JS shim above for the methods listed as LOST.
  5. If something is wrong, roll back with:
       rm -rf ${PLUGIN_DIR#"$REPO_ROOT/"} && cp -a ${BACKUP_DIR#"$REPO_ROOT/"} ${PLUGIN_DIR#"$REPO_ROOT/"}
EOF
