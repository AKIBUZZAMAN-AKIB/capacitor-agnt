#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# NativeKit — vendor the private Rust FFI crate into this repository.
#
# The native agent engine (libnative_agent_ffi.so) comes from a crate that does
# NOT live in this repo:
#     plugins/native-agent/.gitmodules -> https://gitlab.k8s.t6x.io/rruiz/native-agent-ffi
# (and there is not even a submodule gitlink in the tree, so
#  `git submodule update --init` does nothing).
#
# That makes every ABI rebuild depend on somebody else's private GitLab account.
# This script ends that dependency: it copies a checkout/tarball of the crate
# into plugins/native-agent/rust/native-agent-ffi as ORDINARY committed files,
# records a SHA-256 manifest, and detaches the .gitmodules entry. After that:
#   • every `git clone` of this repo contains the full buildable source,
#   • GitHub Actions can rebuild .so for any ABI with no secrets,
#   • nobody's private repo can disappear and break your build.
#
# Usage
#   vendor-ffi-source.sh --from-dir /path/to/native-agent-ffi
#   vendor-ffi-source.sh --from-tar ~/native-agent-ffi.tar.gz
#   vendor-ffi-source.sh --from-git https://gitlab.k8s.t6x.io/rruiz/native-agent-ffi.git --ref main
#   vendor-ffi-source.sh --from-submodule          # convert an existing submodule checkout
#
# Options
#   --dest PATH     vendored location (default plugins/native-agent/rust/native-agent-ffi)
#   --token TOKEN   access token for --from-git (or set FFI_SOURCE_TOKEN)
#   --force         overwrite an existing vendored copy
#   --dry-run       show what would happen
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PLUGIN_DIR="${REPO_ROOT}/plugins/native-agent"
DEST="${PLUGIN_DIR}/rust/native-agent-ffi"
GITMODULES="${PLUGIN_DIR}/.gitmodules"

MODE=""; SOURCE=""; REF=""; TOKEN="${FFI_SOURCE_TOKEN:-}"; FORCE=0; DRY_RUN=0
UPSTREAM_DEFAULT="https://gitlab.k8s.t6x.io/rruiz/native-agent-ffi.git"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[1;32mok\033[0m  %s\n' "$*"; }
warn() { printf '  \033[1;33mwarn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-dir)   MODE=dir;  SOURCE="$2"; shift 2 ;;
    --from-tar)   MODE=tar;  SOURCE="$2"; shift 2 ;;
    --from-git)   MODE=git;  SOURCE="$2"; shift 2 ;;
    --from-submodule) MODE=submodule; shift ;;
    --ref)        REF="$2"; shift 2 ;;
    --token)      TOKEN="$2"; shift 2 ;;
    --dest)       DEST="$2"; shift 2 ;;
    --force)      FORCE=1; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -h|--help)    usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

[[ -n "$MODE" ]] || die "no source given. Use --from-dir, --from-tar, --from-git or --from-submodule.
If you do not have the crate yet, you must obtain it first (it is private):
    $UPSTREAM_DEFAULT
Ask the upstream author for a source drop or a build for the ABIs you need — see
tools/agent-ffi/README.bn.md §'সোর্স না থাকলে কী করবেন' for a ready-made request."

command -v python3 >/dev/null 2>&1 || die "python3 not found."
command -v tar >/dev/null 2>&1 || warn "tar not found — tarball sources may fail."

if [[ -e "$DEST" && "$FORCE" != "1" ]]; then
  die "$DEST already exists. Re-run with --force to replace it (it will be deleted)."
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
SRC_INFO=""

