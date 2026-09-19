#!/usr/bin/env python3
"""Dependency-free Mach-O / xcframework verifier for the NativeKit FFI tooling.

Why this file exists (the bug it replaces)
------------------------------------------
The first version of tools/agent-ffi/build-phonebuddy-ios-xcframework.sh checked
the exported C ABI like this:

    if ! nm -g "$lib" 2>/dev/null | grep -q " $symbol$"; then
      die "slice ios-arm64 is missing the exported symbol _pb_version"
    fi

CI run 35428594086 failed exactly there — "missing the exported symbol
_pb_version" — on a slice built from a crate that defines `pb_version`
unconditionally (`#[no_mangle] pub extern "C"`, phone-buddy-ffi/src/lib.rs:214)
and whose Android build of the same revision exports it. The check, not the
library, was wrong, in two independent ways:

  1. `grep -q` exits the instant it matches, while nm is still writing a
     multi-megabyte symbol table for a ~29 MB archive. nm then dies of SIGPIPE,
     and because every script in this repo runs under `set -o pipefail`, the
     *successful* match is reported as a failed pipeline → a present symbol is
     announced as missing. (Same trap for the `2>/dev/null`, which hides why nm
     failed at all.)
  2. A bare `nm` is whatever PATH resolves first. On a runner whose PATH starts
     with Homebrew's binutils that is GNU nm, which cannot read a Mach-O archive:
     it writes nothing to stdout and the real reason to stderr, so *every*
     symbol "looks" missing. nm is therefore resolved explicitly here
     (`xcrun -f nm` → `/usr/bin/nm` → `shutil.which("nm")`).

Nothing here is ever piped: nm runs under subprocess with its own stdout
captured, so the SIGPIPE failure mode cannot come back, and an nm that cannot do
its job is reported with its exit code and stderr instead of being swallowed.

What it checks
--------------
  * the archive really is there for every slice of the xcframework;
  * every `pb_*` function the committed cbindgen header declares is *defined*
    (type letter kept: an undefined `U` reference never counts) in every slice —
    the header is the ABI contract, so the check can never drift from it;
  * each slice's copy of the header describes the same ABI as the committed one;
  * `module.modulemap` is present and names the SwiftPM module;
  * `MinimumOSVersion`, when xcodebuild wrote one, equals the deployment target
    we compiled for.

Usage examples
--------------
  python3 machocheck.py --lib libphone_buddy_ffi.a --header phone_buddy.h
  python3 machocheck.py --lib lib.a --require-symbol pb_version
  python3 machocheck.py --xcframework PhoneBuddyFFI.xcframework \
      --header phone_buddy.h --module-name phone_buddy_ffi \
      --expect-slices ios-arm64 ios-arm64-simulator --deployment-target 15.0

Exit codes: 0 = every requested check passed, 1 = a check failed, 2 = usage/IO
error. The report goes to stdout, failures to stderr.
"""

from __future__ import annotations

import argparse
import os
import plistlib
import re
import shutil
import subprocess
import sys
from pathlib import Path

# nm marks a symbol it only saw as a *reference* with U (or u). Those are not
# exports, so they must never satisfy a "the archive exports X" check.
UNDEFINED_TYPES = {"U", "u"}



class CheckError(Exception):
    """A requested check failed (exit code 1)."""


class UsageError(Exception):
    """Bad invocation, or an input that cannot be read (exit code 2)."""


# ── nm ───────────────────────────────────────────────────────────────────────

def rust_llvm_tools() -> list[str]:
    """`llvm-nm` shipped by the active Rust toolchain, if the component is there.

    This is the reader that *matches the producer*: rustc embeds LLVM's own
    object format, and a reader from a different LLVM generation can refuse it
    outright — Xcode 15.4's nm (LLVM 15) cannot read Rust 1.94 objects
    (LLVM 21) and fails with "Unknown attribute kind (86)", which is what made
    CI run 35447710343 report a healthy archive as unreadable. `rustup component
    add llvm-tools-preview` puts llvm-nm next to the toolchain.
    """
    found: list[str] = []
    try:
        proc = subprocess.run(
            ["rustc", "--print", "sysroot"], capture_output=True, text=True, errors="replace"
        )
        if proc.returncode == 0 and proc.stdout.strip():
            sysroot = Path(proc.stdout.strip())
            found += sorted(str(p) for p in (sysroot / "lib/rustlib").glob("*/bin/llvm-nm"))
    except OSError:
        pass
    home = os.environ.get("HOME")
    if home:
        found += sorted(
            str(p) for p in Path(home).glob(".rustup/toolchains/*/lib/rustlib/*/bin/llvm-nm")
        )
    which = shutil.which("llvm-nm")
    if which:
        found.append(which)
    return found


