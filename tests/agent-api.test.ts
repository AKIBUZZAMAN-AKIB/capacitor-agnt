import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Differential contract tests for the on-device Rust AI agent plugin.
//
// These read the REAL sources (Kotlin plugin, Swift plugin, TS definitions,
// the trusted bridge, and the demo lab) and prove they agree with each other.
// Drift between platforms is the bug class that actually shipped in this
// plugin before (e.g. removeSkill read "skillId" on Android but "id" on iOS,
// and iOS resumeSession silently dropped its return value), so the contract
// is asserted mechanically rather than by review.

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');
const unique = <T,>(arr: T[]) => [...new Set(arr)];

const KOTLIN = 'plugins/native-agent/android/src/main/java/com/t6x/plugins/nativeagent/NativeAgentPlugin.kt';
const SWIFT = 'plugins/native-agent/ios/Sources/NativeAgentPlugin/NativeAgentPlugin.swift';
const DEFS = 'plugins/native-agent/src/definitions.ts';
const BRIDGE = 'bridge/nativekit.ts';
const LAB = 'www/agent-lab.js';
const HTML = 'www/index.html';

/** @PluginMethod-annotated Kotlin methods = the Android API surface. */
function kotlinMethods(): string[] {
  const src = read(KOTLIN);
  return unique([...src.matchAll(/@PluginMethod\s+fun (\w+)\(/g)].map((m) => m[1]));
}

/** CAPPluginMethod(name:) entries = the iOS API surface actually exported to JS. */
function swiftExportedMethods(): string[] {
  const src = read(SWIFT);
  return unique([...src.matchAll(/CAPPluginMethod\(name:\s*"(\w+)"/g)].map((m) => m[1]));
}

/** @objc func ... = the iOS implementations. */
function swiftImplMethods(): string[] {
  const src = read(SWIFT);
  return unique([...src.matchAll(/@objc func (\w+)\(_ call: CAPPluginCall\)/g)].map((m) => m[1]));
}

describe('agent plugin — cross-platform contract', () => {
  it('Android and iOS expose exactly the same JS method names', () => {
    const android = kotlinMethods().sort();
    const ios = swiftExportedMethods().sort();
    expect(android.length).toBeGreaterThan(40);

    const missingOnIos = android.filter((m) => !ios.includes(m));
    const missingOnAndroid = ios.filter((m) => !android.includes(m));
    expect(missingOnIos, `implemented on Android but not exported on iOS: ${missingOnIos}`).toEqual([]);
    expect(missingOnAndroid, `exported on iOS but missing on Android: ${missingOnAndroid}`).toEqual([]);
  });

  it('every iOS-exported method has a matching @objc implementation', () => {
    const exported = swiftExportedMethods();
    const impl = new Set(swiftImplMethods());
    // registerGovernance is native-to-native and intentionally not exported.
    for (const method of exported) {
      expect(impl.has(method), `CAPPluginMethod '${method}' has no @objc implementation`).toBe(true);
    }
  });

  it('the TypeScript definitions declare every native method', () => {
    const defs = read(DEFS);
    for (const method of kotlinMethods()) {
      expect(
        new RegExp(`\\b${method}\\s*\\(`).test(defs),
        `native method '${method}' is missing from definitions.ts`,
      ).toBe(true);
    }
  });

  it('does not re-introduce the phantom extraToolsJson field', () => {
    // It was documented in TS but never existed in the UniFFI struct, so it
    // was silently ignored on every platform.
    expect(read(DEFS)).not.toContain('extraToolsJson');
  });
});

describe('agent plugin — parameter-name parity (the removeSkill bug class)', () => {
  const kotlin = read(KOTLIN);
  const swift = read(SWIFT);

  /** Option keys each platform reads for a given method body. */
  const keysFor = (src: string, methodRegex: RegExp, getter: RegExp) => {
    const match = src.match(methodRegex);
    if (!match) return null;
    return unique([...match[0].matchAll(getter)].map((m) => m[1]));
  };

  const methods = ['removeSkill', 'removeCronJob', 'endSkill', 'startSkill', 'runCronJob'];

  it.each(methods)('%s reads the same option keys on both platforms', (method) => {
    const kotlinKeys = keysFor(
      kotlin,
      new RegExp(`fun ${method}\\(call: PluginCall\\)[\\s\\S]{0,400}?\\n    \\}`),
      /call\.get\w+\("(\w+)"\)/g,
    );
    const swiftKeys = keysFor(
      swift,
      new RegExp(`@objc func ${method}\\(_ call: CAPPluginCall\\)[\\s\\S]{0,1400}?\\n    \\}`),
      /call\.get\w+\("(\w+)"\)/g,
    );
    expect(kotlinKeys, `could not locate ${method} in Kotlin`).not.toBeNull();
    expect(swiftKeys, `could not locate ${method} in Swift`).not.toBeNull();

    // iOS may additionally accept a legacy alias, but every key Android reads
    // must be understood by iOS too — otherwise the call fails on one platform.
    for (const key of kotlinKeys!) {
      expect(
        swiftKeys!.includes(key),
        `${method}: Android reads "${key}" but iOS reads ${JSON.stringify(swiftKeys)}`,
      ).toBe(true);
    }
  });

  it('resumeSession returns wasInterrupted on both platforms', () => {
    expect(kotlin).toMatch(/ret\.put\("wasInterrupted"/);
    expect(swift).toMatch(/call\.resolve\(\["wasInterrupted"/);
  });
});

describe('agent plugin — crash-safety guarantees', () => {
  it('Kotlin catches Throwable, not just Exception (UnsatisfiedLinkError)', () => {
    const kotlin = read(KOTLIN);
    // An unsupported-ABI device throws UnsatisfiedLinkError, which is an Error
    // and would escape `catch (e: Exception)` → native crash + hung promises.
    expect(kotlin).toMatch(/catch \(t: Throwable\)/);
    expect(kotlin).toMatch(/catch \(e: OutOfMemoryError\)/); // OOM must be re-thrown
  });

  it('checkAvailability exists on both platforms and never rejects', () => {
    expect(read(KOTLIN)).toMatch(/fun checkAvailability\(call: PluginCall\)/);
    expect(read(SWIFT)).toMatch(/@objc func checkAvailability/);
    // Kotlin resolves an availability object in the failure path too.
    const body = read(KOTLIN).match(/fun checkAvailability[\s\S]{0,1200}?\n    \}/)![0];
    expect(body).toContain('call.resolve(ret)');
    expect(body).not.toContain('call.reject');
  });

  it('background scheduling resolves with a reason instead of rejecting', () => {
    const kotlin = read(KOTLIN).match(/fun scheduleBackgroundWakes[\s\S]{0,1400}?\n    \}/)![0];
    expect(kotlin).toContain('jobScheduled');
    expect(kotlin).not.toContain('call.reject');
  });

  it('does not log session keys at INFO level in production', () => {
    const kotlin = read(KOTLIN);
    // TRACE logging must sit behind a compile-time flag.
    expect(kotlin).toMatch(/const val DEBUG = false/);
    const traceLines = [...kotlin.matchAll(/Log\.i\("TRACE:kt"[^\n]*/g)].map((m) => m[0]);
    for (const line of traceLines) {
      expect(line.includes('if (DEBUG)') || kotlin.includes('if (DEBUG) android.util.Log.i')).toBe(true);
    }
  });
});

describe('agent — bridge and demo wiring', () => {
  const bridge = read(BRIDGE);

  it('exposes every native method through NativeKit.agent', () => {
    const bridgeCalls = new Set(
      unique([...bridge.matchAll(/NativeAgent\.(\w+)\(/g)].map((m) => m[1])),
    );
    const skip = new Set(['addListener']); // wrapped as agent.onEvent
    for (const method of kotlinMethods()) {
      if (skip.has(method)) continue;
      expect(
        bridgeCalls.has(method),
        `native method '${method}' is not wired in bridge/nativekit.ts`,
      ).toBe(true);
    }
  });

  it('gates every agent call behind the feature flag and a native check', () => {
    const block = bridge.match(/\n  agent: \{[\s\S]*?\n  \},\n\};/);
    expect(block, 'agent namespace not found in bridge').not.toBeNull();
    const body = block![0];
    // Handlers are written both as one-liners and as multi-line blocks; split
    // the namespace on top-level `name: async (` starts so both forms are covered.
    const starts = [...body.matchAll(/^    (\w+): async \(/gm)];
    const asyncFns = starts.map((m, i) => {
      const from = m.index!;
      const to = i + 1 < starts.length ? starts[i + 1].index! : body.length;
      return [null, m[1], body.slice(from, to)] as [null, string, string];
    });
    expect(asyncFns.length).toBeGreaterThan(40);
    for (const [, name, fnBody] of asyncFns) {
      expect(fnBody.includes("feature('agent')"), `agent.${name} is missing feature('agent')`).toBe(true);
      expect(fnBody.includes('requireNative()'), `agent.${name} is missing requireNative()`).toBe(true);
    }
  });

  it('declares the agent feature flag in config + schema', () => {
    const config = JSON.parse(read('app.config.json'));
    expect(config.features).toHaveProperty('agent');
    const schema = JSON.parse(read('app.config.schema.json'));
    expect(schema.properties.features.required).toContain('agent');
    expect(schema.properties.features.properties).toHaveProperty('agent');
    expect(schema.properties.features.additionalProperties).toBe(false);
  });

  it('demo lab tests every agent API exposed on the bridge', () => {
    const lab = read(LAB);
    const block = bridge.match(/\n  agent: \{[\s\S]*?\n  \},\n\};/)![0];
    const bridgeApis = unique(
      [...block.matchAll(/^    (\w+): (?:async )?\(/gm)].map((m) => m[1]),
    ).filter((n) => n !== 'supported');

    const labCalls = new Set(
      unique([...lab.matchAll(/NativeKit\.agent\.(\w+)\(/g)].map((m) => m[1])),
    );
    for (const api of bridgeApis) {
      expect(labCalls.has(api), `NativeKit.agent.${api} has no demo-lab test`).toBe(true);
    }
  });

  it('every demo-lab action has a button in index.html and vice versa', () => {
    const lab = read(LAB);
    const html = read(HTML);
    const actions = unique([...lab.matchAll(/^  (agent\w+): async/gm)].map((m) => m[1]));
    const buttons = unique([...html.matchAll(/data-agent-action="(\w+)"/g)].map((m) => m[1]));
    expect(actions.length).toBeGreaterThan(40);
    for (const action of actions) {
      expect(buttons.includes(action), `action '${action}' has no button`).toBe(true);
    }
    for (const button of buttons) {
      expect(actions.includes(button), `button '${button}' has no action`).toBe(true);
    }
  });
});

describe('agent — iOS background wake configuration', () => {
  it('whitelists the agent BGTask identifier without dropping the shell runner', () => {
    const gen = read('scripts/configure-native.mjs');
    expect(gen).toContain("const AGENT_WAKE_TASK_ID = 'io.t6x.nativeagent.wake'");
    // The identifier must match the Swift constant, or BGTaskScheduler.register throws.
    const swift = read('plugins/native-agent/ios/Sources/NativeAgentPlugin/NativeAgentBackgroundTask.swift');
    expect(swift).toContain('static let taskIdentifier = "io.t6x.nativeagent.wake"');
    // Both owners contribute to one array rather than overwriting each other.
    expect(gen).toMatch(/bgTaskIds\.push\(config\.backgroundRunner\.taskIdentifier\)/);
    expect(gen).toMatch(/bgTaskIds\.push\(AGENT_WAKE_TASK_ID\)/);
  });

  it('enables the processing background mode required by BGProcessingTask', () => {
    expect(read('scripts/configure-native.mjs')).toMatch(
      /config\.ios\.backgroundProcessing \|\| config\.features\.agent\) modes\.push\('processing'\)/,
    );
  });
});

describe('agent — Android Gradle toolchain', () => {
  it('puts the Kotlin Gradle plugin on the buildscript classpath', () => {
    // The native-agent module is the only Kotlin module in this shell; without
    // this classpath entry Gradle fails at CONFIGURATION time with
    // "Plugin with id 'kotlin-android' not found" and no APK is ever produced.
    const root = read('android/build.gradle');
    expect(read('plugins/native-agent/android/build.gradle')).toContain("apply plugin: 'kotlin-android'");
    expect(root).toContain('org.jetbrains.kotlin:kotlin-gradle-plugin');
    expect(read('android/variables.gradle')).toMatch(/kotlinVersion\s*=/);
  });

  it('pins the Kotlin classpath version as a literal, not a buildscript variable', () => {
    // buildscript{} is evaluated in its own scope BEFORE variables.gradle is
    // applied, so `$kotlinVersion` there fails with
    // "Could not get unknown property 'kotlinVersion'" (this actually broke CI).
    const root = read('android/build.gradle');
    const line = root.split('\n').find((l) => l.includes('kotlin-gradle-plugin'))!;
    expect(line).toMatch(/kotlin-gradle-plugin:\d+\.\d+\.\d+'/);
    expect(line).not.toContain('$');
  });

  it('keeps the inlined Kotlin version in sync with variables.gradle', () => {
    const literal = read('android/build.gradle').match(/kotlin-gradle-plugin:([\d.]+)'/)![1];
    const declared = read('android/variables.gradle').match(/kotlinVersion = '([\d.]+)'/)![1];
    expect(literal).toBe(declared);
  });

  it('keeps the plugin minSdk at or below the app minSdk', () => {
    const plugin = Number(read('plugins/native-agent/android/build.gradle').match(/minSdkVersion (\d+)/)![1]);
    const app = Number(read('android/variables.gradle').match(/minSdkVersion = (\d+)/)![1]);
    expect(plugin).toBeLessThanOrEqual(app);
  });
});

describe('agent — native build-file correctness', () => {
  it('imports the BackgroundTasks framework, not the BGTaskScheduler class', () => {
    // `import BGTaskScheduler` compiles nowhere: BGTaskScheduler is a class
    // inside the BackgroundTasks framework. This broke the iOS CI build with
    // "unable to resolve module dependency: 'BGTaskScheduler'".
    const swiftFiles = [
      'plugins/native-agent/ios/Sources/NativeAgentPlugin/NativeAgentBackgroundTask.swift',
      'plugins/native-agent/ios/Sources/NativeAgentPlugin/NativeAgentPlugin.swift',
    ];
    for (const f of swiftFiles) {
      expect(read(f)).not.toMatch(/^import BGTaskScheduler$/m);
    }
    const bg = read(swiftFiles[0]);
    expect(bg).toMatch(/^import BackgroundTasks$/m);
    expect(bg).toContain('BGTaskScheduler.shared');
  });

  it('every non-system Swift import is guarded by canImport', () => {
    const dir = 'plugins/native-agent/ios/Sources/NativeAgentPlugin';
    const system = new Set(['Foundation', 'Capacitor', 'BackgroundTasks', 'UserNotifications', 'UIKit', 'Combine']);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.swift'))) {
      const src = read(path.join(dir, file));
      for (const m of src.matchAll(/^import (\w+)$/gm)) {
        if (system.has(m[1])) continue;
        // Optional dependencies must degrade gracefully when absent.
        expect(src, `${file}: 'import ${m[1]}' is not behind #if canImport`).toContain(`canImport(${m[1]})`);
      }
    }
  });

  it('declares consumerProguardFiles inside defaultConfig', () => {
    // On the android{} extension AGP fails with
    // "Could not find method consumerProguardFiles()".
    const gradle = read('plugins/native-agent/android/build.gradle');
    const defaultConfig = gradle.match(/defaultConfig \{[\s\S]*?\n    \}/)![0];
    expect(defaultConfig).toContain("consumerProguardFiles 'consumer-rules.pro'");
    // And the referenced file must actually exist, or the build fails later.
    expect(existsSync(path.join(process.cwd(), 'plugins/native-agent/android/consumer-rules.pro'))).toBe(true);
  });
});

describe('agent — native API correctness (compile failures caught in CI)', () => {
  it('uses real framework JobScheduler APIs only', () => {
    const src = read('plugins/native-agent/android/src/main/java/com/t6x/plugins/nativeagent/NativeAgentSchedule.kt');
    // android.app.job.PeriodicJobRequest does not exist in the Android SDK;
    // periodic jobs are built with JobInfo.Builder(...).setPeriodic(...).
    expect(src).not.toContain('PeriodicJobRequest');
    expect(src).toContain('JobInfo.Builder(JOB_ID, service)');
    expect(src).toMatch(/import android\.content\.ComponentName/);
    // setPersisted requires RECEIVE_BOOT_COMPLETED, which the plugin does not
    // declare — calling it would throw at runtime.
    const manifest = read('plugins/native-agent/android/src/main/AndroidManifest.xml');
    if (!manifest.includes('RECEIVE_BOOT_COMPLETED')) {
      expect(src).not.toContain('setPersisted(true)');
    }
  });

  it('exposes the UniFFI C header as a SwiftPM module target', () => {
    // A binaryTarget's headers are not importable from Swift; without a real
    // target the generated bindings fail with "cannot find type 'RustBuffer'".
    const pkg = read('plugins/native-agent/Package.swift');
    expect(pkg).toContain('name: "native_agent_ffiFFI"');
    expect(read('plugins/native-agent/ios/Sources/NativeAgentPlugin/Generated/native_agent_ffi.swift'))
      .toContain('canImport(native_agent_ffiFFI)');
    for (const f of [
      'plugins/native-agent/ios/Sources/native_agent_ffiFFI/include/native_agent_ffiFFI.h',
      'plugins/native-agent/ios/Sources/native_agent_ffiFFI/include/module.modulemap',
    ]) {
      expect(existsSync(path.join(process.cwd(), f)), `missing ${f}`).toBe(true);
    }
  });

  it('keeps the shim header identical to the xcframework header', () => {
    const a = read('plugins/native-agent/ios/Sources/native_agent_ffiFFI/include/native_agent_ffiFFI.h');
    const b = read('plugins/native-agent/ios/Sources/NativeAgentPlugin/Generated/native_agent_ffiFFI.h');
    expect(a).toBe(b);
  });
});
