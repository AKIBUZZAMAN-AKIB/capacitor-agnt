#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# NativeKit — resolve the native-agent FFI crate source, from CI, with no local
# steps. Then hand it to vendor-ffi-source.sh so the repo ends up with the crate
# as ordinary committed files.
#
# Modes (what "resolve" means)
#   repo            crate already vendored in this repository  (nothing to do)
#   public-upstream clone the PUBLIC GitHub repo (rogelioRuiz/capacitor-native-agent)
#                   at --ref and take rust/native-agent-ffi.
#                   ⚠ the crate was committed up to v0.5.2; from v0.9.0 it is only a
#                     submodule pointer to the private GitLab, so pick a tag that
#                     really contains it (verified: v0.5.2).
#   release-asset   download a source archive someone uploaded to a GitHub Release
#                   (asset pattern or direct URL). This is the zero-local-steps way
#                   to funnel the exact 0.9.x source: upload once from a phone or
#                   browser, then every build runs inside Actions.
#   git             clone an arbitrary (possibly private) git URL, token optional
#   tar | dir       local archive / directory (delegates to vendor-ffi-source.sh)
#
# Examples
#   tools/agent-ffi/resolve-ffi-source.sh --mode repo
#   tools/agent-ffi/resolve-ffi-source.sh --mode public-upstream --ref v0.5.2
#   tools/agent-ffi/resolve-ffi-source.sh --mode release-asset \
#       --asset-pattern 'native-agent-ffi-src-*.tar.gz' --tag ffi-source
#   tools/agent-ffi/resolve-ffi-source.sh --mode git --url https://gitlab... --token …
#
# Options: --dest PATH (vendor location), --force, --dry-run, --no-vendor (only fetch+report)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
VENDOR="${SCRIPT_DIR}/vendor-ffi-source.sh"
DEFAULT_DEST="${REPO_ROOT}/plugins/native-agent/rust/native-agent-ffi"
PUBLIC_UPSTREAM="https://github.com/rogelioRuiz/capacitor-native-agent.git"

MODE="repo"; REF=""; URL=""; TOKEN="${FFI_SOURCE_TOKEN:-}"; DEST="$DEFAULT_DEST"
ASSET_PATTERN=""; ASSET_URL=""; TAG=""; REPO_SLUG="${GITHUB_REPOSITORY:-}"
FORCE=0; DRY_RUN=0; NO_VENDOR=0

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '  \033[1;32mok\033[0m  %s\n' "$*"; }
warn() { printf '  \033[1;33mwarn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)          MODE="$2"; shift 2 ;;
    --ref)           REF="$2"; shift 2 ;;
    --url)           URL="$2"; shift 2 ;;
    --token)         TOKEN="$2"; shift 2 ;;
    --dest)          DEST="$2"; shift 2 ;;
    --asset-pattern) ASSET_PATTERN="$2"; shift 2 ;;
    --asset-url)     ASSET_URL="$2"; shift 2 ;;
    --tag)           TAG="$2"; shift 2 ;;
    --repo)          REPO_SLUG="$2"; shift 2 ;;
    --force)         FORCE=1; shift ;;
    --dry-run)       DRY_RUN=1; shift ;;
    --no-vendor)     NO_VENDOR=1; shift ;;
    -h|--help)       usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

describe_crate() {   # $1 = directory
  local d="$1" name version lib license
  name="$(awk -F'"' '/^[ \t]*name[ \t]*=/{print $2; exit}' "$d/Cargo.toml")"
  version="$(awk -F'"' '/^[ \t]*version[ \t]*=/{print $2; exit}' "$d/Cargo.toml")"
  lib="$(awk '/^[ \t]*\[lib\]/{f=1;next} /^[ \t]*\[/{f=0} f && /^[ \t]*name[ \t]*=/{gsub(/[" ]/,"",$0); sub(/^name=/,"",$0); print; exit}' "$d/Cargo.toml")"
  log "Crate: ${name:-?} ${version:-?}  →  lib${lib:-native_agent_ffi}.so"
  [[ -n "${lib:-}" && "$lib" != "native_agent_ffi" ]] && warn "expected [lib] name 'native_agent_ffi' (the plugin's Kotlin loads that name) — got '$lib'"
  for f in LICENSE LICENSE.md COPYING; do
    [[ -f "$d/$f" ]] && { log "Licence file present: $f"; break; }
  done
  # surface the UniFFI version: it decides binding compatibility
  grep -E '^\s*uniffi\s*=' "$d/Cargo.toml" | head -2 || true
  return 0
}

