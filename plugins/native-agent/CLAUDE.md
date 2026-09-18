# capacitor-native-agent — project rules

## The Rust crate is a submodule, not a fork

`rust/native-agent-ffi/` is a **git submodule** pointing at the upstream Rust crate at https://gitlab.k8s.t6x.io/rruiz/native-agent-ffi. This repo stores only a SHA pointer to a commit on that upstream — there is no fork, no vendored copy, no duplicated source.

### Hard rules

- **Do not edit any file under `rust/native-agent-ffi/`.** All Rust changes belong upstream on GitLab. After landing them upstream, advance the submodule pointer here and rebuild.
- **Do not delete the `rust/` directory or the submodule.** `scripts/build-android.sh` and `scripts/build-ios.sh` both `cd` into `rust/native-agent-ffi/` to invoke `cargo`. Without the submodule checked out, neither build can run.
- **Do not commit binaries from `rust/native-agent-ffi/target/`.** It is `.gitignore`d for a reason — only the cross-compiled artifacts end up in `android/src/main/jniLibs/` and `ios/Frameworks/`.

### After cloning this repo

```bash
git submodule update --init --recursive
```

### To pull upstream Rust changes

```bash
cd rust/native-agent-ffi
git fetch origin
git checkout <new-sha>     # or: git pull --ff-only origin main
cd ../..
git add rust/native-agent-ffi
# then rebuild and commit
```

## What ships to npm

The `files` field in `package.json` controls the tarball. Source-of-truth: only the **prebuilt artifacts** ship:

- `dist/esm/` — TypeScript build output
- `android/src/main/` — Kotlin plugin source + generated UniFFI bindings + `.so` under `jniLibs/`
- `android/build.gradle`
- `ios/Sources/` — Swift plugin source + generated UniFFI bindings
- `ios/Frameworks/NativeAgentFFI.xcframework/` — prebuilt staticlibs (device + simulator)
- `CapacitorNativeAgent.podspec`, `Package.swift`, `README.md`, `LICENSE`

The `rust/` submodule, the `example/` smoke-test app, and any `android/build/` Gradle output are **never** included.

## Release flow

1. Pull submodule to the new upstream SHA (see above).
2. **Android rebuild (Linux or Mac):** `scripts/build-android.sh` — builds **all ABIs** (`arm64-v8a` required; `armeabi-v7a`, `x86_64`, `x86` best-effort) with the lightweight profile (`lto=thin`, `codegen-units=1`, `strip=symbols`, `opt-level=s` — override with `SIZE_OPT_LEVEL=3`), copies each `libnative_agent_ffi.so` into the matching `android/src/main/jniLibs/<abi>/`, regenerates the Kotlin UniFFI binding.
3. **iOS rebuild (Mac only):** `scripts/build-ios.sh` — builds device + Apple Silicon simulator staticlibs (plus an Intel simulator slice when possible), regenerates the Swift UniFFI binding, assembles `ios/Frameworks/NativeAgentFFI.xcframework/`.
4. `npm run clean && npm run build` — TypeScript build (the rebuilt `dist/` must be committed — it ships in the tarball).
5. Bump version in `package.json`. There are no other version refs in the tree.
6. `scripts/verify-release.sh` — sanity gate (dist freshness, ABI coverage, stripped binaries, xcframework slices, packaging rules, tarball contents).
7. Commit (include the submodule pointer move), tag `vX.Y.Z`, push to GitHub.
8. `npm publish`.

## Mac remote convention

iOS staticlibs cannot be cross-compiled from Linux. iOS work happens on the project's Mac remote (`rogelioruizgatica@10.61.192.207`) **strictly under `~/choreruiz/`** — never elsewhere in the Mac home. This rule comes from the parent repo's `CLAUDE.md` and applies to this project too.

Typical iOS rebuild session on the Mac:

```bash
cd ~/choreruiz/capacitor-native-agent       # clone or rsync first if missing
git pull && git submodule update --init --recursive
(cd rust/native-agent-ffi && git fetch && git checkout <sha>)
scripts/build-ios.sh
```

Then rsync `ios/Frameworks/NativeAgentFFI.xcframework/` and `ios/Sources/NativeAgentPlugin/Generated/` back to the Linux dev host.

## LLM provider resolution

The agent's LLM identity lives on `InitConfig.default_provider` and `InitConfig.default_model` (Rust) / `defaultProvider` / `defaultModel` (TS, Kotlin, Swift). Setting these at `initialize()` is what makes "use the configured provider everywhere" work — they are the second link in the resolution chain inside `agent_loop::resolve_llm`:

1. Per-call `SendMessageParams.provider` / `model` (explicit override).
2. `InitConfig.default_provider` / `default_model` (the configured agent identity).
3. Hardcoded `"anthropic"` + that provider's default model — last-resort safety net. The resolver fires `eprintln!` when it lands here so silent fallback can't recur.

When a caller overrides `provider` but not `model`, the configured `default_model` is intentionally **not** applied (model strings are tied to providers). The resolver falls through to `default_model(resolved_provider)` instead.

Background paths (`handle_wake` for cron, future scheduled-task entry points) build `SendMessageParams` with `provider: None, model: None` — that's correct, it means "use the agent default". Cron skills can pin per-skill overrides via the `provider` / `model` columns on `cron_skills`.

If you find yourself adding a new entry point that constructs `SendMessageParams`, **do not** thread provider through manually — leave it `None` and let the resolver handle it. Any explicit `Some("anthropic")` in a new call site is almost certainly a bug.

## Supported LLM providers

`provider` is a free `string` across the JS → Kotlin/Swift → FFI boundary. Accepted values are decided in the Rust crate's `agent_loop::create_driver`. Currently:

- `anthropic` — Claude
- `openai` — OpenAI
- `openrouter` — OpenRouter
- `kimi` (aliases `kimi-coding`, `kimi-code`) — Kimi Coding via Anthropic-messages-compatible endpoint

To add a new provider, the change goes upstream in the Rust crate, then this repo's submodule pointer advances.