def resolve_nm_candidates(explicit: str | None = None) -> list[str]:
    """Every plausible nm, best first.

    Apple's nm comes first because the Xcode toolchain is what links the app, but
    it is not the only acceptable reader: when it is older than the LLVM that
    produced the objects it refuses to parse them, and the Rust toolchain's own
    llvm-nm answers the (identical) question correctly. Which one was used is
    printed, so the log never hides it.
    """
    chosen = explicit or os.environ.get("NM_BIN") or None
    if chosen:
        if not Path(chosen).is_file():
            raise UsageError(f"nm not found at {chosen} (--nm/NM_BIN)")
        return [chosen]  # an explicit choice is used and nothing else

    candidates: list[str] = []

    def add(path: str | None) -> None:
        if path and Path(path).is_file() and path not in candidates:
            candidates.append(path)

    try:
        proc = subprocess.run(
            ["xcrun", "-f", "nm"], capture_output=True, text=True, errors="replace"
        )
        if proc.returncode == 0:
            add(proc.stdout.strip())
    except OSError:
        pass  # no xcrun (Linux host)
    add("/usr/bin/nm")
    add(shutil.which("nm"))
    for tool in rust_llvm_tools():
        add(tool)
    if not candidates:
        raise UsageError(
            "no nm found (tried $NM_BIN, `xcrun -f nm`, /usr/bin/nm, $PATH, and the Rust "
            "toolchain's llvm-nm — `rustup component add llvm-tools-preview` provides the last one)"
        )
    return candidates


def parse_nm_output(text: str) -> set[str]:
    """Collect *defined* symbol names from nm output.

    Handles the classic table (`0000000000012340 T _pb_version`), the name-only
    form (`_pb_version`) and archive member headers (`lib.a(obj.o):`).
    """
    found: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.endswith(":"):  # archive member header, not a symbol
            continue
        tokens = line.split()
        if len(tokens) >= 2 and len(tokens[-2]) == 1 and tokens[-2] in UNDEFINED_TYPES:
            continue
        name = tokens[-1]
        found.add(name[1:] if name.startswith("_") else name)
    return found


def read_symbols(nm_candidates: list[str], lib: Path) -> tuple[set[str], str]:
    """Run the first nm that can actually read `lib`; return (symbols, command).

    `nm -g` is preferred because its output is self-describing; the name-only
    `-g -j -U` form is the fallback for nm dialects that dislike the table.
    Every failure is kept, so the message that reaches CI names the tool, its
    exit code and its own words — the thing `2>/dev/null` used to throw away.
    """
    problems: list[str] = []
    for nm in nm_candidates:
        for argv in ([nm, "-g", str(lib)], [nm, "-g", "-j", "-U", str(lib)]):
            proc = subprocess.run(argv, capture_output=True, text=True, errors="replace")
            if proc.returncode == 0 and proc.stdout.strip():
                return parse_nm_output(proc.stdout), " ".join(argv)
            stderr = (proc.stderr or "").strip().splitlines()
            problems.append(
                f"    {' '.join(argv)}\n"
                f"      exit {proc.returncode}"
                + (f" — {stderr[0]}" if stderr else "")
                + ("" if proc.stdout.strip() else " (no symbols on stdout)")
            )
    raise CheckError(
        f"could not read the symbol table of {lib}\n"
        + "\n".join(problems)
        + "\n  hint: a reader older than the LLVM that produced the objects refuses them"
          " ('Unknown attribute kind' above) — build on a runner whose Xcode matches"
          " (macos-26 = LLVM 21), or provide llvm-nm from the Rust toolchain"
          " (`rustup component add llvm-tools-preview`)"
    )


# ── the C header is the ABI contract ─────────────────────────────────────────

def header_symbols(header: Path, prefix: str) -> list[str]:
    """Every `<prefix>…(` function declared in a cbindgen header, sorted."""
    if not header.is_file():
        raise UsageError(f"header not found: {header}")
    text = header.read_text(errors="replace")
    return sorted(set(re.findall(rf"\b({re.escape(prefix)}[a-z0-9_]+)\s*\(", text)))


# ── checks ───────────────────────────────────────────────────────────────────

class Report:
    """Collects one line per checked slice so the pass/fail story is readable."""

    def __init__(self) -> None:
        self.ok = True

    def say(self, message: str) -> None:
        # flush: with stdout piped it is block-buffered while stderr is not, and
        # a failure that arrives before its own report is unreadable in CI logs.
        print(f"  {message}", flush=True)

    def fail(self, message: str) -> None:
        self.ok = False
        sys.stdout.flush()
        print(f"error: {message}", file=sys.stderr)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CheckError(message)