case "$MODE" in
  repo)
    if [[ -f "$DEST/Cargo.toml" ]]; then
      ok "Crate already vendored at ${DEST#"$REPO_ROOT/"}"
      describe_crate "$DEST"
      exit 0
    fi
    die "no vendored crate at ${DEST#"$REPO_ROOT/"} — choose another --mode
  public-upstream : tools/agent-ffi/resolve-ffi-source.sh --mode public-upstream --ref v0.5.2
  release-asset   : upload the source tarball to a Release, then use --mode release-asset
  git             : give me a URL + token for the private GitLab"
    ;;

  public-upstream)
    REF="${REF:-v0.5.2}"
    STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
    log "Cloning PUBLIC upstream $PUBLIC_UPSTREAM @ $REF"
    git clone --quiet --depth 1 --branch "$REF" "$PUBLIC_UPSTREAM" "$STAGE/up"
    CRATE="$STAGE/up/rust/native-agent-ffi"
    if [[ ! -f "$CRATE/Cargo.toml" ]]; then
      warn "$REF has no crate source committed (it is a submodule pointer from v0.9.0 onwards)."
      warn "Tags that DO contain the source: v0.5.2 (verified)."
      die "nothing to vendor at ref '$REF'"
    fi
    ok "crate source found at rust/native-agent-ffi in $REF"
    describe_crate "$CRATE"
    if [[ "$DRY_RUN" == "1" || "$NO_VENDOR" == "1" ]]; then
      find "$CRATE" -type f | sed "s|$STAGE/up/||" | head -30
      exit 0
    fi
    log "Vendoring (this writes ${DEST#"$REPO_ROOT/"})…"
    OTHER_ARGS=(--force); [[ "$DEST" != "$DEFAULT_DEST" ]] && OTHER_ARGS+=(--dest "$DEST")
    : # (see below)
    "$VENDOR" --from-dir "$CRATE" "${OTHER_ARGS[@]}"
    ;;

  release-asset)
    STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
    if [[ -n "$ASSET_URL" ]]; then
      log "Downloading $ASSET_URL"
      curl -fsSL ${TOKEN:+-H "Authorization: Bearer $TOKEN"} -o "$STAGE/src.tar.gz" "$ASSET_URL"
    else
      [[ -n "$TAG" ]] || die "--tag <release-tag> is required with --asset-pattern"
      [[ -n "$ASSET_PATTERN" ]] || ASSET_PATTERN='native-agent-ffi-src-*.tar.gz'
      if command -v gh >/dev/null 2>&1; then
        log "gh release download $TAG --pattern '$ASSET_PATTERN'"
        gh release download "$TAG" --pattern "$ASSET_PATTERN" --dir "$STAGE" ${REPO_SLUG:+--repo "$REPO_SLUG"} \
          || die "no release asset matched '$ASSET_PATTERN' in release '$TAG'"
      else
        [[ -n "$REPO_SLUG" ]] || die "gh is not installed and --repo owner/name was not given"
        api="https://api.github.com/repos/$REPO_SLUG/releases/tags/$TAG"
        asset_url="$(curl -fsSL ${TOKEN:+-H "Authorization: Bearer $TOKEN"} "$api" \
          | python3 -c "
import json,sys,fnmatch
pat=sys.argv[1]
for a in json.load(sys.stdin).get('assets',[]):
    if fnmatch.fnmatch(a['name'], pat): print(a['url']); break
