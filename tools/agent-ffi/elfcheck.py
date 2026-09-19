#!/usr/bin/env python3
"""Dependency-free ELF inspector used by the NativeKit FFI build/verify tooling.

Why this exists: Android build hosts, CI images and Termux do not always have
`readelf`/`nm` (binutils) installed, and even when they do the flag spellings
differ (llvm-readelf vs GNU readelf). Everything this toolkit needs — the ELF
class, the machine, the LOAD-segment page alignment, the ARM float ABI flag and
the presence of a dynamic symbol — can be read straight out of the file with the
standard library, so we do exactly that.

Usage examples
--------------
  python3 elfcheck.py libnative_agent_ffi.so
  python3 elfcheck.py --expect-abi armeabi-v7a libnative_agent_ffi.so
  python3 elfcheck.py --expect-abi arm64-v8a --require-symbol \
      uniffi_native_agent_ffi_checksum_func_init_workspace --min-page-align 16384 foo.so
  python3 elfcheck.py --json libnative_agent_ffi.so

Exit codes: 0 = all requested checks passed, 1 = a check failed, 2 = usage/IO
error. Human-readable report goes to stdout; with --json only JSON is printed.
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys

# ── ABI table ────────────────────────────────────────────────────────────────
# abi -> (elf_class, e_machine, expected endianness, human machine name)
ABI_TABLE = {
    "arm64-v8a": (64, 183, "little", "AArch64"),
    "armeabi-v7a": (32, 40, "little", "ARM"),
    "armeabi": (32, 40, "little", "ARM"),
    "x86_64": (64, 62, "little", "x86-64"),
    "x86": (32, 3, "little", "Intel 80386"),
    "riscv64": (64, 243, "little", "RISC-V"),
}

EM_NAMES = {
    3: "Intel 80386",
    8: "MIPS",
    20: "PowerPC",
    21: "PowerPC64",
    40: "ARM",
    62: "x86-64",
    183: "AArch64",
    243: "RISC-V",
}

# ELF32 ARM e_flags: 0x200 = soft-float ABI, 0x400 = hard-float ABI.
EF_ARM_ABI_FLOAT_SOFT = 0x00000200
EF_ARM_ABI_FLOAT_HARD = 0x00000400

PT_LOAD = 1
SHT_DYNSYM = 11
SHT_SYMTAB = 2


class ElfError(Exception):
    pass


def _rd(data: bytes, off: int, fmt: str):
    size = struct.calcsize(fmt)
    if off + size > len(data):
        raise ElfError("truncated ELF file")
    return struct.unpack_from(fmt, data, off)


def inspect(path: str, want_symbols: bool = True) -> dict:
    with open(path, "rb") as fh:
        data = fh.read()

    if len(data) < 64 or data[:4] != b"\x7fELF":
        raise ElfError(f"{path}: not an ELF file")

    ei_class = data[4]
    ei_data = data[5]
    if ei_class not in (1, 2):
        raise ElfError(f"{path}: unknown ELF class {ei_class}")
    if ei_data not in (1, 2):
        raise ElfError(f"{path}: unknown ELF data encoding {ei_data}")

    bits = 64 if ei_class == 2 else 32
    endian = "<" if ei_data == 1 else ">"

    if bits == 64:
        (e_type, e_machine, _e_version, _e_entry, e_phoff, e_shoff, e_flags,
         _e_ehsize, e_phentsize, e_phnum, e_shentsize, e_shnum, e_shstrndx) = _rd(
            data, 16, endian + "HHIQQQIHHHHHH")
    else:
        (e_type, e_machine, _e_version, _e_entry, e_phoff, e_shoff, e_flags,
         _e_ehsize, e_phentsize, e_phnum, e_shentsize, e_shnum, e_shstrndx) = _rd(
            data, 16, endian + "HHIIIIIHHHHHH")

    # ── LOAD segments: page alignment matters for Android 15+ 16 KB pages ────
    loads = []
    for i in range(e_phnum):
        off = e_phoff + i * e_phentsize
        if bits == 64:
            p_type, p_flags, p_offset, _p_vaddr, _p_paddr, p_filesz, _p_memsz, p_align = _rd(
                data, off, endian + "IIQQQQQQ")
        else:
            p_type, p_offset, _p_vaddr, _p_paddr, p_filesz, _p_memsz, p_flags, p_align = _rd(
                data, off, endian + "IIIIIIII")
        if p_type == PT_LOAD:
            loads.append({
                "offset": p_offset,
                "filesz": p_filesz,
                "flags": p_flags,
                "align": p_align,
            })

    max_align = max((l["align"] for l in loads), default=0)

    # ── section headers + dynamic symbols ───────────────────────────────────
    sections = []
    for i in range(e_shnum):
        off = e_shoff + i * e_shentsize
        if bits == 64:
            sh_name, sh_type, _sh_flags, _sh_addr, sh_offset, sh_size, sh_link, _sh_info, _sh_addralign, sh_entsize = _rd(
                data, off, endian + "IIQQQQIIQQ")
        else:
            sh_name, sh_type, _sh_flags, _sh_addr, sh_offset, sh_size, sh_link, _sh_info, _sh_addralign, sh_entsize = _rd(
                data, off, endian + "IIIIIIIIII")
        sections.append({
            "name_off": sh_name, "type": sh_type, "offset": sh_offset,
            "size": sh_size, "link": sh_link, "entsize": sh_entsize,
        })

    strtab = b""
    if 0 <= e_shstrndx < len(sections):
        sh = sections[e_shstrndx]
        strtab = data[sh["offset"]:sh["offset"] + sh["size"]]

    def sh_name(idx: int) -> str:
        end = strtab.find(b"\0", idx)
        return strtab[idx:end if end != -1 else len(strtab)].decode("utf-8", "replace")

    for s in sections:
        s["name"] = sh_name(s["name_off"])

    dynsym_names: list[str] = []
    if want_symbols:
        for s in sections:
            if s["type"] not in (SHT_DYNSYM, SHT_SYMTAB) or not s["entsize"]:
                continue
            dstr = b""
            if 0 <= s["link"] < len(sections):
                link = sections[s["link"]]
                dstr = data[link["offset"]:link["offset"] + link["size"]]
            count = s["size"] // s["entsize"]
            for i in range(count):
                off = s["offset"] + i * s["entsize"]
                if bits == 64:
                    st_name, _st_info, _st_other, _st_shndx = _rd(data, off, endian + "IBBH")
                else:
                    st_name, _st_value, _st_size, _st_info, _st_other, _st_shndx = _rd(
                        data, off, endian + "IIIBBH")
                if not st_name:
                    continue
                end = dstr.find(b"\0", st_name)
                nm = dstr[st_name:end if end != -1 else len(dstr)].decode("utf-8", "replace")
                if nm:
                    dynsym_names.append(nm)

    # ── stripped? ───────────────────────────────────────────────────────────
    stripped = not any(s["type"] == SHT_SYMTAB for s in sections)

    arm_float_abi = None
    if e_machine == 40:  # ARM
        if e_flags & EF_ARM_ABI_FLOAT_HARD:
            arm_float_abi = "hard"
        elif e_flags & EF_ARM_ABI_FLOAT_SOFT:
            arm_float_abi = "softfp"
        else:
            arm_float_abi = "unknown"

    return {
        "path": os.path.abspath(path),
        "bytes": len(data),
        "bits": bits,
        "endian": "little" if endian == "<" else "big",
        "type": e_type,
        "machine": e_machine,
        "machineName": EM_NAMES.get(e_machine, f"unknown({e_machine})"),
        "flags": e_flags,
        "loadTls": loads,
        "maxLoadAlign": max_align,
        "stripped": stripped,
        "armFloatAbi": arm_float_abi,
        "dynamicSymbols": dynsym_names,
    }


def abi_of(info: dict) -> str | None:
    for abi, (bits, machine, _end, _nm) in ABI_TABLE.items():
        if abi == "armeabi":
            continue
        if info["bits"] == bits and info["machine"] == machine:
            return abi
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="Inspect an ELF shared library (Android ABIs).")
    ap.add_argument("files", nargs="+")
    ap.add_argument("--expect-abi", help="fail unless every file matches this Android ABI")
    ap.add_argument("--require-symbol", action="append", default=[],
                    help="fail unless this dynamic symbol is exported (repeatable)")
    ap.add_argument("--require-page-align", type=int, default=0,
                    help="fail unless every LOAD segment is aligned to at least this many bytes")
    ap.add_argument("--max-page-align", type=int, default=0,
                    help="fail if any LOAD segment needs MORE than this alignment")
    ap.add_argument("--allow-hard-float", action="store_true",
                    help="do not fail on an ARM hard-float (incompatible with Android) binary")
    ap.add_argument("--json", action="store_true", help="machine-readable output only")
    args = ap.parse_args()

    failures: list[str] = []
    reports: list[dict] = []

    for path in args.files:
        try:
            info = inspect(path, want_symbols=True)
        except (ElfError, OSError) as exc:
            failures.append(str(exc))
            continue

        detected = abi_of(info)
        # armeabi-v7a and armeabi share the machine type; the toolchain never
        # produces a true `armeabi` (no-NEON) Rust target, so treat both as v7a.
        info["abi"] = detected
        info["symbolCount"] = len(info["dynamicSymbols"])
        reports.append(info)

        label = f"{os.path.basename(path)}"

        if args.expect_abi:
            if detected != args.expect_abi:
                failures.append(
                    f"{label}: ELF is {info['bits']}-bit {info['machineName']} "
                    f"({detected or 'unrecognised ABI'}) but {args.expect_abi} was expected")

        for sym in args.require_symbol:
            if sym not in info["dynamicSymbols"]:
                failures.append(f"{label}: required symbol '{sym}' not exported")

        if args.require_page_align and info["maxLoadAlign"] < args.require_page_align:
            failures.append(
                f"{label}: max LOAD alignment is 0x{info['maxLoadAlign']:x} but "
                f"0x{args.require_page_align:x} is required (Android 15+ 16 KB pages)")

        if args.max_page_align and info["maxLoadAlign"] > args.max_page_align:
            failures.append(
                f"{label}: LOAD alignment 0x{info['maxLoadAlign']:x} exceeds the "
                f"supported maximum 0x{args.max_page_align:x}")

        if info["armFloatAbi"] == "hard" and not args.allow_hard_float:
            failures.append(
                f"{label}: built with the ARM *hard-float* ABI — Android armeabi-v7a "
                "requires the softfp ABI (rebuild with the NDK clang wrapper)")

    if args.json:
        print(json.dumps({"reports": reports, "failures": failures}, indent=2))
    else:
        for info in reports:
            print(f"{os.path.basename(info['path'])}")
            print(f"  abi          : {info['abi'] or 'unrecognised'}")
            print(f"  class/machine: {info['bits']}-bit {info['machineName']} "
                  f"({info['endian']}-endian)")
            print(f"  size         : {info['bytes']:,} bytes")
            print(f"  stripped     : {info['stripped']}")
            print(f"  load align   : 0x{info['maxLoadAlign']:x}")
            if info["armFloatAbi"]:
                print(f"  arm float abi: {info['armFloatAbi']}")
            print(f"  dyn symbols  : {info['symbolCount']}")
        for f in failures:
            print(f"FAIL: {f}", file=sys.stderr)

    if failures and not reports and not args.json:
        pass
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
