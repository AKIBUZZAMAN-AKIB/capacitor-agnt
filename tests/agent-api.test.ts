import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Differential contract tests for the on-device Rust AI agent plugin.
//
// These read the REAL sources (Kotlin plugin, Swift plugin, TS definitions, the
// trusted bridge, the demo lab, the Rust crate and the ABI tooling) and prove
// they agree with each other.
//
// The plugin is pinned to the PUBLIC upstream generation "0.5.2"
// (docs/AGENT-ENGINE-0.5.2-BACKPORT.bn.md) because only that tag ships the Rust
// crate source publicly — which is what makes a 4-ABI build (armeabi-v7a
// included) reproducible for anyone. That pinning has consequences this file
// now enforces:
//   1. the UniFFI contract version on both sides must be the 0.5.2 one (26),
//   2. the crash-safety / optional-dependency fixes backported from 0.9.x must
//      stay in place (catch Throwable, lancedb gating on both platforms),
//   3. the five newer-engine APIs are compat shims in the bridge and must never
//      be called on the native plugin — the wake/surfaced ones are answered by
//      the PhoneBuddy engine instead (tests/phonebuddy-api.test.ts),
//   4. the private-repo submodule must never come back.

const root = process.cwd();
const read = (relative: string) => readFileSync(path.join(root, relative), 'utf8');
const unique = <T,>(arr: T[]) => [...new Set(arr)];

const KOTLIN = 'plugins/native-agent/android/src/main/java/com/t6x/plugins/nativeagent/NativeAgentPlugin.kt';
const SWIFT = 'plugins/native-agent/ios/Sources/NativeAgentPlugin/NativeAgentPlugin.swift';
const DEFS = 'plugins/native-agent/src/definitions.ts';
const PLUGIN_GRADLE = 'plugins/native-agent/android/build.gradle';
const PACKAGE_SWIFT = 'plugins/native-agent/Package.swift';
const CRATE = 'plugins/native-agent/rust/native-agent-ffi';
const BRIDGE = 'bridge/nativekit.ts';
const LAB = 'www/agent-lab.js';
const HTML = 'www/index.html';

