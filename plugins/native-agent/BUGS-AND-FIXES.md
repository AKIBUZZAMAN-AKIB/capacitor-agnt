# Deep audit: bugs found & fixed (v0.9.14)

This document records the full code audit of the repository (Android Kotlin
plugin, iOS Swift plugin, generated UniFFI bindings, TypeScript layer,
Gradle/CocoaPods/SwiftPM packaging, build scripts) and every fix shipped in
this revision.

Verification performed offline (no Android SDK / Xcode / Rust submodule in
the audit environment):

- **Kotlin**: full `kotlinc 1.9.25` compile of the generated UniFFI binding
  plus all core plugin sources against real `android.jar` (API 34), real JNA
  5.14, real kotlinx-coroutines 1.8.1, and API-faithful Capacitor stubs →
  **zero errors**. (This caught 3 real issues in the new code before they
  shipped.)
- **TypeScript**: `tsc` strict build + committed `dist/` verified in sync.
- **Shell**: `bash -n` on all scripts.
- **Swift**: careful manual review against the generated binding signatures
  (no iOS toolchain available in the audit environment).

---

## Critical (crashes / broken builds / broken contracts)

### C1. Android crash on unsupported ABI — `UnsatisfiedLinkError` uncaught (all devices)
**Where:** `NativeAgentPlugin.kt` (all `catch (e: Exception)` blocks).
**What:** The UniFFI/JNA binding loads `libnative_agent_ffi.so` lazily on
first use. On a device whose ABI has no `.so` in the package (a 32-bit phone
with only `arm64-v8a`, an x86_64 emulator, ...), the load throws
`UnsatisfiedLinkError` — which is an `Error`, **not** an `Exception`. It
escaped every `catch (e: Exception)`, killed the coroutine with an uncaught
fatal error → **app crash** — and afterwards the dead coroutine scope made
every subsequent JS call hang forever (promise never settles).
**Fix:** all plugin paths catch `Throwable` (re-throwing `OutOfMemoryError`),
scope liveness is checked before launching, and `initialize()` produces a
clear, actionable JS error ("missing .so for ABI X — run
scripts/build-android.sh") instead of crashing. New
`checkAvailability()` lets apps detect the situation *before* calling
`initialize()`.

### C2. Plugin module unbuildable without capacitor-lancedb (Android)
**Where:** `android/build.gradle` (`compileOnly project(':capacitor-lancedb')`).
**What:** the Gradle project reference was unconditional, but
`package.json` declares `capacitor-lancedb` **optional**
(`peerDependenciesMeta`). Any app that did not include capacitor-lancedb
failed at Gradle configuration — the plugin could not even be compiled.
**Fix:** the LanceDB-dependent Kotlin sources (`MemoryProviderImpl.kt`,
`LanceDBBridge.kt`) moved to a `src/main/java-memory/` source set that is
added **only** when `project.findProject(':capacitor-lancedb')` exists; the
core plugin wires the memory provider **reflectively**
(`NativeAgentRegistry.createMemoryProvider`), so there is no compile-time
reference at all.

### C3. SwiftPM manifest unresolvable without capacitor-lancedb (iOS)
**Where:** `Package.swift` (`.package(path: "../capacitor-lancedb")` + hard
product dependency).
**What:** the local path dependency made SwiftPM package resolution fail for
every host without the optional capacitor-lancedb sibling — the plugin was
**unusable via SwiftPM at all**.
**Fix:** the hard dependency is removed; the LanceDB sources already guard
on `#if canImport(...)` and fall back to a no-op `MemoryProviderImpl`, so
the package resolves for everyone and memory degrades gracefully.

### C4. CocoaPods build broken: podspec pointed at a nonexistent modulemap
**Where:** `CapacitorNativeAgent.podspec`.
**What:** `OTHER_SWIFT_FLAGS` referenced
`ios-arm64/Headers/native_agent_ffiFFI.modulemap`, but the actual file is
`ios-arm64/Headers/native_agent_ffi/module.modulemap` (nested subdir created
by `build-ios.sh`). The Swift compiler was handed a dead path, so
`canImport(native_agent_ffiFFI)` could not resolve → CocoaPods-based iOS
builds broken.
**Fix:** both SDK flags (device + simulator) point at the real nested
modulemap paths.

### C5. iOS `resumeSession` dropped `wasInterrupted` — JS contract broken
**Where:** `NativeAgentPlugin.swift`.
**What:** the TS contract is `Promise<{ wasInterrupted: boolean }>` and
Android returns it; iOS called the FFI (which returns `Bool`) and resolved
`undefined`. Hosts branching on `wasInterrupted` misbehaved on iOS only.
**Fix:** capture and return the value.

### C6. No process-wide handle — duplicate native engines per webview (both platforms)
**Where:** `NativeAgentPlugin.kt` (per-instance `handle` field) and
`NativeAgentPlugin.swift` (per-instance `handle` property + `deinit` clearing
the bridge handle).
**What:** Capacitor creates one plugin instance per bridge; multi-activity /
multi-webview apps (or activity re-creation) opened **multiple Rust handles
on the same SQLite DB** — duplicate schedulers, double notifications, DB
contention. On Android the old handle was only released by GC timing; on
iOS, one webview's `deinit` cleared the process-wide bridge handle out from
under other consumers.
**Fix:** new `NativeAgentRegistry` (Android) / `processHandle` (iOS) — a
single, lock-protected, process-wide handle. Re-initialize explicitly frees
the previous handle (UniFFI cleaner / ARC deinit). The FFI event sink is
held **weakly** on Android so a destroyed webview is never pinned by the Rust
callback. `handleOnDestroy` no longer tears down shared state.

### C7. "Background execution" claimed in README but no background component shipped
**Where:** repo-wide (no WorkManager/JobService class, no manifest entry,
saved config only contained the workspace config path).
**What:** `handleWake()` is a JS-bridge method — with the WebView gone there
was no way to re-enter the engine, so background cron/heartbeat did not work
out of the box. The saved prefs couldn't even reconstruct a handle (missing
db/auth paths).
**Fix:**
- Android: dependency-free `NativeAgentJobService` (framework `JobService`,
  no androidx) + `NativeAgentSchedule` (periodic job, network-gated,
  persisted across reboots) + `initialize()` now saves the **full** config
  JSON so the service can restore a handle headless + service registered in
  the plugin's merged `AndroidManifest.xml`.