def slice_library_candidates(xcf: Path, slice_dir: Path, entry: dict, lib_name: str) -> list[Path]:
    """Where the static archive may live, most specific first.

    xcodebuild writes `LibraryPath` relative to the slice and usually sets it to
    just the file name (`libphone_buddy_ffi.a`); it has also been seen relative to
    the xcframework root and as plain `.`. All of those are accepted here, and the
    bare slice-relative name is the last resort — getting this wrong is what made
    the first version of this file look for

        .../ios-arm64-simulator/libphone_buddy_ffi.a/libphone_buddy_ffi.a

    and report a perfectly good slice as missing its library (CI run 35446801538).
    """
    candidates: list[Path] = []
    declared = entry.get("LibraryPath")
    if declared:
        path = Path(str(declared))
        if path.is_absolute():
            candidates.append(path)
        else:
            candidates.append(slice_dir / path)  # spec: relative to the slice
            candidates.append(xcf / path)        # seen: relative to the framework
    candidates.append(slice_dir / lib_name)
    unique: list[Path] = []
    for candidate in candidates:
        if candidate not in unique:
            unique.append(candidate)
    return unique


def resolve_headers_root(xcf: Path, slice_dir: Path, entry: dict) -> Path:
    """The slice's Headers directory, wherever this xcframework keeps it."""
    declared = str(entry.get("HeadersPath") or "Headers")
    for candidate in (slice_dir / declared, xcf / declared, slice_dir / "Headers"):
        if candidate.is_dir():
            return candidate
    return slice_dir / declared


def check_library(
    label: str,
    lib_candidates: list[Path],
    required: list[str],
    nm_candidates: list[str],
    report: Report,
    symbol_prefix: str,
    slice_header: Path | None = None,
    header_syms: list[str] | None = None,
    module_map: Path | None = None,
    module_name: str | None = None,
) -> None:
    lib = next((candidate for candidate in lib_candidates if candidate.is_file()), None)
    if lib is None:
        raise CheckError(
            f"{label}: no static library found — looked for\n"
            + "\n".join(f"    {candidate}" for candidate in lib_candidates)
        )

    if module_map is not None:
        require(module_map.is_file(), f"{label}: missing {module_map.name} ({module_map})")
        map_text = module_map.read_text(errors="replace")
        require(
            f"module {module_name}" in map_text,
            f"{label}: {module_map.name} does not declare `module {module_name}` "
            "(Swift imports the module by that name)",
        )
        report.say(f"{label}: module.modulemap declares `module {module_name}`")

    if slice_header is not None and header_syms is not None:
        require(slice_header.is_file(), f"{label}: missing {slice_header.name} ({slice_header})")
        shipped = header_symbols(slice_header, symbol_prefix)
        absent = sorted(set(header_syms) - set(shipped))
        extra = sorted(set(shipped) - set(header_syms))
        require(
            not absent and not extra,
            f"{label}: the shipped {slice_header.name} describes a different ABI than the "
            f"committed header (missing: {absent or 'none'}; extra: {extra or 'none'})",
        )
        report.say(f"{label}: shipped header matches the committed ABI ({len(shipped)} functions)")

    symbols, command = read_symbols(nm_candidates, lib)
    missing = [name for name in required if name not in symbols]
    report.say(f"{label}: {len(required) - len(missing)}/{len(required)} declared C-ABI symbols exported"
               f" ({lib.name}, via `{command}`)")
    if missing:
        exported = sorted(name for name in symbols if name.startswith("pb_"))
        raise CheckError(
            f"{label}: {lib.name} does not export: {', '.join(missing)}\n"
            f"    pb_* symbols it does export: {', '.join(exported) or 'none'}"
        )


