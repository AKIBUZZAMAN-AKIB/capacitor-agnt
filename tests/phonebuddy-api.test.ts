import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Differential contract tests for the PhoneBuddy engine plugin
// (plugins/phonebuddy-agent) — the piece that brings back the two "modern"
// capabilities the pinned agent generation (0.5.2) lost:
//
//   * background wakes: a periodic JobScheduler job on Android, a
//     BGProcessingTask on iOS, driving the engine's own `scheduler` tool;
//   * surfaced messages: the durable record of what the agent produced while
//     the UI was closed.
//
// The engine itself is the public Apache-2.0 PhoneBuddy SDK, pinned to v0.2.0
// and built from source for every Android ABI (docs/PHONEBUDDY-ENGINE.bn.md).
// These tests read the real sources and prove the pieces agree: the C header vs
// the two platform bindings, the plugin API vs its TS contract, the wake
// plumbing vs what the engine actually emits, the committed binaries vs their
// manifest, and the bridge/config/workflow wiring that makes it reachable.

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');
const readBytes = (relative: string) => readFileSync(path.join(root, relative));
const unique = <T,>(arr: T[]) => [...new Set(arr)];

const PLUGIN = 'plugins/phonebuddy-agent';
const KOTLIN_DIR = `${PLUGIN}/android/src/main/java/com/t6x/plugins/phonebuddy`;
const SWIFT_DIR = `${PLUGIN}/ios/Sources/PhoneBuddyAgentPlugin`;
const HEADER = `${PLUGIN}/native/include/phone_buddy.h`;
const SHIM_HEADER = `${PLUGIN}/ios/Sources/phone_buddy_ffi/include/phone_buddy.h`;
const BRIDGE = 'bridge/nativekit.ts';
const LAB = 'www/agent-lab.js';
const HTML = 'www/index.html';