/** @PluginMethod-annotated Kotlin methods = the Android API surface. */
function kotlinMethods(): string[] {
  return unique([...read(KOTLIN).matchAll(/@PluginMethod\s+fun (\w+)\(/g)].map((m) => m[1])).sort();
}

/** CAPPluginMethod(name:) entries = the iOS API surface actually exported to JS. */
function swiftExportedMethods(): string[] {
  return unique([...read(SWIFT).matchAll(/CAPPluginMethod\(name:\s*"(\w+)"/g)].map((m) => m[1])).sort();
}

/** @objc func ... = the iOS implementations. */
function swiftImplMethods(): string[] {
  return unique([...read(SWIFT).matchAll(/@objc func (\w+)\(_ call: CAPPluginCall\)/g)].map((m) => m[1]));
}

/** `NativeAgent.<name>(` calls made by the trusted bridge. */
function bridgeNativeCalls(): Set<string> {
  return new Set(unique([...read(BRIDGE).matchAll(/NativeAgent\.(\w+)\(/g)].map((m) => m[1])));
}

/** The agent namespace block of the bridge. */
function bridgeAgentBlock(): string {
  const block = read(BRIDGE).match(/\n  agent: \{[\s\S]*?\n  \},\n\};/);
  expect(block, 'agent namespace not found in bridge/nativekit.ts').not.toBeNull();
  return block![0];
}

describe('agent plugin — cross-platform contract', () => {
  it('Android and iOS expose exactly the same JS method names', () => {
    const android = kotlinMethods();
    const ios = swiftExportedMethods();
    expect(android.length).toBeGreaterThan(40);

    const missingOnIos = android.filter((m) => !ios.includes(m));
    const missingOnAndroid = ios.filter((m) => !android.includes(m));
    expect(missingOnIos, `implemented on Android but not exported on iOS: ${missingOnIos}`).toEqual([]);
    expect(missingOnAndroid, `exported on iOS but missing on Android: ${missingOnAndroid}`).toEqual([]);
  });

  it('every iOS-exported method has a matching @objc implementation', () => {
    const impl = new Set(swiftImplMethods());
    for (const method of swiftExportedMethods()) {
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

  it('exposes the availability probe on both platforms', () => {
    expect(kotlinMethods()).toContain('checkAvailability');
    expect(swiftExportedMethods()).toContain('checkAvailability');
    expect(read(DEFS)).toMatch(/checkAvailability\(\): Promise<AgentAvailabilityResult>/);
  });
});

describe('agent plugin — parameter-name parity (the removeSkill bug class)', () => {
  const kotlin = read(KOTLIN);
  const swift = read(SWIFT);

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

    for (const key of kotlinKeys!) {
      expect(
        swiftKeys!.includes(key),
        `${method}: Android reads "${key}" but iOS reads ${JSON.stringify(swiftKeys)}`,
      ).toBe(true);
    }
  });

  it('the bridge translates the divergent keys instead of guessing', () => {
    // 0.5.2 takes `{ id }` for removeSkill while the bridge API is skillId-based.
    expect(read(BRIDGE)).toMatch(/NativeAgent\.removeSkill\(\{ id: skillId \}\)/);
    expect(read(BRIDGE)).toMatch(/loadSession\(\{ sessionKey, agentId: agentId \?\? 'main' \}\)/);
  });
});

describe('agent plugin — crash-safety and pinned-generation backports', () => {
  it('Kotlin catches Throwable, not just Exception (UnsatisfiedLinkError)', () => {
    const kotlin = read(KOTLIN);
    // An unsupported-ABI device throws UnsatisfiedLinkError, which is an Error
    // and would escape `catch (e: Exception)` → native crash + hung promises.
    expect(kotlin).toMatch(/catch \(t: Throwable\)/);
    expect(kotlin).toMatch(/if \(t is OutOfMemoryError\) throw t/);
    expect(kotlin, 'no coroutine body may go back to catching Exception only')
      .not.toMatch(/catch \(e: Exception\)/);
  });

  it('checkAvailability resolves on both platforms and never rejects', () => {
    const kotlinBody = read(KOTLIN).match(/fun checkAvailability\(call: PluginCall\)[\s\S]{0,1400}?\n    \}/)![0];
    expect(kotlinBody).toContain('call.resolve(ret)');
    expect(kotlinBody).not.toContain('call.reject');

    const swiftBody = read(SWIFT).match(/@objc func checkAvailability\(_ call: CAPPluginCall\)[\s\S]{0,1600}?\n    \}/)![0];
    expect(swiftBody).toContain('call.resolve([');
    expect(swiftBody).not.toContain('call.reject');
  });

  it('probes availability with the same library name uniffi loads', () => {
    // UniffiLib.INSTANCE -> loadIndirect(componentName = "native_agent_ffi")
    // -> Native.load(findLibraryName(...)) == "native_agent_ffi".
    expect(read(KOTLIN)).toMatch(/Native\.load\("native_agent_ffi", NativeProbeLib::class\.java\)/);
    const binding = read('plugins/native-agent/android/src/main/java/uniffi/native_agent_ffi/native_agent_ffi.kt');
    expect(binding).toContain('loadIndirect<UniffiLib>(componentName = "native_agent_ffi")');
  });
});

describe('agent plugin — pinned generation (0.5.2) integrity', () => {
  it('keeps the UniFFI contract version aligned with the vendored crate', () => {
    const binding = read('plugins/native-agent/android/src/main/java/uniffi/native_agent_ffi/native_agent_ffi.kt');
    const committed = binding.match(/val bindings_contract_version = (\d+)/)![1];
    expect(committed, 'committed Kotlin bindings must be the 0.5.2 generation').toBe('26');

    // uniffi 0.28.x == contract version 26; the crate pins it in Cargo.toml.
    const cargo = read(`${CRATE}/Cargo.toml`);
    expect(cargo).toMatch(/uniffi = \{ version = "0\.28"/);

    // The crate must still produce the library name the Kotlin binding loads.
    expect(cargo).toMatch(/^\s*name = "native_agent_ffi"$/m);
  });

  it('ships the crate source in-repo and has no private-repo dependency', () => {
    for (const f of [`${CRATE}/Cargo.toml`, `${CRATE}/Cargo.lock`, `${CRATE}/src/lib.rs`, `${CRATE}/VENDOR-MANIFEST.json`]) {
      expect(existsSync(path.join(root, f)), `missing vendored crate file: ${f}`).toBe(true);
    }
    expect(existsSync(path.join(root, 'plugins/native-agent/.gitmodules'))).toBe(false);
    expect(read(`${CRATE}/src/lib.rs`)).toContain('uniffi::setup_scaffolding!()');
    // No tracked file may point at the private GitLab again.
    expect(read(`${CRATE}/VENDOR-MANIFEST.json`)).toContain('"fileCount"');
  });

  it('gates the optional lancedb dependency (Gradle) and keeps its sources out of the main set', () => {
    const gradle = read(PLUGIN_GRADLE);
    expect(gradle).toMatch(/def hasLanceDb = project\.findProject\(':capacitor-lancedb'\) != null/);
    expect(gradle).toMatch(/if \(hasLanceDb\) \{\s*android\.sourceSets\.main\.java\.srcDir\('src\/main\/java-memory'\)/);
    expect(gradle).toMatch(/if \(hasLanceDb\) \{\s*compileOnly project\(':capacitor-lancedb'\)/);

    // Compile-time references to lancedb would break every app that does not
    // include it, so those files must live in the gated source set.
    const mainDir = 'plugins/native-agent/android/src/main/java/com/t6x/plugins/nativeagent';
    const gatedDir = 'plugins/native-agent/android/src/main/java-memory/com/t6x/plugins/nativeagent';
    for (const f of ['LanceDBBridge.kt', 'MemoryProviderImpl.kt']) {
      expect(existsSync(path.join(root, mainDir, f)), `${f} must not be in the main source set`).toBe(false);
      expect(existsSync(path.join(root, gatedDir, f)), `${f} must exist in the gated source set`).toBe(true);
    }
    // …and the plugin wires it reflectively.
    expect(read(KOTLIN)).toContain('Class.forName("com.t6x.plugins.nativeagent.MemoryProviderImpl")');
  });

  it('exposes the UniFFI C header as a SwiftPM target the bindings can import', () => {
    // A binaryTarget's headers are not importable from Swift under SwiftPM: the
    // generated bindings' `#if canImport(native_agent_ffiFFI)` is false without a
    // real C target, and the build then fails with
    // "cannot find 'uniffi_native_agent_ffi_checksum_...' in scope".
    const pkg = read(PACKAGE_SWIFT);
    expect(pkg).toContain('name: "native_agent_ffiFFI"');
    expect(pkg).toMatch(/"native_agent_ffiFFI"\s*\n\s*\]/);
    expect(read('plugins/native-agent/ios/Sources/NativeAgentPlugin/Generated/native_agent_ffi.swift'))
      .toContain('canImport(native_agent_ffiFFI)');

    // The shim header must be a byte-for-byte copy of the header inside the
    // xcframework, or Swift compiles against a different ABI than it links.
    const shim = read('plugins/native-agent/ios/Sources/native_agent_ffiFFI/include/native_agent_ffiFFI.h');
    const shipped = read('plugins/native-agent/ios/Frameworks/NativeAgentFFI.xcframework/ios-arm64/Headers/native_agent_ffi/native_agent_ffiFFI.h');
    expect(shim).toBe(shipped);
    expect(shim).toContain('checksum_method_nativeagenthandle_send_message');
    expect(existsSync(path.join(root, 'plugins/native-agent/ios/Sources/native_agent_ffiFFI/include/module.modulemap'))).toBe(true);
    // A C target with no translation unit makes Xcode look for a
    // <target>.o that never gets produced ("Build input file cannot be found:
    // native_agent_ffiFFI.o"), so the shim needs one (intentionally empty) file.
    expect(existsSync(path.join(root, 'plugins/native-agent/ios/Sources/native_agent_ffiFFI/shim.c'))).toBe(true);
  });

  it('every handle call in the Swift plugin matches the regenerated bindings', () => {
    // The 0.5.2 tag ships a stale xcframework (see build-ios-xcframework.sh), so
    // the bindings in this repo are regenerated from the vendored crate. That
    // makes it possible for the plugin to call a handle member with a parameter
    // list the bindings no longer declare — which is exactly how the iOS build
    // broke twice. Check names AND option labels.
    const plugin = read('plugins/native-agent/ios/Sources/NativeAgentPlugin/NativeAgentPlugin.swift');
    const bindings = read('plugins/native-agent/ios/Sources/NativeAgentPlugin/Generated/native_agent_ffi.swift');

    const sigs = new Map<string, Set<string>>();
    for (const m of bindings.matchAll(/(?:open|public) func (\w+)\(([^)]*)\)/g)) {
      const labels = new Set(
        m[2]
          .split(',')
          .map((a) => a.split(':')[0].trim())
          .filter((a) => a.length > 0),
      );
      const set = sigs.get(m[1]) ?? new Set<string>();
      for (const l of labels) set.add(l);
      sigs.set(m[1], set);
    }
    expect(sigs.size, 'no handle API found in the generated bindings').toBeGreaterThan(20);

    const problems: string[] = [];
    for (const m of plugin.matchAll(/\bh\.(\w+)\(/g)) {
      const name = m[1];
      if (!sigs.has(name)) {
        problems.push(`${name} is not declared in the bindings`);
        continue;
      }
      let depth = 1;
      let i = m.index! + m[0].length;
      while (i < plugin.length && depth > 0) {
        if (plugin[i] === '(') depth += 1;
        else if (plugin[i] === ')') depth -= 1;
        i += 1;
      }
      const call = plugin.slice(m.index! + m[0].length, i - 1);
      const declared = sigs.get(name)!;
      for (const label of call.matchAll(/(?:^|,)\s*(\w+):/g)) {
        // labels of nested struct initialisers are not parameters of the call
        if (!declared.has(label[1])) problems.push(`${name}(_): unknown parameter '${label[1]}'`);
      }
    }
    expect(problems, problems.join('; ')).toEqual([]);
  });

  it('does not hard-depend on capacitor-lancedb in Package.swift (C3 fix)', () => {
    const pkg = read(PACKAGE_SWIFT);
    expect(pkg).not.toMatch(/\.package\(path:/);
    expect(pkg).not.toMatch(/product\(name: "CapacitorLancedb"/);
    // The Swift memory provider must stay behind canImport guards.
    expect(read('plugins/native-agent/ios/Sources/NativeAgentPlugin/LanceDBBridge.swift'))
      .toContain('#if canImport(');
  });

  it('keeps the ABI tooling and CI wiring that makes armeabi-v7a builds possible', () => {
    const builder = read('tools/agent-ffi/build-android-all-abis.sh');
    for (const abi of ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86']) {
      expect(builder, `build script must know about ${abi}`).toContain(abi);
    }
    expect(builder).toContain('--require-binding-match');
    expect(existsSync(path.join(root, 'tools/agent-ffi/verify-abis.sh'))).toBe(true);
    expect(existsSync(path.join(root, 'tools/agent-ffi/resolve-ffi-source.sh'))).toBe(true);

    const wf = read('.github/workflows/native-agent-ffi.yml');
    expect(wf).toContain('armeabi-v7a');
    expect(wf).toContain('release-asset');
    expect(wf).toContain('public-upstream');
  });
});

describe('agent — bridge and demo wiring', () => {
  it('exposes every native method through NativeKit.agent', () => {
    const calls = bridgeNativeCalls();
    const shimmed = new Set([
      // compat shims: implemented in the bridge because 0.5.2 has no such native method
      'scheduleBackgroundWakes',
      'cancelBackgroundWakes',
      'loadSurfacedMessages',
      'setMcpTools',
      'addListener', // wrapped as agent.onEvent
    ]);
    for (const method of kotlinMethods()) {
      if (shimmed.has(method)) continue;
      expect(method, `native method ${method} is shimmed but also native?`).toBeTruthy();
      expect(calls.has(method), `native method '${method}' is not wired in bridge/nativekit.ts`).toBe(true);
    }
  });

  it('never calls the newer-engine APIs on the native plugin', () => {
    const calls = bridgeNativeCalls();
    for (const absent of ['scheduleBackgroundWakes', 'cancelBackgroundWakes', 'loadSurfacedMessages', 'setMcpTools']) {
      expect(calls.has(absent), `NativeAgent.${absent}() does not exist in the 0.5.2 plugin`).toBe(false);
      expect(kotlinMethods(), `${absent} must not exist on the pinned Kotlin plugin`).not.toContain(absent);
    }
  });

  it('routes the wake/surfaced APIs to the PhoneBuddy engine, with an honest fallback', () => {
    const block = bridgeAgentBlock();
    const routed = [
      'scheduleBackgroundWakes',
      'cancelBackgroundWakes',
      'getWakeStatus',
      'loadSurfacedMessages',
      'clearSurfacedMessages',
    ];
    for (const name of routed) {
      const m = block.match(new RegExp(`^    ${name}: async \\([\\s\\S]*?\\n    \\},`, 'm'));
      expect(m, `${name} shim not found`).not.toBeNull();
      // The capability really exists now (PhoneBuddy engine), so the shim must
      // call it rather than short-circuiting to an "unsupported" envelope.
      expect(m![0], `${name} must be answered by the PhoneBuddy engine`).toContain(`'${name}'`);
      expect(m![0], `${name} must call PhoneBuddyAgent`).toMatch(/phoneBuddyCall\(/);
      // …but a device/build without that engine still gets a truthful envelope
      // instead of a rejection or a fake success.
      expect(m![0], `${name} needs a supported:false fallback`).toContain('supported: false');
      expect(m![0], `${name} must explain the fallback`).toContain('reason:');
    }
    // setMcpTools is mapped onto the closest native capability.
    expect(block).toMatch(/setMcpTools→restartMcp/);
  });

  it('degrades to the fallback instead of rejecting when the engine is missing', () => {
    const block = bridgeAgentBlock();
    // phoneBuddyCall() is the single place that talks to the PhoneBuddy plugin,
    // and it may never reject: web builds, unsupported ABIs and disabled
    // features all have to come back as data.
    const helper = read(BRIDGE).match(/async function phoneBuddyCall\([\s\S]*?\n\}/)![0];
    expect(helper).toContain('catch (error)');
    expect(helper).toContain('return { ...fallback }');
    expect(helper).not.toContain('throw');
    expect(block).toMatch(/^    phonebuddy: \{/m);
    expect(block).toContain('generation: PHONEBUDDY_GENERATION');
  });

  it('gates every agent call behind the feature flag and a native check', () => {
    const body = bridgeAgentBlock();
    const starts = [...body.matchAll(/^    (\w+): (?:async )?\(/gm)];
    const fns = starts.map((m, i) => {
      const from = m.index!;
      const to = i + 1 < starts.length ? starts[i + 1].index! : body.length;
      return [m[1], body.slice(from, to)] as [string, string];
    });
    expect(fns.length).toBeGreaterThan(40);
    for (const [name, fnBody] of fns) {
      if (name === 'supported' || name === 'engineGeneration') {
        // pure metadata accessors: `supported` is the feature gate itself
        continue;
      }
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
    const apis = unique(
      [...bridgeAgentBlock().matchAll(/^    (\w+): (?:async )?\(/gm)].map((m) => m[1]),
    ).filter((n) => n !== 'supported' && n !== 'engineGeneration');

    const labCalls = new Set(unique([...lab.matchAll(/NativeKit\.agent\.(\w+)\(/g)].map((m) => m[1])));
    for (const api of apis) {
      expect(labCalls.has(api), `NativeKit.agent.${api} has no demo-lab test`).toBe(true);
    }
  });

  it('every demo-lab action has a button in index.html and vice versa', () => {
    const actions = unique([...read(LAB).matchAll(/^  (agent\w+): async/gm)].map((m) => m[1]));
    const buttons = unique([...read(HTML).matchAll(/data-agent-action="(\w+)"/g)].map((m) => m[1]));
    expect(actions.length).toBeGreaterThan(40);
    for (const action of actions) {
      expect(buttons.includes(action), `action '${action}' has no button`).toBe(true);
    }
    for (const button of buttons) {
      expect(actions.includes(button), `button '${button}' has no action`).toBe(true);
    }
  });
});

describe('agent — Android Gradle toolchain', () => {
  it('puts the Kotlin Gradle plugin on the buildscript classpath', () => {
    expect(read(PLUGIN_GRADLE)).toContain("apply plugin: 'kotlin-android'");
    expect(read('android/build.gradle')).toContain('org.jetbrains.kotlin:kotlin-gradle-plugin');
    expect(read('android/variables.gradle')).toMatch(/kotlinVersion\s*=/);
  });

  it('pins the Kotlin classpath version as a literal, not a buildscript variable', () => {
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
    const plugin = Number(read(PLUGIN_GRADLE).match(/minSdkVersion (\d+)/)![1]);
    const app = Number(read('android/variables.gradle').match(/minSdkVersion = (\d+)/)![1]);
    expect(plugin).toBeLessThanOrEqual(app);
  });

  it('declares consumerProguardFiles inside defaultConfig with a real file', () => {
    const defaultConfig = read(PLUGIN_GRADLE).match(/defaultConfig \{[\s\S]*?\n    \}/)![0];
    expect(defaultConfig).toContain("consumerProguardFiles 'consumer-rules.pro'");
    expect(existsSync(path.join(root, 'plugins/native-agent/android/consumer-rules.pro'))).toBe(true);
    expect(read('plugins/native-agent/android/consumer-rules.pro')).toContain('uniffi');
  });
});

describe('agent — native build-file correctness', () => {
  it('every non-system Swift import is guarded by canImport', () => {
    const dir = 'plugins/native-agent/ios/Sources/NativeAgentPlugin';
    const system = new Set(['Foundation', 'Capacitor', 'BackgroundTasks', 'UserNotifications', 'UIKit', 'Combine']);
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.swift'))) {
      const src = read(path.join(dir, file));
      for (const m of src.matchAll(/^import (\w+)$/gm)) {
        if (system.has(m[1])) continue;
        expect(src, `${file}: 'import ${m[1]}' is not behind #if canImport`).toContain(`canImport(${m[1]})`);
      }
    }
  });

  it('documents exactly the slices the pinned xcframework ships', () => {
    const plist = read('plugins/native-agent/ios/Frameworks/NativeAgentFFI.xcframework/Info.plist');
    const ids = [...plist.matchAll(/<key>LibraryIdentifier<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]).sort();
    expect(ids).toEqual(['ios-arm64', 'ios-arm64-simulator']);
  });

  it('builds the Simulator app for arm64 only', () => {
    // The pinned xcframework has no x86_64-simulator slice, so an Intel slice
    // fails to link ("Undefined symbols for architecture x86_64").
    expect(read('.github/workflows/ios.yml')).toContain('ARCHS=arm64');
  });
});

describe('shell plugins — Java imports', () => {
  it('imports android.view.Gravity where Gravity is used', () => {
    const f = 'plugins/widget/android/src/main/java/dev/nativekit/widget/NativeKitWidgetProvider.java';
    const src = read(f);
    if (/\bGravity\./.test(src)) {
      expect(src).toContain('import android.view.Gravity;');
    }
  });
});