def check_plist_slices(xcf: Path, args, report: Report) -> list[dict]:
    info_path = xcf / "Info.plist"
    require(info_path.is_file(), f"{xcf} has no Info.plist — not an xcframework")
    info = plistlib.loads(info_path.read_bytes())
    entries = info.get("AvailableLibraries") or []
    require(bool(entries), f"{xcf}/Info.plist lists no AvailableLibraries")

    ids = sorted(str(e.get("LibraryIdentifier", "?")) for e in entries)
    report.say(f"slices: {', '.join(ids)}")
    if args.expect_slices:
        absent = [s for s in args.expect_slices if s not in ids]
        require(not absent, f"xcframework is missing expected slice(s) {absent} (found {ids})")

    if args.deployment_target:
        for entry in entries:
            ident = str(entry.get("LibraryIdentifier", "?"))
            declared = entry.get("MinimumOSVersion")
            if declared is None:
                # xcodebuild only writes MinimumOSVersion when it can pin one
                # value for the whole archive. A Rust staticlib always mixes
                # objects: prebuilt libstd carries rustc's own (older) minimum,
                # our code and the cc-rs C sources carry IPHONEOS_DEPLOYMENT_TARGET
                # (= the deployment target below). So *absence* is expected and
                # fine; a *different* value is not.
                report.say(
                    f"{ident}: MinimumOSVersion not declared (archive mixes per-object "
                    f"minimums — consumers must target iOS {args.deployment_target}+)"
                )
            elif str(declared) != str(args.deployment_target):
                raise CheckError(
                    f"{ident}: xcodebuild recorded MinimumOSVersion={declared}, "
                    f"but the library was compiled for iOS {args.deployment_target}"
                )
            else:
                report.say(f"{ident}: MinimumOSVersion={declared}")
    return entries


def check_xcframework(xcf: Path, args, nm_candidates: list[str], required: list[str],
                      header_syms: list[str], report: Report) -> None:
    require(xcf.is_dir(), f"xcframework not found: {xcf}")
    entries = check_plist_slices(xcf, args, report)

    for entry in entries:
        ident = str(entry.get("LibraryIdentifier", "?"))
        slice_dir = xcf / ident
        module_dir = resolve_headers_root(xcf, slice_dir, entry) / args.module_name
        check_library(
            label=ident,
            lib_candidates=slice_library_candidates(xcf, slice_dir, entry, args.lib_name),
            required=required,
            nm_candidates=nm_candidates,
            report=report,
            symbol_prefix=args.symbol_prefix,
            slice_header=module_dir / "phone_buddy.h",
            header_syms=header_syms,
            module_map=module_dir / "module.modulemap",
            module_name=args.module_name,
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="machocheck.py",
        description="Verify that a Mach-O archive / xcframework exports the C ABI its header declares.",
    )
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--lib", help="a single Mach-O static archive to inspect")
    target.add_argument("--xcframework", help="an .xcframework directory: every slice is inspected")
    parser.add_argument("--header", help="cbindgen header = the declared ABI (all its functions are required)")
    parser.add_argument("--require-symbol", action="append", default=[],
                        help="an extra symbol the archive must export (repeatable)")
    parser.add_argument("--symbol-prefix", default="pb_",
                        help="function-name prefix picked up from --header (default: pb_)")
    parser.add_argument("--module-name", default="phone_buddy_ffi",
                        help="SwiftPM module whose headers live under Headers/<module>/ (default: phone_buddy_ffi)")
    parser.add_argument("--lib-name", default=None,
                        help="archive file name inside each slice (default: lib<module-name without _ffi>.a)")
    parser.add_argument("--expect-slices", nargs="+", default=[],
                        help="slice identifiers that must exist (extras are allowed)")
    parser.add_argument("--deployment-target", default=None,
                        help="expected MinimumOSVersion, e.g. 15.0 (a missing key is accepted, see below)")
    parser.add_argument("--nm", default=None, help="nm to use (default: xcrun -f nm, /usr/bin/nm, $PATH)")
    args = parser.parse_args(argv)

    if args.lib_name is None:
        args.lib_name = f"lib{args.module_name}.a"

    header_syms: list[str] = []
    if args.header:
        header_syms = header_symbols(Path(args.header), args.symbol_prefix)
        if not header_syms:
            raise UsageError(
                f"{args.header} declares no `{args.symbol_prefix}…(` function — wrong header or prefix?"
            )
    required = sorted(set(header_syms) | set(args.require_symbol))
    if not required:
        raise UsageError("nothing to check: pass --header and/or --require-symbol")

    nm_candidates = resolve_nm_candidates(args.nm)
    report = Report()
    report.say("nm candidates: " + ", ".join(nm_candidates))

    if args.xcframework:
        check_xcframework(Path(args.xcframework), args, nm_candidates, required, header_syms, report)
    else:
        check_library(
            label=Path(args.lib).name,
            lib_candidates=[Path(args.lib)],
            required=required,
            nm_candidates=nm_candidates,
            report=report,
            symbol_prefix=args.symbol_prefix,
        )

    if not report.ok:
        return 1
    print(f"ok: {len(required)} declared C-ABI symbols verified")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except CheckError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(1)
    except UsageError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(2)
    except KeyboardInterrupt:
        sys.exit(130)