const kotlin = (file: string) => read(`${KOTLIN_DIR}/${file}`);
const swift = (file: string) => read(`${SWIFT_DIR}/${file}`);
/** Kotlin source without comments — assertions about what the code DOES, not what a comment says. */
const kotlinCode = (file: string) =>
  kotlin(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** @PluginMethod-annotated Kotlin methods = the Android API surface. */
function kotlinMethods(): string[] {
  return unique([...kotlin('PhoneBuddyAgentPlugin.kt').matchAll(/@PluginMethod\s+fun (\w+)\(/g)].map((m) => m[1])).sort();
}

/** @objc func ...(_ call: CAPPluginCall) = the iOS implementations. */
function swiftMethods(): string[] {
  return unique([...swift('PhoneBuddyAgentPlugin.swift').matchAll(/@objc func (\w+)\(_ call: CAPPluginCall\)/g)].map((m) => m[1])).sort();
}

/** Methods declared on the TS interface = what JS can call. */
function definitionMethods(): string[] {
  const block = read(`${PLUGIN}/src/definitions.ts`).match(/export interface PhoneBuddyAgentPlugin \{[\s\S]*?\n\}/)![0];
  return unique([...block.matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1])).sort();
}

/** pb_* symbols the C ABI declares. */
function headerSymbols(): string[] {
  return unique([...read(HEADER).matchAll(/\b(pb_[a-z0-9_]+)\s*\(/g)].map((m) => m[1])).sort();
}

describe('phonebuddy engine — cross-platform plugin contract', () => {
  it('Android, iOS and the TS contract expose exactly the same methods', () => {
    const android = kotlinMethods();
    const ios = swiftMethods();
    const declared = definitionMethods();
    expect(android.length).toBeGreaterThanOrEqual(16);
    expect(ios, `iOS is missing: ${android.filter((m) => !ios.includes(m))}`).toEqual(android);
    // addListener is Capacitor's event API (implemented by the bridge, not by a
    // @PluginMethod), so the TS contract carries exactly one extra entry.
    expect(declared.filter((m) => m !== 'addListener')).toEqual(android);
  });

  it('the plugin is registered under the name the bridge imports', () => {
    expect(kotlin('PhoneBuddyAgentPlugin.kt')).toContain('@CapacitorPlugin(name = "PhoneBuddyAgent")');
    expect(read(`${PLUGIN}/src/index.ts`)).toContain("registerPlugin<PhoneBuddyAgentPlugin>('PhoneBuddyAgent'");
    expect(read(BRIDGE)).toContain("import { PhoneBuddy as PhoneBuddyAgent } from '@nativekit/phonebuddy-agent';");
  });

  it('names its generation on every platform', () => {
    const generation = 'phonebuddy-0.2.0';
    expect(kotlin('PhoneBuddyAgentPlugin.kt')).toContain(`ENGINE_GENERATION = "${generation}"`);
    expect(swift('PhoneBuddyAgentPlugin.swift')).toContain(`engineGeneration = "${generation}"`);
    expect(read(`${PLUGIN}/src/web.ts`)).toContain(`ENGINE_GENERATION = '${generation}'`);
    expect(read(`${PLUGIN}/src/definitions.ts`)).toContain(generation);
  });

  it('every TS result type marks the engine generation', () => {
    const defs = read(`${PLUGIN}/src/definitions.ts`);
    for (const type of [
      'PhoneBuddyAvailability',
      'PhoneBuddyInitializeResult',
      'PhoneBuddyWakeResult',
      'PhoneBuddyWakeStatus',
      'PhoneBuddySurfacedResult',
    ]) {
      const block = defs.match(new RegExp(`export interface ${type} \\{[\\s\\S]*?\\n\\}`))![0];
      expect(block, `${type} must carry engineGeneration`).toContain('engineGeneration: string');
    }
  });
});

describe('phonebuddy engine — the C ABI is the single source of truth', () => {
  it('both platform bindings only call symbols the vendored header declares', () => {
    const declared = headerSymbols();
    expect(declared.length).toBeGreaterThanOrEqual(21);
    const kotlinCalled = unique([...kotlin('PhoneBuddyFfi.kt').matchAll(/\bfun (pb_[a-z0-9_]+)\(/g)].map((m) => m[1]));
    const swiftCalled = unique([...swift('PhoneBuddyAgentPlugin.swift').matchAll(/\b(pb_[a-z0-9_]+)\s*\(/g)].map((m) => m[1]));
    for (const symbol of [...kotlinCalled, ...swiftCalled]) {
      expect(declared, `${symbol} is called but not declared in phone_buddy.h`).toContain(symbol);
    }
    expect(kotlinCalled.length).toBeGreaterThanOrEqual(15);
    expect(swiftCalled.length).toBeGreaterThanOrEqual(10);
  });

  it('the JNA mapping keeps the header signatures (no invented parameters)', () => {
    const ffi = kotlin('PhoneBuddyFfi.kt');
    // Pointer-returning entry points must be freed through pb_string_free, never
    // through Memory/Pointer.dispose — that is how the older generation leaked.
    expect(ffi).toContain('pb_string_free');
    expect(ffi).toContain('interface PhoneBuddyLib : Library');
    for (const fn of ['pb_engine_new', 'pb_engine_chat', 'pb_engine_set_host_callbacks', 'pb_engine_host_tool_result']) {
      expect(ffi, `${fn} missing from the JNA interface`).toContain(fn);
    }
  });

  it('ships the module map + a header byte-identical to the vendored one', () => {
    expect(readBytes(HEADER).equals(readBytes(SHIM_HEADER))).toBe(true);
    const modulemap = read(`${PLUGIN}/ios/Sources/phone_buddy_ffi/include/module.modulemap`);
    expect(modulemap).toContain('module phone_buddy_ffi');
    // The module name must equal the SwiftPM target name, else `import
    // phone_buddy_ffi` cannot resolve.
    expect(read(`${PLUGIN}/Package.swift`)).toContain('name: "phone_buddy_ffi"');
  });

  it('keeps the Apache-2.0 attribution the license requires', () => {
    expect(read(`${PLUGIN}/native/LICENSE-PhoneBuddySDK.txt`)).toContain('Apache License');
    expect(read(`${PLUGIN}/native/NOTICE-PhoneBuddySDK.txt`).length).toBeGreaterThan(50);
    expect(read(HEADER)).toContain('Automatically generated by cbindgen');
    expect(read(`${PLUGIN}/native/NOTICE-PhoneBuddySDK.txt`)).toMatch(/PhoneBuddy|APUS/);
  });
});

describe('phonebuddy engine — background wakes are real OS work', () => {
  it('runs the wake on a JobService the system owns', () => {
    const manifest = read(`${PLUGIN}/android/src/main/AndroidManifest.xml`);
    expect(manifest).toContain('<service');
    expect(manifest).toContain('com.t6x.plugins.phonebuddy.PhoneBuddyWakeService');
    expect(manifest).toContain('BIND_JOB_SERVICE');
    expect(manifest).toContain('android:exported="false"');
    const service = kotlinCode('PhoneBuddyWakeService.kt');
    expect(service).toContain('class PhoneBuddyWakeService : JobService()');
    // onStartJob must hand the work to a thread and return true…
    expect(service).toMatch(/onStartJob\(params: JobParameters\?\): Boolean \{[\s\S]*?Thread\(/);
    expect(service).toMatch(/worker\?\.start\(\)\s*\n\s*return true/);
    // …and it must terminate the job exactly once, success or failure.
    expect(service.match(/jobFinished\(/g)!.length).toBe(1);
    // A stopped job means the OS took the CPU back, so ask for a retry.
    expect(service).toMatch(/onStopJob\(params: JobParameters\?\): Boolean \{[\s\S]*?return true/);
  });

  it('arms a periodic job the SDK actually supports, and reports the granted interval', () => {
    const schedule = kotlin('PhoneBuddySchedule.kt');
    expect(schedule).toContain('JobInfo.Builder(JOB_ID, service)');
    expect(schedule).toContain('.setPeriodic(');
    expect(schedule).toContain('JobScheduler.RESULT_SUCCESS');
    // Android floors periodic work at 15 minutes; the granted interval has to be
    // reported back instead of the requested one being assumed.
    expect(schedule).toContain('MIN_INTERVAL_MINUTES');
    expect(schedule).toMatch(/maxOf\(requestedMinutes, PhoneBuddyStore\.MIN_INTERVAL_MINUTES\)/);
    // Never claim reboot survival we did not implement (setPersisted needs a
    // boot receiver permission we deliberately do not declare).
    expect(kotlinCode('PhoneBuddySchedule.kt'), 'setPersisted(true) throws without RECEIVE_BOOT_COMPLETED').not.toMatch(/\.setPersisted\(/);
    const manifestCode = read(`${PLUGIN}/android/src/main/AndroidManifest.xml`).replace(/<!--[\s\S]*?-->/g, '');
    expect(manifestCode, 'a boot receiver would have to be implemented, not just declared').not.toContain('RECEIVE_BOOT_COMPLETED');
  });

  it('a wake rebuilds the engine, runs due tasks and frees it again', () => {
    const runner = kotlin('PhoneBuddyWakeRunner.kt');
    // persisted config → engine, because nothing else survives a dead process
    expect(runner).toContain('store.engineConfig()');
    expect(runner).toContain('pb_engine_new');
    expect(runner).toContain('store.hostTools()');
    expect(runner).toContain('pb_engine_set_host_tools');
    expect(runner).toContain('pb_engine_set_host_callbacks');
    // the engine's own scheduler store is what decides what is due
    expect(runner).toContain('scheduler.json');
    expect(runner).toContain('pb_engine_chat');
    expect(runner).toMatch(/finally \{\s*\n\s*try \{\s*\n\s*engine\?\.let \{ lib\.pb_engine_free\(it\) \}/);
    // failures are data, never a crash
    expect(runner).toMatch(/catch \(t: Throwable\)/);
    expect(runner).toContain('PhoneBuddyLib.isAvailable');
  });

  it('host events are dispatched the way the engine documents them', () => {
    const runner = kotlin('PhoneBuddyWakeRunner.kt');
    for (const event of ['scheduler_registered', 'scheduler_cancelled', 'notification_send', 'notification_schedule', 'monitor']) {
      expect(runner, `${event} is never handled`).toContain(event);
    }
    // Host EVENTS are fire-and-forget: answering them with host_tool_result would
    // be a protocol error. Only real host tools get a result.
    const eventAnswer = runner.match(/if \(toolName !in HOST_EVENTS\) \{[\s\S]*?\n            \}/)![0];
    expect(eventAnswer).toContain('pb_engine_host_tool_result');
    expect(runner).toContain('HOST_EVENTS = setOf(');
  });

  it('posts an OS notification so a background run is visible', () => {
    const runner = kotlin('PhoneBuddyWakeRunner.kt');
    expect(runner).toContain('NotificationChannel');
    expect(runner).toContain('NotificationManager.IMPORTANCE_DEFAULT');
    expect(runner).toContain('manager.notify(');
    expect(read(`${PLUGIN}/android/src/main/AndroidManifest.xml`)).toContain('POST_NOTIFICATIONS');
  });

  it('persists everything a cold start needs', () => {
    const store = kotlin('PhoneBuddyStore.kt');
    for (const key of ['phonebuddy_agent', 'engineConfig', 'wakeIntervalMinutes']) {
      expect(store, `store must persist ${key}`).toContain(key);
    }
    expect(store).toContain('SharedPreferences');
    expect(store).toContain('rootDirOrDefault');
  });

  it('iOS uses the APIs BGTaskScheduler really has', () => {
    const bg = swift('PhoneBuddyBackgroundTask.swift');
    expect(bg).toContain('BGTaskScheduler.shared.register(');
    expect(bg).toContain('try BGTaskScheduler.shared.submit(request)');
    expect(bg).toContain('cancel(taskRequestWithIdentifier:');
    expect(bg).toContain('as? BGProcessingTask');
    expect(bg).toContain('setTaskCompleted(success:');
    // The identifier must be the one scripts/configure-native.mjs whitelists in
    // Info.plist, otherwise registration fails silently at runtime.
    const identifier = bg.match(/taskIdentifier = "([^"]+)"/)![1];
    expect(read('scripts/configure-native.mjs')).toContain(`PHONEBUDDY_WAKE_TASK_ID = '${identifier}'`);
    expect(read('scripts/configure-native.mjs')).toMatch(/phoneBuddyWakeSupported[\s\S]*?bgTaskIds\.push\(PHONEBUDDY_WAKE_TASK_ID\)/);
    expect(read('scripts/configure-native.mjs')).toMatch(/agentWakeSupported \|\| phoneBuddyWakeSupported\) modes\.push\('processing'\)/);
  });
});

describe('phonebuddy engine — surfaced messages survive the UI being closed', () => {
  it('records, pages and caps them identically on both platforms', () => {
    const kotlinStore = kotlin('PhoneBuddySurfaced.kt');
    const swiftStore = swift('PhoneBuddySurfacedStore.swift');
    for (const source of [kotlinStore, swiftStore]) {
      expect(source).toContain('surfaced.json');
      expect(source).toContain('500');
      expect(source).toMatch(/unread/);
    }
    expect(kotlinStore).toMatch(/fun load\(limit: Int, markRead: Boolean\)/);
    expect(swiftStore).toMatch(/func load\(limit: Int, markRead: Bool\)/);
  });

  it('a wake appends one record per finished task and marks it completed', () => {
    const runner = kotlin('PhoneBuddyWakeRunner.kt');
    expect(runner).toContain('surfaced.append(');
    expect(runner).toContain('markTaskCompleted(');
    expect(runner).toMatch(/item\.put\("status", "completed"\)/);
    expect(runner).toContain('surfaced.recordWake(source, summary)');
    expect(swift('PhoneBuddyAgentPlugin.swift')).toContain('markTaskCompleted(root: root, taskId: taskId)');
  });

  it('the plugin exposes the page + clear APIs the bridge calls', () => {
    const plugin = kotlin('PhoneBuddyAgentPlugin.kt');
    expect(plugin).toMatch(/fun loadSurfacedMessages\(call: PluginCall\) \{[\s\S]*?messagesJson/);
    expect(plugin).toMatch(/fun clearSurfacedMessages\(call: PluginCall\) \{[\s\S]*?cleared/);
    expect(plugin).toMatch(/fun getWakeStatus\(call: PluginCall\) \{[\s\S]*?pendingTasks/);
  });
});

describe('phonebuddy engine — committed binaries and build inputs', () => {
  const jni = `${PLUGIN}/android/src/main/jniLibs`;
  const manifest = JSON.parse(read(`${jni}/abi-manifest.json`));

  it('ships every Android ABI, including the 32-bit phone in the field', () => {
    for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']) {
      expect(manifest.abis[abi], `${abi} missing from abi-manifest.json`).toBeTruthy();
      expect(existsSync(path.join(root, jni, abi, 'libphone_buddy_ffi.so')), `${abi} has no .so`).toBe(true);
    }
    expect(manifest.engine).toContain('PhoneBuddy');
    expect(manifest.ref).toBe('v0.2.0');
    expect(manifest.source).toContain('PhoneBuddySDK');
  });

  it('the recorded hashes match the committed slices (a stale .so would be a lie)', () => {
    for (const [abi, meta] of Object.entries(manifest.abis as Record<string, { sha256: string; bytes: number }>)) {
      const file = path.join(root, jni, abi, 'libphone_buddy_ffi.so');
      const bytes = readBytes(path.relative(root, file));
      expect(bytes.length, `${abi}: bytes differ from abi-manifest.json`).toBe(meta.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), `${abi}: sha256 differs`).toBe(meta.sha256);
    }
  });

  it('the plugin gradle can actually link JNA and keep its classes', () => {
    const gradle = read(`${PLUGIN}/android/build.gradle`);
    expect(gradle).toContain("apply plugin: 'kotlin-android'");
    expect(gradle).toContain('net.java.dev.jna:jna:5.14.0@aar');
    expect(gradle).toContain("consumerProguardFiles 'consumer-rules.pro'");
    const rules = read(`${PLUGIN}/android/consumer-rules.pro`);
    expect(rules).toContain('com.sun.jna');
    expect(rules).toContain('PhoneBuddyWakeService');
    // minSdk must not exceed the app's, or the module silently raises it for everyone
    const pluginSdk = Number(gradle.match(/minSdkVersion (\d+)/)![1]);
    const appSdk = Number(read('android/variables.gradle').match(/minSdkVersion = (\d+)/)![1]);
    expect(pluginSdk).toBeLessThanOrEqual(appSdk);
  });

  it('the build script can rebuild those slices from public source', () => {
    const script = read('tools/agent-ffi/build-phonebuddy-all-abis.sh');
    for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']) {
      expect(script, `builder does not know ${abi}`).toContain(abi);
    }
    expect(script).toContain('APUS-AI-Lab/PhoneBuddySDK');
    expect(read('package.json')).toContain('ffi:build:phonebuddy');
  });

  it('iOS can be rebuilt from source too, and the script refuses a mismatched header', () => {
    const script = read('tools/agent-ffi/build-phonebuddy-ios-xcframework.sh');
    expect(script).toContain('xcodebuild -create-xcframework');
    expect(script).toContain('PB_BUILD_HEADER=1');
    // A header that does not match the built crate means the repo and the binary
    // describe different ABIs — the build must fail instead of shipping that.
    expect(script).toMatch(/diff -q "\$VENDORED_HEADER" "\$GEN_HEADER"[\s\S]*?die "/);
    expect(script).toContain('nm -g');
    for (const symbol of ['_pb_engine_new', '_pb_engine_set_host_callbacks', '_pb_string_free']) {
      expect(script).toContain(symbol);
    }
    expect(script).toContain('IPHONEOS_DEPLOYMENT_TARGET');
  });

  it('the iOS xcframework workflow builds, verifies and commits the result', () => {
    const wf = read('.github/workflows/phonebuddy-ios.yml');
    expect(wf).toContain('runs-on: macos-14');
    expect(wf).toContain('build-phonebuddy-ios-xcframework.sh');
    expect(wf).toContain('plugins/phonebuddy-agent/ios/Frameworks/PhoneBuddyFFI.xcframework');
    expect(wf).toContain('pb_engine_set_host_callbacks');
    // Every workflow that commits to main must rebase-retry, or it races the others.
    expect(wf).toContain('git fetch --quiet origin');
    expect(wf).toContain('git rebase --quiet');
    expect(wf).toMatch(/for attempt in 1 2 3 4 5/);
  });

  it('the SwiftPM manifest stays resolvable before the framework exists', () => {
    const pkg = read(`${PLUGIN}/Package.swift`);
    // SwiftPM hard-fails on a missing binaryTarget path, which would break
    // `npm run sync` on a fresh checkout — so the target is conditional.
    expect(pkg).toContain('let hasFFI = FileManager.default.fileExists(atPath: ffiFrameworkPath)');
    expect(pkg).toMatch(/if hasFFI \{\s*\n\s*targets\.append\(\.binaryTarget/);
    expect(pkg).toContain('name: "NativekitPhonebuddyAgent"');
    expect(pkg).toContain('name: "PhoneBuddyAgentPlugin"');
    expect(pkg).toContain('path: "ios/Sources/PhoneBuddyAgentPlugin"');
    // …and the plugin compiles an honest no-engine half when the framework is absent
    const plugin = swift('PhoneBuddyAgentPlugin.swift');
    expect(plugin).toContain('#if canImport(phone_buddy_ffi)');
    expect(plugin).toContain('call.unavailable(');
    expect(plugin).toMatch(/"available": false/);
  });

  it('declares the JNA callbacks in Java so Kotlin can write SAM lambdas', () => {
    // A Kotlin interface extending JNA's Callback has no constructor and cannot
    // be SAM-converted: `PbEventCallback { ... }` fails with
    // "Interface 'PbEventCallback : Callback' does not have constructors".
    const files = readdirSync(path.join(root, KOTLIN_DIR));
    const kotlinSources = files.filter((f) => f.endsWith('.kt')).map((f) => read(`${KOTLIN_DIR}/${f}`));
    for (const callback of [
      'PbEventCallback',
      'PbHostToolCallback',
      'PbLlmRequestCallback',
      'PbWebViewFetchCallback',
      'PbLogCallback',
    ]) {
      expect(files, `${callback} must be declared in Java (SAM conversion)`).toContain(`${callback}.java`);
      for (const src of kotlinSources) {
        expect(src, `${callback} must not be re-declared in Kotlin`).not.toContain(`interface ${callback} : Callback`);
      }
    }
    expect(kotlin('PhoneBuddyAgentPlugin.kt')).toMatch(/PbEventCallback \{/);
    expect(kotlin('PhoneBuddyWakeRunner.kt')).toMatch(/PbHostToolCallback \{/);
  });

  it('keeps CallbackBox outside the canImport block', () => {
    // The plugin class holds `callbackBoxes: [CallbackBox]` unconditionally, so
    // declaring the type inside `#if canImport(phone_buddy_ffi)` breaks the
    // no-framework build with "cannot find type 'CallbackBox' in scope".
    const plugin = swift('PhoneBuddyAgentPlugin.swift');
    const box = plugin.indexOf('final class CallbackBox');
    const engineHalf = plugin.indexOf('// MARK: - Engine-backed implementation');
    expect(box, 'CallbackBox is missing').toBeGreaterThan(-1);
    expect(engineHalf).toBeGreaterThan(-1);
    expect(box, 'CallbackBox is declared inside the canImport block').toBeLessThan(engineHalf);
    expect(plugin.slice(0, engineHalf)).toContain('callbackBoxes: [CallbackBox]');
  });

  it('every non-system Swift import is guarded by canImport', () => {
    const system = new Set(['Foundation', 'Capacitor', 'BackgroundTasks', 'UserNotifications', 'UIKit', 'Combine']);
    for (const file of readdirSync(path.join(root, SWIFT_DIR)).filter((f) => f.endsWith('.swift'))) {
      const src = swift(file);
      for (const m of src.matchAll(/^import (\w+)$/gm)) {
        if (system.has(m[1])) continue;
        expect(src, `${file}: 'import ${m[1]}' is not behind #if canImport`).toContain(`canImport(${m[1]})`);
      }
    }
  });
});

describe('phonebuddy engine — app wiring', () => {
  it('is a real dependency of the app', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies['@nativekit/phonebuddy-agent']).toBe('file:plugins/phonebuddy-agent');
    const pluginPkg = JSON.parse(read(`${PLUGIN}/package.json`));
    expect(pluginPkg.name).toBe('@nativekit/phonebuddy-agent');
    expect(pluginPkg.capacitor.android.src).toBe('android');
    expect(pluginPkg.capacitor.ios.src).toBe('ios');
    expect(pluginPkg.files).toContain('Package.swift');
  });

  it('the wake interval comes from config, clamped to what the OS grants', () => {
    const bridge = read(BRIDGE);
    expect(bridge).toMatch(/phonebuddy: \{[\s\S]*?wakeIntervalMinutes: number/);
    const config = JSON.parse(read('app.config.json'));
    expect(config.phonebuddy.enabled).toBe(true);
    expect(config.phonebuddy.wakeIntervalMinutes).toBeGreaterThanOrEqual(15);
    expect(config.phonebuddy.surfacedLimit).toBeGreaterThan(0);
    const schema = JSON.parse(read('app.config.schema.json'));
    expect(schema.properties.phonebuddy.additionalProperties).toBe(false);
    expect(new Set(schema.properties.phonebuddy.required)).toEqual(new Set(Object.keys(config.phonebuddy)));
    expect(bridge).toMatch(
      /function phoneBuddyInterval\(requested\?: number\): number \{[\s\S]*?minIntervalMinutes, 15\)[\s\S]*?Math\.max\(Math\.round\(value\), floor\)/,
    );
  });

  it('the routed APIs are the ones the plugin actually implements', () => {
    const bridge = read(BRIDGE);
    const routed = [...bridge.matchAll(/phoneBuddyCall\(\s*\n?\s*'(\w+)'/g)].map((m) => m[1]);
    const implemented = kotlinMethods();
    for (const name of unique(routed)) {
      expect(implemented, `bridge routes ${name}() but the plugin does not implement it`).toContain(name);
    }
    // Everything the shims expose must be present in the plugin contract as well.
    for (const name of ['scheduleBackgroundWakes', 'cancelBackgroundWakes', 'getWakeStatus', 'loadSurfacedMessages', 'clearSurfacedMessages']) {
      expect(unique(routed)).toContain(name);
    }
  });

  it('the demo lab can exercise all of it', () => {
    const lab = read(LAB);
    const html = read(HTML);
    for (const api of ['scheduleBackgroundWakes', 'cancelBackgroundWakes', 'getWakeStatus', 'loadSurfacedMessages', 'clearSurfacedMessages']) {
      expect(lab, `lab never calls agent.${api}()`).toContain(`window.NativeKit.agent.${api}(`);
    }
    for (const api of ['checkAvailability', 'handleWake']) {
      expect(lab, `lab never calls agent.phonebuddy.${api}()`).toContain(`window.NativeKit.agent.phonebuddy.${api}(`);
    }
    for (const action of ['agentpbavail', 'agentpbwake', 'agentwakes', 'agentclearsurfaced']) {
      expect(html, `no button for ${action}`).toContain(`data-agent-action="${action}"`);
    }
  });

  it('keeps the engine plugin independent of the pinned agent plugin', () => {
    const bridge = read(BRIDGE);
    // The wake path must never reach into the 0.5.2 plugin's API surface.
    for (const name of ['scheduleBackgroundWakes', 'cancelBackgroundWakes', 'loadSurfacedMessages', 'clearSurfacedMessages', 'getWakeStatus']) {
      expect(bridge.includes(`NativeAgent.${name}(`), `NativeAgent.${name}() does not exist in 0.5.2`).toBe(false);
    }
    // …and the router is the only place that talks to PhoneBuddy.
    expect(read(BRIDGE)).toMatch(/async function phoneBuddyCall\(/);
    expect(read(`${PLUGIN}/android/src/main/java/com/t6x/plugins/phonebuddy/PhoneBuddyAgentPlugin.kt`))
      .not.toContain('com.t6x.plugins.nativeagent');
  });
});