case "$MODE" in
  dir)
    [[ -d "$SOURCE" ]] || die "directory not found: $SOURCE"
    [[ -f "$SOURCE/Cargo.toml" ]] || die "$SOURCE does not look like the crate (no Cargo.toml)."
    log "Copying from directory $SOURCE"
    SRC_INFO="dir:$SOURCE"
    mkdir -p "$STAGE/crate"
    ( cd "$SOURCE" && tar cf - \
        --exclude='.git' --exclude='.git/*' \
        --exclude='target' --exclude='target/*' \
        --exclude='node_modules' --exclude='example' . ) | ( cd "$STAGE/crate" && tar xf - )
    ;;
  tar)
    [[ -f "$SOURCE" ]] || die "tarball not found: $SOURCE"
    log "Extracting $SOURCE"
    SRC_INFO="tar:$SOURCE"
    mkdir -p "$STAGE/raw"
    tar xf "$SOURCE" -C "$STAGE/raw"
    # accept either a bare crate root or one wrapper directory (git archive style)
    if [[ -f "$STAGE/raw/Cargo.toml" ]]; then
      crate_root="$STAGE/raw"
    else
      candidates=()
      while IFS= read -r d; do candidates+=("$d"); done < <(find "$STAGE/raw" -maxdepth 2 -name Cargo.toml -printf '%h\n')
      [[ ${#candidates[@]} -ge 1 ]] || die "no Cargo.toml found inside $SOURCE"
      # prefer the one that actually produces the FFI library
      crate_root=""
      for c in "${candidates[@]}"; do
        if grep -q "native_agent_ffi\|native-agent-ffi" "$c/Cargo.toml"; then crate_root="$c"; break; fi
      done
      [[ -n "$crate_root" ]] || crate_root="${candidates[0]}"
    fi
    mkdir -p "$STAGE/crate"
    ( cd "$crate_root" && tar cf - \
        --exclude='.git' --exclude='.git/*' --exclude='target' --exclude='target/*' . ) | ( cd "$STAGE/crate" && tar xf - )
    ;;
  git)
    command -v git >/dev/null 2>&1 || die "git not found."
    url="$SOURCE"
    if [[ -n "$TOKEN" ]]; then
      # https://oauth2:<token>@host/path
      url="$(printf '%s' "$SOURCE" | sed -E "s#^(https?://)#\1oauth2:${TOKEN}@#")"
      log "Cloning $SOURCE (with token from \$FFI_SOURCE_TOKEN/--token)"
    else
      log "Cloning $SOURCE"
      warn "no token supplied — this only works for a public repository."
    fi
    clone_args=(--depth 1)
    [[ -n "$REF" ]] && clone_args+=(--branch "$REF")
    git clone "${clone_args[@]}" "$url" "$STAGE/crate"
    SRC_INFO="git:$SOURCE${REF:+@$REF}"
    ;;
  submodule)
    log "Converting an existing submodule checkout into vendored files"
    if [[ ! -f "$GITMODULES" ]]; then
      warn "no $GITMODULES — nothing to convert."
    fi
    if [[ ! -d "$DEST/.git" && ! -f "$DEST/.git" ]]; then
      die "$DEST is not an initialised submodule checkout. Run
  git submodule update --init --recursive
first (needs access to the private GitLab), then re-run with --from-submodule."
    fi
    mkdir -p "$STAGE/crate"
    ( cd "$DEST" && git rev-parse HEAD > "$STAGE/crate/.upstream-commit" && tar cf - \
        --exclude='./.git' --exclude='./target' . ) | ( cd "$STAGE/crate" && tar xf - )
    SRC_INFO="submodule:$(cd "$DEST" && git config --get remote.origin.url)"
    ;;
  *) die "unreachable" ;;
esac

[[ -f "$STAGE/crate/Cargo.toml" ]] || die "staged copy has no Cargo.toml — aborting."

# ── sanity: is this really the FFI crate that produces libnative_agent_ffi.so? ──
crate_name="$(awk -F'"' '/^[ \t]*name[ \t]*=/{print $2; exit}' "$STAGE/crate/Cargo.toml")"
lib_name="$(awk '/^[ \t]*\[lib\]/{f=1;next} /^[ \t]*\[/{f=0} f && /^[ \t]*name[ \t]*=/{gsub(/[" ]/,"",$0); sub(/^name=/,"",$0); print; exit}' "$STAGE/crate/Cargo.toml")"
lib_name="${lib_name:-$(printf '%s' "${crate_name:-native-agent-ffi}" | tr '-' '_')}"
log "Crate: ${crate_name:-unknown}  •  produced library: lib${lib_name}.so"

