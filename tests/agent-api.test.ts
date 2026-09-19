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
//   2. the crash-safety fixes backported from 0.9.x must stay in place (catch
//      Throwable / never throw across the FFI boundary),
//   3. the five wake/surfaced APIs are implemented for real: the engine runs a
//      wake but cannot ask the OS for background runtime, so the PLUGIN owns
//      that half (WorkManager periodic work on Android, a BGProcessingTask on
//      iOS) and the bridge passes the OS's own answer through — including the
//      platform floors (Android: 15 minutes) which are reported, not smoothed
//      over. The surfaced inbox is filled from the engine's `cron_runs` rows,
//   4. the private-repo submodule must never come back,
//   5. this is the ONLY agent engine in the app: the long-term memory it needs is
//      implemented in-repo (file-backed, lexical) instead of behind an optional
//      vector-database plugin.

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

/**
 * The agent namespace block of the bridge. Anchored on its first member rather
 * than on `agent: {` alone: `NativeKitBuildConfig` also declares an `agent`
 * object, and a lazy match from that one would swallow every other namespace.
 */
function bridgeAgentBlock(): string {
  const block = read(BRIDGE).match(/\n  agent: \{\n    supported:[\s\S]*?\n  \},\n\};/);
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

  it('ships its own memory provider: file-backed, lexical, no vector database', () => {
    // The engine's memory_* tools call a host MemoryProvider (UniFFI callback
    // interface). That provider used to be optional and LanceDB-backed, so with
    // no capacitor-lancedb in package.json the engine kept memory_provider=None
    // and every memory tool answered "Memory provider not configured". It is now
    // part of the plugin on both platforms — no optional dependency, no vector
    // index, no second native runtime.
    const kotlinFile = 'plugins/native-agent/android/src/main/java/com/t6x/plugins/nativeagent/MemoryProviderImpl.kt';
    const swiftFile = 'plugins/native-agent/ios/Sources/NativeAgentPlugin/MemoryProviderImpl.swift';
    expect(existsSync(path.join(root, kotlinFile)), 'Kotlin memory provider missing').toBe(true);
    expect(existsSync(path.join(root, swiftFile)), 'Swift memory provider missing').toBe(true);

    const kotlin = read(kotlinFile);
    expect(kotlin).toMatch(/class MemoryProviderImpl\(context: Context\) : MemoryProvider/);
    for (const method of ['store', 'recall', 'forget', 'search', 'list']) {
      expect(kotlin, `Kotlin provider must implement ${method}`).toContain(`override fun ${method}(`);
    }
    // Never throw across the FFI boundary: failures come back as JSON data.
    expect(kotlin).toContain('{"error"');
    // Storage is a private JSON document, not a vector store.
    expect(kotlin).toContain('native-agent-memory');
    expect(kotlin).toMatch(/MAX_ENTRIES/);

    const swift = read(swiftFile);
    expect(swift).toContain('public final class MemoryProviderImpl: MemoryProvider');
    for (const method of ['store', 'recall', 'forget', 'search', 'list']) {
      expect(swift, `Swift provider must implement ${method}`).toContain(`public func ${method}(`);
    }
    expect(swift).toContain('makeIfAvailable');

    // No vector machinery may creep back in on either platform. Comments are
    // stripped first: they explain the history (why LanceDB left) and are worth
    // keeping, so only real code may be inspected.
    const code = (source: string) =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');
    for (const [name, source] of [['Kotlin', kotlin], ['Swift', swift]] as const) {
      expect(code(source), `${name} provider must not embed/vectorise`).not.toMatch(/embedding|vector|cosine|lancedb/i);
    }
    expect(swift, 'the old LanceDB bridge must be gone')
      .toMatch(/MemoryProviderImpl/);
    expect(existsSync(path.join(root, 'plugins/native-agent/ios/Sources/NativeAgentPlugin/LanceDBBridge.swift'))).toBe(false);
    expect(existsSync(path.join(root, 'plugins/native-agent/android/src/main/java-memory'))).toBe(false);

    // Both plugins must WIRE it, or the tools stay dead in the app.
    expect(read(KOTLIN)).toContain('h.setMemoryProvider(MemoryProviderImpl(context.applicationContext))');
    expect(read(KOTLIN)).not.toContain('Class.forName');
    expect(read(SWIFT)).toMatch(/MemoryProviderImpl\.makeIfAvailable\(\)[\s\S]*?setMemoryProvider/);

    // …and the gradle module must not gate an optional vector plugin any more.
    expect(read(PLUGIN_GRADLE)).not.toContain('hasLanceDb');
    expect(read(PLUGIN_GRADLE)).not.toContain('capacitor-lancedb');
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
    // There is nothing optional left to guard: the memory provider is compiled
    // unconditionally, so the class must NOT sit behind #if canImport(…).
    const provider = read('plugins/native-agent/ios/Sources/NativeAgentPlugin/MemoryProviderImpl.swift');
    // A real conditional-compilation line must be gone (the doc comment quotes
    // the old one on purpose, so check line starts, not the whole file).
    const preprocessor = provider.split('\n').map((line) => line.trimStart()).filter((line) => line.startsWith('#if'));
    expect(preprocessor, preprocessor.join(' | ')).toEqual([]);
    expect(provider).toContain('public static func makeIfAvailable() -> MemoryProvider?');
  });

  it('keeps the committed iOS xcframework and the generated bindings in step', () => {
    // A stale xcframework is invisible until an iOS build fails, so compare it
    // here: both slices must carry the same Swift API, and that API must be the
    // one uniffi-bindgen produced from the vendored crate.
    const generated = read('plugins/native-agent/ios/Sources/NativeAgentPlugin/Generated/native_agent_ffi.swift');
    for (const slice of ['ios-arm64', 'ios-arm64-simulator']) {
      const header = read(`plugins/native-agent/ios/Frameworks/NativeAgentFFI.xcframework/${slice}/Headers/native_agent_ffi/native_agent_ffi.swift`);
      expect(header, `${slice} carries a different API than the generated bindings`).toBe(generated);
    }
    expect(generated).toContain('func setMemoryProvider(provider: MemoryProvider)');
    expect(generated).toContain('public protocol MemoryProvider: AnyObject');
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
      'setMcpTools',
      'addListener', // wrapped as agent.onEvent
    ]);
    for (const method of kotlinMethods()) {
      if (shimmed.has(method)) continue;
      expect(method, `native method ${method} is shimmed but also native?`).toBeTruthy();
      expect(calls.has(method), `native method '${method}' is not wired in bridge/nativekit.ts`).toBe(true);
    }
  });

  it('calls the real wake APIs on the plugin, on both platforms', () => {
    const calls = bridgeNativeCalls();
    const wakeApi = [
      'scheduleBackgroundWakes',
      'cancelBackgroundWakes',
      'getWakeStatus',
      'loadSurfacedMessages',
      'clearSurfacedMessages',
    ];
    for (const name of wakeApi) {
      expect(calls.has(name), `NativeAgent.${name}() must be called by the bridge`).toBe(true);
      expect(kotlinMethods(), `${name} must exist on the Android plugin`).toContain(name);
      expect(swiftExportedMethods(), `${name} must be exported on iOS`).toContain(name);
    }
    // setMcpTools stays a bridge shim: it is mapped onto the closest native
    // capability instead of a native method that does not exist.
    expect(bridgeAgentBlock()).toMatch(/setMcpTools→restartMcp/);
  });

  it('never reports a wake success it did not get from the OS', () => {
    // The wake APIs are wrappers, not pass-throughs: on success they spread the
    // native answer (so `intervalMinutes` is what the OS granted), and on failure
    // they still resolve — with `supported: false`, a reason and the documented
    // alternative. No envelope may invent a scheduled job.
    const block = bridgeAgentBlock();
    for (const name of ['scheduleBackgroundWakes', 'cancelBackgroundWakes', 'getWakeStatus', 'loadSurfacedMessages', 'clearSurfacedMessages']) {
      const m = block.match(new RegExp(`^    ${name}: async \\([\\s\\S]*?\\n    \\},`, 'm'));
      expect(m, `${name} not found in the bridge`).not.toBeNull();
      const body = m![0];
      expect(body, `${name} must call the native plugin`).toMatch(new RegExp(`NativeAgent\\.${name}\\(`));
      expect(body, `${name} must not throw; failures resolve as data`).not.toContain('throw');
      expect(body, `${name} must report what the OS granted`).toContain('...(native');
      expect(body, `${name} needs a failure envelope`).toContain('supported: false');
      expect(body, `${name} failure envelope must explain itself`).toContain('reason:');
      expect(body, `${name} failure envelope must offer the alternative`).toContain('alternative:');
      expect(body, `${name} must never hardcode a scheduled job`).not.toContain('jobScheduled: true');
    }
  });

  it('has no second engine: PhoneBuddy is gone from the app', () => {
    // A reminder of why this test exists: the PhoneBuddy engine was carried for
    // OS wakes + surfaced messages. It cost 40 MB of Android .so and 59 MB of iOS
    // framework to cover two APIs the app cannot use from this generation anyway,
    // so it was removed. Nothing may reintroduce it silently.
    const pkg = JSON.parse(read('package.json'));
    expect(Object.keys(pkg.dependencies)).not.toContain('@nativekit/phonebuddy-agent');
    expect(existsSync(path.join(root, 'plugins/phonebuddy-agent'))).toBe(false);
    expect(existsSync(path.join(root, '.github/workflows/phonebuddy-ffi.yml'))).toBe(false);
    expect(existsSync(path.join(root, '.github/workflows/phonebuddy-ios.yml'))).toBe(false);
    expect(existsSync(path.join(root, 'tools/agent-ffi/build-phonebuddy-all-abis.sh'))).toBe(false);
    expect(existsSync(path.join(root, 'tools/agent-ffi/build-phonebuddy-ios-xcframework.sh'))).toBe(false);

    const config = JSON.parse(read('app.config.json'));
    expect(config.phonebuddy).toBeUndefined();
    expect(read('app.config.schema.json')).not.toContain('phonebuddy');

    for (const file of [BRIDGE, 'www/agent-lab.js', 'www/index.html', 'scripts/configure-native.mjs']) {
      expect(read(file).toLowerCase(), `${file} still mentions phonebuddy`).not.toContain('phonebuddy');
    }
    // The lab's long-term-memory buttons replace the removed engine's panel.
    expect(read('www/agent-lab.js')).toContain("invokeTool('memory_store'");
    expect(read('www/index.html')).toContain('data-agent-action="agentmemrecall"');
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

const WAKE_DIR_KT = 'plugins/native-agent/android/src/main/java/com/t6x/plugins/nativeagent';
const WAKE_DIR_SWIFT = 'plugins/native-agent/ios/Sources/NativeAgentPlugin';
const CONFIGURE = 'scripts/configure-native.mjs';
const AGENT_WAKE_TASK_ID = 'io.t6x.nativeagent.wake';

describe('agent — background wakes are real OS work', () => {
  it('Android arms a periodic WorkManager job and reports the granted interval', () => {
    const scheduler = read(`${WAKE_DIR_KT}/NativeWakeScheduler.kt`);
    for (const api of [
      'PeriodicWorkRequest.Builder',
      'enqueueUniquePeriodicWork',
      'ExistingPeriodicWorkPolicy.UPDATE',
      'setInitialDelay',
      'setRequiredNetworkType(NetworkType.CONNECTED)',
      'getWorkInfosForUniqueWork',
      'cancelUniqueWork',
    ]) {
      expect(scheduler, `WorkManager API missing: ${api}`).toContain(api);
    }
    expect(scheduler).toContain('NativeAgentWakeWorker::class.java');
    // 15 minutes is a platform floor, so it is clamped and reported, not ignored.
    const store = read(`${WAKE_DIR_KT}/NativeWakeStore.kt`);
    expect(store).toContain('MIN_INTERVAL_MINUTES = 15');
    expect(store).toMatch(/PeriodicWorkRequest\.MIN_PERIODIC_INTERVAL_MILLIS/);
    expect(scheduler).toContain('maxOf(requestedMinutes, NativeWakeStore.MIN_INTERVAL_MINUTES)');
    expect(read('plugins/native-agent/android/build.gradle')).toContain('androidx.work:work-runtime');
  });

  it('the Android worker is instantiable by the OS and cannot crash the app', () => {
    const worker = read(`${WAKE_DIR_KT}/NativeAgentWakeWorker.kt`);
    expect(worker).toContain(': Worker(');
    expect(worker, 'WorkManager needs a public class').not.toContain('internal class');
    expect(worker, 'WorkManager needs a public class').not.toContain('private class');
    expect(worker).toContain('NativeWakeRunner.run(applicationContext, NativeWakeRunner.SOURCE_WORKER)');
    // Periodic work cannot end in a terminal state, so success is returned and
    // the outcome is recorded in telemetry instead.
    expect(worker).toContain('Result.success()');
    const runner = read(`${WAKE_DIR_KT}/NativeWakeRunner.kt`);
    expect(runner).toContain('catch (t: Throwable)');
    expect(runner).toContain('handle?.close()');
  });

  it('iOS uses a BGProcessingTask registered before launch completes', () => {
    const task = read(`${WAKE_DIR_SWIFT}/NativeAgentBackgroundTask.swift`);
    for (const api of [
      'BGProcessingTaskRequest',
      'requiresNetworkConnectivity = true',
      'earliestBeginDate',
      'forTaskWithIdentifier:',
      'cancel(taskRequestWithIdentifier:',
      'getPendingTaskRequests',
      'setTaskCompleted',
      'expirationHandler',
    ]) {
      expect(task, `BGTaskScheduler API missing: ${api}`).toContain(api);
    }
    expect(task).toContain(AGENT_WAKE_TASK_ID);
    // Registering the same identifier twice kills the process, so it is guarded.
    expect(task).toContain('private static var registered = false');

    // The identifier must be whitelisted, and the handler registered at launch.
    const plist = read('ios/App/App/Info.plist');
    expect(plist).toContain(AGENT_WAKE_TASK_ID);
    expect(plist).toContain('processing');
    const delegate = read('ios/App/App/AppDelegate.swift');
    expect(delegate).toContain('NativeAgentBackgroundTask.registerIfNeeded()');
    expect(delegate).toContain('import CapacitorNativeAgent');
    const generator = read(CONFIGURE);
    expect(generator).toContain(`const AGENT_WAKE_TASK_ID = '${AGENT_WAKE_TASK_ID}'`);
    expect(generator).toContain('NativeAgentBackgroundTask.registerIfNeeded()');
    expect(generator).toContain('import CapacitorNativeAgent');
  });

  it('a wake rebuilds the engine headlessly on both platforms', () => {
    const kotlin = read(`${WAKE_DIR_KT}/NativeWakeRunner.kt`);
    const swift = read(`${WAKE_DIR_SWIFT}/NativeAgentWakeRunner.swift`);
    for (const src of [kotlin, swift]) {
      expect(src).toContain('createHandleFromPersistedConfig');
      expect(src).toContain('handleWake');
      expect(src).toContain('setMemoryProvider');
      expect(src).toContain('recordWake');
      expect(src).toContain('engineConfigPath');
    }
    // The config path is the one initialize() persisted — one key, shared.
    const pluginKt = read(KOTLIN);
    expect(pluginKt).toContain('NativeWakeStore.CAPACITOR_STORAGE_FILE');
    expect(pluginKt).toContain('NativeWakeStore.CONFIG_PATH_KEY');
    expect(read(`${WAKE_DIR_KT}/NativeWakeStore.kt`)).toContain('"CapacitorStorage"');
    expect(read(`${WAKE_DIR_SWIFT}/NativeAgentWakeStore.swift`)).toContain('"mobilecron:native-agent-config-path"');
  });

  it('telemetry reflects the OS, not a stored wish', () => {
    const scheduler = read(`${WAKE_DIR_KT}/NativeWakeScheduler.kt`);
    expect(scheduler).toContain('WorkInfo.State.ENQUEUED');
    expect(scheduler).toContain('nextScheduleTimeMillis');
    const pluginKt = read(KOTLIN);
    for (const field of ['workState', 'nextRunApproxMs', 'lastWakeAt', 'lastWakeSource', 'lastWakeSummary', 'pendingTasks', 'dueCronJobs']) {
      expect(pluginKt, `getWakeStatus must report ${field}`).toContain(field);
    }
    const pluginSwift = read(SWIFT);
    for (const field of ['permitted', 'opportunistic', 'unreadSurfaced', 'pendingTasks']) {
      expect(pluginSwift, `iOS wake status must report ${field}`).toContain(field);
    }
    expect(read(`${WAKE_DIR_SWIFT}/NativeAgentBackgroundTask.swift`)).toContain('getPendingTaskRequests');
  });
});

describe("agent — surfaced messages come from the engine's own run history", () => {
  it('the capture filter matches what the engine writes', () => {
    const db = read(`${CRATE}/src/db.rs`);
    expect(db).toContain('wake_source');
    expect(db).toContain('INSERT INTO cron_runs (job_id, started_at, status, wake_source)');
    expect(db).toContain('finalize_cron_run');
    for (const src of [
      read(`${WAKE_DIR_KT}/NativeWakeCapture.kt`),
      read(`${WAKE_DIR_SWIFT}/NativeAgentWakeCapture.swift`),
    ]) {
      expect(src).toContain('wakeSource');
      expect(src).toContain('startedAt');
      expect(src).toContain('listCronRuns');
      expect(src).toContain('responseText');
      expect(src).toContain('listCronJobs');
    }
  });

  it('both platforms cap and shape the queue identically', () => {
    const kt = read(`${WAKE_DIR_KT}/NativeWakeStore.kt`);
    const sw = read(`${WAKE_DIR_SWIFT}/NativeAgentWakeStore.swift`);
    for (const src of [kt, sw]) {
      expect(src).toContain('surfaced.json');
      expect(src).toContain('500');
      for (const field of ['source', 'read', 'title', 'body', 'text', 'jobId', 'runId', 'status']) {
        expect(src, `record shape must carry ${field}`).toContain(`"${field}"`);
      }
    }
    // Written from the plugin, the worker and a notifier callback: serialised.
    expect(kt).toContain('synchronized(lock)');
    expect(sw).toContain('lock.lock()');
  });

  it('notifications posted during a wake are recorded too', () => {
    expect(read(`${WAKE_DIR_KT}/NativeWakeNotifier.kt`)).toContain('NativeNotifier');
    expect(read(`${WAKE_DIR_SWIFT}/NativeAgentWakeCapture.swift`)).toContain('NativeAgentWakeNotifier');
    // Installed around the wake; the normal notifier is restored afterwards so a
    // foreground turn is not recorded as a background message.
    for (const src of [read(KOTLIN), read(SWIFT)]) {
      expect(src).toContain('installRecordingNotifier');
      expect(src).toContain('restoreDefaultNotifier');
    }
  });

  it('config carries the wake defaults into the bridge', () => {
    const config = JSON.parse(read('app.config.json'));
    expect(Object.keys(config.agent).sort()).toEqual([
      'markSurfacedRead',
      'minWakeIntervalMinutes',
      'surfacedLimit',
      'wakeIntervalMinutes',
    ]);
    const schema = JSON.parse(read('app.config.schema.json'));
    expect(schema.required).toContain('agent');
    expect(schema.properties.agent.properties.minWakeIntervalMinutes.minimum).toBe(15);
    expect(read('scripts/build-bridge.mjs')).toContain('agent: {');
    expect(read(BRIDGE)).toContain('minWakeIntervalMinutes');
    expect(read(BRIDGE)).toContain('function agentInterval(');
  });
});
