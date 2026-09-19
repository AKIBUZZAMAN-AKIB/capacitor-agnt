#!/usr/bin/env python3
"""Report which Android ABIs a build actually ships native libraries for.

This is the "will this device work?" checker for the NativeKit shell. It answers
the exact question behind the armeabi-v7a failure:

    lib/<abi>/libnative_agent_ffi.so — present or not, for every ABI the APK/AAB
    or the source jniLibs tree contains?

Modes
-----
  --jni [DIR ...]   scan source trees (default: every plugin's
                    android/src/main/jniLibs plus android/app/src/main/jniLibs)
  --apk FILE        inspect a built APK
  --aab FILE        inspect a built Android App Bundle (base/lib/<abi>/…)

Options: --require-lib NAME (repeatable; default libnative_agent_ffi.so),
--strict (exit 1 when an ABI is only partially covered), --json.

Exit codes: 0 = ok, 1 = incomplete coverage (with --strict), 2 = usage/IO error.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import zipfile

DEFAULT_REQUIRED = ["libnative_agent_ffi.so"]
KNOWN_ABIS = ["arm64-v8a", "armeabi-v7a", "armeabi", "x86_64", "x86", "riscv64"]

ABI_DEVICE_NOTE = {
    "arm64-v8a": "all modern phones",
    "armeabi-v7a": "32-bit-only phones (budget/older devices — the failing case)",
    "armeabi": "ancient 32-bit ARM (no NEON)",
    "x86_64": "64-bit emulators / Intel hosts",
    "x86": "legacy 32-bit emulators",
    "riscv64": "future RISC-V devices",
}


def collect_from_zip(path: str) -> dict[str, dict[str, list[str]]]:
    """{abi: {libName: [source paths]}} for an APK or AAB."""
    out: dict[str, dict[str, list[str]]] = {}
    with zipfile.ZipFile(path) as zf:
        for name in zf.namelist():
            parts = name.split("/")
            # APK: lib/<abi>/x.so     AAB: base/lib/<abi>/x.so (also feature modules)
            if len(parts) >= 3 and parts[0] == "lib":
                abi, so = parts[1], parts[-1]
                prefix = f"lib/{abi}"
            elif len(parts) >= 4 and parts[1] == "lib":
                abi, so = parts[2], parts[-1]
                prefix = f"{parts[0]}/lib/{abi}"
            else:
                continue
            if not so.endswith(".so"):
                continue
            out.setdefault(abi, {}).setdefault(so, []).append(prefix)
    return out


def collect_from_jni(roots: list[str]) -> dict[str, dict[str, list[str]]]:
    out: dict[str, dict[str, list[str]]] = {}
    for root in roots:
        if not os.path.isdir(root):
            continue
        for abi in sorted(os.listdir(root)):
            abi_dir = os.path.join(root, abi)
            if not os.path.isdir(abi_dir) or abi.startswith("."):
                continue
            if abi == "abi-manifest.json":
                continue
            for so in sorted(os.listdir(abi_dir)):
                if not so.endswith(".so"):
                    continue
                out.setdefault(abi, {}).setdefault(so, []).append(os.path.relpath(
                    os.path.join(abi_dir, so)))
    return out


def default_jni_roots(repo_root: str) -> list[str]:
    roots = []
    plugins = os.path.join(repo_root, "plugins")
    if os.path.isdir(plugins):
        for p in sorted(os.listdir(plugins)):
            cand = os.path.join(plugins, p, "android", "src", "main", "jniLibs")
            if os.path.isdir(cand):
                roots.append(cand)
    app = os.path.join(repo_root, "android", "app", "src", "main", "jniLibs")
    if os.path.isdir(app):
        roots.append(app)
    return roots


def sort_abis(abis) -> list[str]:
    order = {a: i for i, a in enumerate(KNOWN_ABIS)}
    return sorted(abis, key=lambda a: (order.get(a, 99), a))


def main() -> int:
    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--jni", nargs="*", metavar="DIR",
                    help="source jniLibs directories to scan")
    ap.add_argument("--apk")
    ap.add_argument("--aab")
    ap.add_argument("--require-lib", action="append", default=[],
                    help=f"library that must exist for every ABI (default: {', '.join(DEFAULT_REQUIRED)})")
    ap.add_argument("--expect-abis", nargs="*", metavar="ABI",
                    help="ABIs to report even when no directory/slice exists for them "
                         "(default in --jni mode: the four ABIs Android apps ship)")
    ap.add_argument("--strict", action="store_true",
                    help="exit non-zero when an ABI in the artefact lacks a required library")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    required = args.require_lib or DEFAULT_REQUIRED
    expect: list[str] = list(args.expect_abis or [])
    target = ""

    if args.apk:
        if not os.path.isfile(args.apk):
            print(f"error: APK not found: {args.apk}", file=sys.stderr)
            return 2
        data = collect_from_zip(args.apk)
        target = args.apk
    elif args.aab:
        if not os.path.isfile(args.aab):
            print(f"error: AAB not found: {args.aab}", file=sys.stderr)
            return 2
        data = collect_from_zip(args.aab)
        target = args.aab
    else:
        roots = args.jni if args.jni else default_jni_roots(repo_root)
        if not roots:
            print("error: no jniLibs directories found (run from the repo, or pass --jni DIR)",
                  file=sys.stderr)
            return 2
        data = collect_from_jni(roots)
        target = ", ".join(roots)
        # In source-scan mode also report ABIs that have no directory at all:
        # "the folder is missing" is exactly the bug we are hunting.
        if args.expect_abis is None:
            expect = ["arm64-v8a", "armeabi-v7a", "x86_64", "x86"]

    for abi in expect:
        data.setdefault(abi, {})

    abis = sort_abis(data.keys())
    if not abis:
        print(f"error: no native libraries found in {target}", file=sys.stderr)
        return 2

    full, partial = [], []
    for abi in abis:
        libs = data[abi]
        missing = [r for r in required if r not in libs]
        (partial if missing else full).append(abi)

    if args.json:
        print(json.dumps({
            "target": target,
            "required": required,
            "abis": {abi: sorted(data[abi].keys()) for abi in abis},
            "supported": full,
            "incomplete": partial,
        }, indent=2))
        return 1 if (args.strict and partial) else 0

    print(f"Native ABI coverage — {target}")
    print(f"required library    : {', '.join(required)}")
    print()
    width = max(len(a) for a in abis) + 2
    print(f"  {'ABI'.ljust(width)}status    libs")
    print(f"  {'-' * width}-------   {'-' * 40}")
    for abi in abis:
        libs = data[abi]
        missing = [r for r in required if r not in libs]
        status = "FULL" if not missing else "MISSING"
        shown = ", ".join(sorted(libs.keys()))
        if len(shown) > 110:
            shown = shown[:107] + "..."
        print(f"  {abi.ljust(width)}{status.ljust(10)}{shown}")
        if missing:
            print(f"  {' ' * width}          ↳ missing: {', '.join(missing)} "
                  f"— devices on {abi} ({ABI_DEVICE_NOTE.get(abi, 'unknown')}) "
                  f"get checkAvailability().available=false")

    print()
    print(f"  agent engine available on : {', '.join(full) if full else 'NO ABI'}")
    print(f"  agent engine MISSING on   : {', '.join(partial) if partial else '(none)'}")
    print()

    if partial:
        # One engine, one builder: the native-agent slices come from the
        # vendored crate, so the fix is always the same command.
        print("  Fix: build the missing slices with")
        print('       tools/agent-ffi/build-android-all-abis.sh --abis "' + " ".join(partial) + '"')
        crate = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__)))), "plugins", "native-agent", "rust", "native-agent-ffi", "Cargo.toml")
        if os.path.isfile(crate):
            print("       (crate source is already vendored — just run the build)")
        else:
            print("       (needs the Rust crate — see tools/agent-ffi/README.bn.md)")
        print()
    else:
        print("  Every ABI in this artefact carries all required native libraries. ✅")

    return 1 if (args.strict and partial) else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except zipfile.BadZipFile as exc:
        print(f"error: not a readable APK/AAB zip: {exc}", file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(130)