if [[ "$lib_name" != "native_agent_ffi" ]]; then
  warn "The crate would build lib${lib_name}.so, but the plugin's Kotlin code loads 'native_agent_ffi'."
  warn "Either this is a different crate, or the crate's [lib] name changed."
fi

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry run — would install ${SRC_INFO} into $DEST"
  find "$STAGE/crate" -maxdepth 2 | head -40
  exit 0
fi

# ── install ─────────────────────────────────────────────────────────────────
rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"
mv "$STAGE/crate" "$DEST"
upstream_commit=""
if [[ -f "$DEST/.upstream-commit" ]]; then
  upstream_commit="$(cat "$DEST/.upstream-commit")"
  rm -f "$DEST/.upstream-commit"
fi

# ── commit-time metadata ────────────────────────────────────────────────────
python3 - "$DEST" "$SRC_INFO" "$upstream_commit" <<'PY'
import datetime, hashlib, json, os, sys
dest, src, commit = sys.argv[1], sys.argv[2], sys.argv[3]
files = {}
for root, dirs, names in os.walk(dest):
    dirs[:] = [d for d in dirs if d not in (".git", "target", "node_modules")]
    for n in sorted(names):
        p = os.path.join(root, n)
        rel = os.path.relpath(p, dest)
        h = hashlib.sha256()
        with open(p, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        files[rel] = h.hexdigest()
total = sum(os.path.getsize(os.path.join(dest, f)) for f in files)
manifest = {
    "vendoredAt": datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "source": src,
    "upstreamCommit": commit or None,
    "fileCount": len(files),
    "totalBytes": total,
    "note": ("Vendored copy of the native agent FFI crate. Ordinary files — no "
             "submodule and no private repository access is required to build. "
             "Refresh with tools/agent-ffi/vendor-ffi-source.sh --force."),
    "files": files,
}
with open(os.path.join(dest, "VENDOR-MANIFEST.json"), "w") as fh:
    json.dump(manifest, fh, indent=2, sort_keys=True)
    fh.write("\n")
print(f"  ok  {len(files)} files ({total/1_048_576:.2f} MiB) hashed → VENDOR-MANIFEST.json")
PY

# ── detach the (private) submodule contract ─────────────────────────────────
if [[ -f "$GITMODULES" ]]; then
  if [[ -n "$(tr -d '[:space:]' < "$GITMODULES")" ]]; then
    mv "$GITMODULES" "${GITMODULES}.disabled"
    ok "Disabled ${GITMODULES#"$REPO_ROOT/"} → $(basename "${GITMODULES}.disabled")"
    warn "If it is tracked in git, also run:  git rm --cached plugins/native-agent/.gitmodules"
  fi
fi
if git -C "$REPO_ROOT" config --file .gitmodules --get-regexp path >/dev/null 2>&1; then
  warn "A .gitmodules entry still exists in git history/working tree — remove it so 'git submodule update' stops asking for credentials."
fi

# make sure the vendored source is NOT ignored
gitignore="${PLUGIN_DIR}/.gitignore"
if [[ -f "$gitignore" ]] && grep -qE '^\s*rust/\s*$' "$gitignore"; then
  warn "$gitignore ignores rust/ — add '!rust/native-agent-ffi/' so the source gets committed."
fi

echo
log "Vendored source installed → ${DEST#"$REPO_ROOT/"}"
cat <<EOF

Next steps
  1. Commit the source (this is what makes every future clone buildable):
       git add plugins/native-agent/rust plugins/native-agent/.gitmodules.disabled
       git rm --cached plugins/native-agent/.gitmodules 2>/dev/null || true
       git commit -m "vendor native-agent-ffi crate (no private-repo dependency)"
  2. Build all Android ABIs:
       tools/agent-ffi/build-android-all-abis.sh
  3. Verify what will actually ship:
       tools/agent-ffi/verify-abis.sh --strict
  4. Push — GitHub Actions (.github/workflows/native-agent-ffi.yml) can rebuild
     the .so for every ABI on demand, with no secrets.

Note on licence: the upstream crate is your dependency's source. Check its
LICENSE before publishing a fork or a store build.
EOF
