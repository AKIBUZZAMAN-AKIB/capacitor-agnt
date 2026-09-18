#!/bin/bash
# Pre-publish sanity gate. Run before `npm publish` (see CLAUDE.md release flow).
# Exits non-zero on any hard failure; warnings are reported but non-fatal.
set -uo pipefail

cd "$(cd "$(dirname "$0")" && pwd)/.."
FAIL=0
WARN=0

fail()  { echo "  FAIL: $*"; FAIL=1; }
warn()  { echo "  WARN: $*"; WARN=1; }
ok()    { echo "  ok:   $*"; }

echo "== 1. TypeScript: dist/ in sync with src/ =="
npm run build >/dev/null 2>&1 || { fail "npm run build failed"; }
if git diff --exit-code --quiet dist/ 2>/dev/null; then
  ok "dist/ matches src/ build output"
else
  fail "dist/ is stale — commit the rebuilt dist/ (it ships in the npm tarball)"
fi

echo "== 2. Android: ABI coverage =="
for ABI in arm64-v8a armeabi-v7a x86_64 x86; do
  SO="android/src/main/jniLibs/$ABI/libnative_agent_ffi.so"
  if [ -f "$SO" ]; then
    case "$(file -b "$SO")" in
      *stripped*) ok "$ABI .so present and stripped" ;;
      *)          warn "$ABI .so present but NOT stripped (bigger APK)" ;;
    esac
  else
    [ "$ABI" = "arm64-v8a" ] && fail "$ABI .so missing (required ABI!)" || warn "$ABI .so missing — devices with this ABI will report checkAvailability().available=false"
  fi
done

echo "== 3. iOS: xcframework slices =="
if [ -d "ios/Frameworks/NativeAgentFFI.xcframework" ]; then
  for SLICE in ios-arm64 ios-arm64-simulator; do
    [ -f "ios/Frameworks/NativeAgentFFI.xcframework/$SLICE/libnative_agent_ffi.a" ] \
      && ok "slice $SLICE present" || fail "slice $SLICE missing (required)"
  done
  [ -f "ios/Frameworks/NativeAgentFFI.xcframework/x86_64-simulator/libnative_agent_ffi.a" ] \
    && ok "slice x86_64-simulator present (Intel Macs supported)" \
    || warn "no x86_64-simulator slice — Intel Mac simulators cannot build (re-run scripts/build-ios.sh on an Intel-capable Mac if needed)"
else
  fail "ios/Frameworks/NativeAgentFFI.xcframework missing"
fi

echo "== 4. Manifests & packaging =="
[ -f android/src/main/AndroidManifest.xml ] \
  && ok "plugin AndroidManifest.xml present (JobService registered)" \
  || warn "plugin AndroidManifest.xml missing — background JobService will not be registered"
grep -q "capacitor-lancedb" android/build.gradle && \
  ok "lancedb is an optional (findProject-gated) dependency" || \
  fail "android/build.gradle does not gate the lancedb dependency — apps without capacitor-lancedb will fail to build"
grep -v '^\s*//' Package.swift | grep -q 'path:.*capacitor-lancedb' && \
  fail "Package.swift hard-depends on a local ../capacitor-lancedb path — SwiftPM resolution breaks without it" \
  || ok "Package.swift has no hard lancedb path dependency"
if command -v ruby >/dev/null 2>&1; then
  ruby -c CapacitorNativeAgent.podspec >/dev/null 2>&1 && ok "podspec syntax valid" || fail "podspec has a Ruby syntax error"
fi
grep -v '^\s*#' CapacitorNativeAgent.podspec | grep -q "Headers/native_agent_ffiFFI.modulemap" && \
  fail "podspec points at the old (nonexistent) modulemap path" || ok "podspec modulemap paths look correct"

echo "== 5. npm tarball contents (no rust/, no example/, no build outputs) =="
if npm pack --dry-run 2>/dev/null | grep -E "rust/|example/|android/build/|node_modules/" ; then
  fail "tarball contains sources/outputs that must never ship"
else
  ok "tarball contents look clean"
fi

echo
if [ $FAIL -ne 0 ]; then
  echo "RESULT: FAILED — fix the items above before publishing."
  exit 1
fi
[ $WARN -ne 0 ] && echo "RESULT: PASSED with warnings." || echo "RESULT: PASSED."
