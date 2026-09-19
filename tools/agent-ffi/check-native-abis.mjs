#!/usr/bin/env node
/**
 * check-native-abis.mjs — "will every Android device class get the native agent?"
 *
 * Pure-Node companion to tools/agent-ffi/verify-abis.sh (no python needed, so it
 * runs inside `npm run` and on any dev machine). It reads the plugin jniLibs
 * trees, and — with `--apk`/`--aab` — the real packaged artefact, using the
 * already-present `fflate` dependency to list zip entries.
 *
 *   node tools/agent-ffi/check-native-abis.mjs
 *   node tools/agent-ffi/check-native-abis.mjs --strict
 *   node tools/agent-ffi/check-native-abis.mjs --apk android/app/build/outputs/apk/debug/app-debug.apk
 *
 * Exit codes: 0 = fine (warnings allowed), 1 = --strict failure, 2 = bad usage.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

const KNOWN_ABIS = ['arm64-v8a', 'armeabi-v7a', 'armeabi', 'x86_64', 'x86', 'riscv64']
const DEFAULT_EXPECT = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86']
const DEVICE_NOTE = {
  'arm64-v8a': 'modern phones',
  'armeabi-v7a': '32-bit-only phones (budget/older devices)',
  armeabi: 'ancient 32-bit ARM (no NEON)',
  x86_64: '64-bit emulators / Intel hosts',
  x86: 'legacy 32-bit emulators',
  riscv64: 'future RISC-V devices',
}

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const valueOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

if (flag('-h') || flag('--help')) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim())
  process.exit(0)
}

const required = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--require-lib' && argv[i + 1]) required.push(argv[i + 1])
}
if (required.length === 0) required.push('libnative_agent_ffi.so')

const strict = flag('--strict')
const apk = valueOf('--apk')
const aab = valueOf('--aab')

/** { abi: Set(libName) } from zip entries of an APK/AAB */
async function fromZip(file) {
  let unzipSync
  try {
    ;({ unzipSync } = await import('fflate'))
  } catch {
    console.error('error: fflate is not installed (npm ci) — cannot read an APK/AAB.')
    process.exit(2)
  }
  const buf = readFileSync(file)
  const entries = unzipSync(new Uint8Array(buf))
  const out = {}
  for (const name of Object.keys(entries)) {
    const parts = name.split('/')
    let abi
    if (parts.length >= 3 && parts[0] === 'lib') abi = parts[1]
    else if (parts.length >= 4 && parts[1] === 'lib') abi = parts[2]
    else continue
    if (!parts[parts.length - 1].endsWith('.so')) continue
    ;(out[abi] ??= new Set()).add(parts[parts.length - 1])
  }
  return out
}

/** { abi: Set(libName) } from source jniLibs trees */
function fromJniLibs(roots, expect) {
  const out = {}
  for (const root of roots) {
    let dirs
    try {
      dirs = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirs) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue
      for (const f of readdirSync(join(root, d.name))) {
        if (f.endsWith('.so')) (out[d.name] ??= new Set()).add(f)
      }
    }
  }
  for (const abi of expect) out[abi] ??= new Set()
  return out
}

let data
let target
if (apk || aab) {
  const file = resolve(apk ?? aab)
  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
    console.error(`error: file not found: ${file}`)
    process.exit(2)
  }
  data = await fromZip(file)
  target = file
} else {
  const roots = []
  const pluginsDir = join(REPO_ROOT, 'plugins')
  try {
    for (const p of readdirSync(pluginsDir)) {
      const cand = join(pluginsDir, p, 'android', 'src', 'main', 'jniLibs')
      if (statSync(cand, { throwIfNoEntry: false })?.isDirectory()) roots.push(cand)
    }
  } catch { /* no plugins dir */ }
  const appJni = join(REPO_ROOT, 'android', 'app', 'src', 'main', 'jniLibs')
  if (statSync(appJni, { throwIfNoEntry: false })?.isDirectory()) roots.push(appJni)
  if (roots.length === 0) {
    console.error('error: no jniLibs directories found — run this from the repository.')
    process.exit(2)
  }
  data = fromJniLibs(roots, DEFAULT_EXPECT)
  target = roots.map((r) => relative(process.cwd(), r) || r).join(', ')
}

const order = (a) => {
  const i = KNOWN_ABIS.indexOf(a)
  return i === -1 ? 99 : i
}
const abis = Object.keys(data).sort((a, b) => order(a) - order(b) || a.localeCompare(b))

const full = []
const partial = []
const width = Math.max(3, ...abis.map((a) => a.length)) + 2

console.log(`Native ABI coverage — ${target}`)
console.log(`required library    : ${required.join(', ')}\n`)
console.log(`  ${'ABI'.padEnd(width)}${'status'.padEnd(10)}libs`)
console.log(`  ${'-'.repeat(width)}${'-'.repeat(9)} ${'-'.repeat(40)}`)
for (const abi of abis) {
  const libs = [...(data[abi] ?? new Set())].sort()
  const missing = required.filter((r) => !libs.includes(r))
  ;(missing.length ? partial : full).push(abi)
  console.log(`  ${abi.padEnd(width)}${(missing.length ? 'MISSING' : 'FULL').padEnd(10)}${libs.join(', ')}`)
  if (missing.length) {
    console.log(`  ${' '.repeat(width)}          ↳ missing ${missing.join(', ')} — ${DEVICE_NOTE[abi] ?? abi} will see checkAvailability().available=false (no crash)`)
  }
}

console.log()
console.log(`  agent engine available on : ${full.join(', ') || 'NO ABI'}`)
console.log(`  agent engine MISSING on   : ${partial.join(', ') || '(none)'}\n`)

if (partial.length) {
  const builder = required.some((r) => r.includes('phone_buddy'))
    ? 'tools/agent-ffi/build-phonebuddy-all-abis.sh'
    : 'tools/agent-ffi/build-android-all-abis.sh'
  console.log('  Fix: ' + builder + ' --abis "' + partial.join(' ') + '"')
  if (required.includes('libnative_agent_ffi.so')) {
    const crate = join(REPO_ROOT, 'plugins/native-agent/rust/native-agent-ffi/Cargo.toml')
    console.log(statSync(crate, { throwIfNoEntry: false })?.isFile()
      ? '       (crate source is already vendored — just run the build)'
      : '       (the Rust crate must be vendored first — tools/agent-ffi/README.bn.md)')
  } else {
    console.log('       (public Apache-2.0 source — no secrets required)')
  }
  console.log()
}

if (strict && partial.length) {
  console.error(`check-native-abis: FAILED (--strict) — ${partial.length} ABI(s) without ${required.join('/')}`)
  process.exit(1)
}
if (partial.length) console.warn('check-native-abis: warning — some device ABIs have no native agent engine.')
else console.log('check-native-abis: OK — every ABI carries all required native libraries. ✅')