" "$ASSET_PATTERN")"
        [[ -n "$asset_url" ]] || die "no asset matched '$ASSET_PATTERN' in release '$TAG'"
        curl -fsSL -H 'Accept: application/octet-stream' ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
          -o "$STAGE/src.tar.gz" "$asset_url"
      fi
    fi
    [[ -f "$STAGE/src.tar.gz" ]] || die "download failed"
    log "Extracting source archive"
    mkdir -p "$STAGE/x"; tar xf "$STAGE/src.tar.gz" -C "$STAGE/x"
    CRATE="$STAGE/x"
    if [[ ! -f "$CRATE/Cargo.toml" ]]; then
      # tolerate one wrapper directory / a repo-style archive
      found="$(find "$STAGE/x" -maxdepth 4 -name Cargo.toml -printf '%h\n' | head -n1)"
      [[ -n "$found" ]] || die "no Cargo.toml inside the archive"
      CRATE="$found"
      # prefer a nested rust/native-agent-ffi if that is what was uploaded
      nested="$(find "$STAGE/x" -maxdepth 4 -type d -name 'native-agent-ffi' | head -n1)"
      [[ -n "$nested" && -f "$nested/Cargo.toml" ]] && CRATE="$nested"
    fi
    describe_crate "$CRATE"
    [[ "$DRY_RUN" == "1" || "$NO_VENDOR" == "1" ]] && { find "$CRATE" -maxdepth 2 -type f | head -30; exit 0; }
    OTHER_ARGS=(--force); [[ "$DEST" != "$DEFAULT_DEST" ]] && OTHER_ARGS+=(--dest "$DEST")
    : # (see below)
    "$VENDOR" --from-dir "$CRATE" "${OTHER_ARGS[@]}"
    ;;

  git)
    [[ -n "$URL" ]] || die "--url is required for --mode git"
    STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
    clone_url="$URL"
    [[ -n "$TOKEN" ]] && clone_url="$(printf '%s' "$URL" | sed -E "s#^(https?://)#\1oauth2:${TOKEN}@#")"
    log "Cloning $URL${TOKEN:+ (token supplied)}${REF:+ @ $REF}"
    args=(--depth 1); [[ -n "$REF" ]] && args+=(--branch "$REF")
    git clone --quiet "${args[@]}" "$clone_url" "$STAGE/up" || die "clone failed (token/scope/ref?)"
    CRATE="$STAGE/up"
    [[ -f "$CRATE/Cargo.toml" ]] || CRATE="$STAGE/up/rust/native-agent-ffi"
    [[ -f "$CRATE/Cargo.toml" ]] || CRATE="$(find "$STAGE/up" -maxdepth 3 -name Cargo.toml -printf '%h\n' | head -n1)"
    [[ -n "${CRATE:-}" && -f "$CRATE/Cargo.toml" ]] || die "could not find the crate inside the clone"
    describe_crate "$CRATE"
    [[ "$DRY_RUN" == "1" || "$NO_VENDOR" == "1" ]] && exit 0
    OTHER_ARGS=(--force); [[ "$DEST" != "$DEFAULT_DEST" ]] && OTHER_ARGS+=(--dest "$DEST")
    : # (see below)
    "$VENDOR" --from-dir "$CRATE" "${OTHER_ARGS[@]}"
    ;;

  tar)
    [[ -n "$URL" ]] || die "--url (path to the .tar.gz) is required for --mode tar"
    pv=(); [[ "$FORCE" == "1" ]] && pv+=(--force); [[ "$DRY_RUN" == "1" ]] && pv+=(--dry-run)
    [[ "$DEST" != "$DEFAULT_DEST" ]] && pv+=(--dest "$DEST")
    "$VENDOR" --from-tar "$URL" "${pv[@]}"
    ;;

  dir)
    [[ -n "$URL" ]] || die "--url (path to the crate directory) is required for --mode dir"
    pv=(); [[ "$FORCE" == "1" ]] && pv+=(--force); [[ "$DRY_RUN" == "1" ]] && pv+=(--dry-run)
    [[ "$DEST" != "$DEFAULT_DEST" ]] && pv+=(--dest "$DEST")
    "$VENDOR" --from-dir "$URL" "${pv[@]}"
    ;;

  *) die "unknown --mode '$MODE' (repo|public-upstream|release-asset|git|tar|dir)" ;;
esac

log "Source resolution complete → ${DEST#"$REPO_ROOT/"}"