- iOS: `NativeAgentBackgroundTask` (BGProcessingTask) restores the full
  config from UserDefaults; the Info.plist requirement is **probed before
  scheduling** so an unconfigured app gets a clean error instead of an
  ObjC-exception crash.
- New JS API: `scheduleBackgroundWakes()`, `cancelBackgroundWakes()`.

---

## Moderate

### M1. Android `resolvePath` never created directories (iOS did)
Fresh installs with `files://` paths whose parent didn't exist failed in the
Rust engine (SQLite can't create a DB in a missing directory). Android now
creates the directory (extension-less paths) or its parent (file paths),
matching iOS behavior.

### M2. Notification id collision swallowed cron notifications (Android)
`System.currentTimeMillis() % Int.MAX_VALUE` → two notifications in the same
millisecond shared an id; the second silently replaced the first. Now an
`AtomicInteger` with a random per-process base. Also added a synchronous
`areNotificationsEnabled()` probe so denied permission returns a proper
error JSON instead of a fake success.

### M3. Privacy: session keys logged to logcat at INFO
`Log.i("TRACE:kt", "sendMessage sessionKey=...")` in production code. Now
behind a `DEBUG = false` gate.

### M4. R8/minify could break the JNA FFI surface in host release builds
No consumer ProGuard rules shipped. Added `android/consumer-rules.pro`
(keep JNA, UniFFI binding, plugin packages) and wired it via
`consumerProguardFiles`.

### M5. Phantom TS API: `SendMessageParams.extraToolsJson`
Documented in `definitions.ts` but **does not exist** in the generated UniFFI
`SendMessageParams` (verified in the binding) — it was silently ignored on
every platform. Removed from the TS contract.

### M6. TS contract stricter than native defaults
`loadSession.agentId`, `handleWake.source`, `setToolPermission.enabled`,
`startSkill.configJson` are marked required in TS but have native defaults
(`"main"` / `"unknown"` / `true` / `"{}"`). Now optional, matching both
platforms.

### M7. iOS notifier was fire-and-forget with a non-JSON result
No delivery-failure logging, and it returned a bare UUID string while Android
returns JSON — Rust-side consumers saw two shapes. Now returns the same JSON
shape and logs `UNUserNotificationCenter` delivery failures.

### M8. No double-initialize guard (both platforms)
Calling `initialize()` twice leaked/replaced native state implicitly. Both
platforms now release the previous handle deterministically before creating
the new one.

### M9. Stale upstream org in podspec metadata
`homepage`/`source` pointed at `ArcadeLabsInc` (template leftover) — broke
`pod` tooling and mis-attributed the source. Fixed to `rogelioRuiz`.

---

## Lightweight

### L1. Multi-ABI build = bigger APK? No, not on Play
New `scripts/build-android.sh` builds all ABIs; publish an **AAB** and Play
splits per ABI, so shipping `armeabi-v7a` + `x86_64` costs ~0 on the Play
Store (each user gets only their `.so`). For direct-APK distribution, use
`ndk { abiFilters }` to trim.

### L2. Rust release profile hardened in the build scripts
`opt-level=s`, `lto=thin`, `codegen-units=1`, `strip=symbols` (Android adds
strip at link; iOS is a staticlib) — expected 10–25% binary reduction on
future rebuilds (the shipped 0.9.14 binaries were built with the old
profile; rebuild via the submodule to benefit). `SIZE_OPT_LEVEL=3` restores
max performance if size isn't the priority.

### L3. Removed duplicated generated Swift from xcframework slices (~250KB)
`build-ios.sh` used to copy `native_agent_ffi.swift` into **each** slice's
Headers "for IDE use" — pure duplication of the file already shipped under
`ios/Sources/NativeAgentPlugin/Generated/`. Removed from both slices and the
build script.

### L4. Background machinery is dependency-free
No androidx.work added (framework `JobService` / `BGTaskScheduler` only) —
the plugin's footprint grows by a few KB of Kotlin/Swift, not megabytes of
AARs.

### L5. Optional LanceDB coupling removed from packaging
See C2/C3 — the default build no longer drags in (or breaks without) the
vector-DB integration.

---

## All-devices coverage

| Surface | Before | After |
|---|---|---|
| Android arm64-v8a | shipped | shipped (required ABI) |
| Android armeabi-v7a | **missing** (crash on 32-bit phones) | built by script; missing at runtime → clean JS error + `checkAvailability()` |
| Android x86_64 | missing (emulators) | built by script |
| Android x86 | missing (legacy emulators) | built by script (best-effort) |
| iOS device (all hardware arm64) | shipped | shipped |
| iOS Apple Silicon simulator | shipped | shipped |
| iOS Intel simulator | missing | built by script when possible (best-effort slice) |
| Android API level | minSdk 23 (Capacitor floor) | unchanged — documented (the `.so` itself targets API 21) |
| Unsupported ABI behavior | **native crash + hung promises** | `checkAvailability()` probe + clean `initialize()` reject |

Runtime guardrails that make "all devices" hold even when a binary is
missing: C1 (graceful load failure), the registry (C6), the background
service catching `Throwable` (C7), and `verify-release.sh` (reports exactly
which ABIs are in the package before publish).

---

## New / changed public surface (0.9.14)

Added to `NativeAgentPlugin` (TS/Kotlin/Swift, parity):
- `checkAvailability(): Promise<AvailabilityInfo>`
- `scheduleBackgroundWakes(options?: { intervalMinutes?: number }): Promise<BackgroundWakeScheduleResult>`
- `cancelBackgroundWakes(): Promise<{ cancelled: boolean }>`

Changed:
- `SendMessageParams.extraToolsJson` — **removed** (phantom, M5)
- `loadSession`, `handleWake`, `setToolPermission`, `startSkill` options —
  fields made optional to match native defaults (M6)

Everything else is wire-compatible: all 44 existing plugin methods keep their
names, parameters and result shapes on both platforms.

## Known limitations (unchanged / out of scope)

- The Rust FFI crate lives in a **private GitLab submodule**; the audit
  environment could not rebuild the native binaries, so the published 0.9.14
  `.so`/xcframework are the prebuilt 0.9.13 artifacts. Run
  `scripts/build-android.sh` / `scripts/build-ios.sh` with submodule access
  to produce the multi-ABI, LTO-stripped binaries.
- iOS LanceDB memory requires the host to expose the LanceDB module to this
  target (Android does it automatically via Gradle detection).
- 32-bit ARM can legitimately fail in the Rust dependency graph (e.g.
  vector-DB SIMD); the build script treats that ABI as best-effort by
  design.
