# capacitor-native-agent

Native AI agent loop for Capacitor apps. Runs LLM completions, tool execution, cron jobs, and session persistence in native Rust via UniFFI, enabling true background execution on mobile.

## Features

- **Native agent loop** — LLM streaming, multi-turn tool calling, abort/steer
- **Built-in tools** — File I/O, git (libgit2), grep, shell exec, fetch
- **SQLite persistence** — Sessions, cron jobs, skills, scheduler/heartbeat config
- **Background execution** — Runs outside the WebView lifecycle (WorkManager / BGProcessingTask)
- **Auth management** — API key and OAuth token storage with refresh
- **Cron & heartbeat** — Scheduled agent runs with wake evaluation
- **MCP support** — Model Context Protocol server integration
- **Event bridge** — Streams events (text_delta, tool_use, tool_result, etc.) to the WebView

## Install

```bash
npm install capacitor-native-agent
npx cap sync
```

## Cloning this repository

The Rust FFI crate lives in a separate GitLab repository and is pulled in as a git submodule. After cloning:

```bash
git submodule update --init --recursive
```

Upstream URL: https://gitlab.k8s.t6x.io/rruiz/native-agent-ffi

## Android Setup

The npm package includes the Kotlin plugin source and UniFFI bindings, but **not** the compiled Rust shared library. You must build and place it yourself:

### 1. Build the Rust .so

```bash
scripts/build-android.sh
```

This builds the submodule for **all Android ABIs** — `arm64-v8a`, `armeabi-v7a`,
`x86_64`, `x86` — with a lightweight profile (LTO + single codegen unit +
symbol strip + size-tuned opt level; override with `SIZE_OPT_LEVEL=3`), and
copies each `libnative_agent_ffi.so` into the matching
`android/src/main/jniLibs/<abi>/` folder. `arm64-v8a` is required (the script
fails if it doesn't work); the other ABIs are best-effort — if a Rust
dependency can't build for a 32-bit/emulator target the script warns and
continues, and affected devices degrade gracefully at runtime (see
`checkAvailability()` below) instead of crashing.

### 2. Place the .so in your app

Copy the built library to your Android app's jniLibs (all ABIs, or only the
ones you ship — use `ndk { abiFilters ... }` in your app's `build.gradle` to
drop ABIs you don't need, e.g. `x86`):

```bash
cp target/aarch64-linux-android/release/libnative_agent_ffi.so \
   <your-app>/android/app/src/main/jniLibs/arm64-v8a/
# and the other ABIs the script built, if any
```

### 3. Sync and build

```bash
npx cap sync android
cd android && ./gradlew assembleDebug
```

## Usage

```typescript
import { NativeAgent } from 'capacitor-native-agent'

// Listen for agent events
NativeAgent.addListener('nativeAgentEvent', (event) => {
  const { eventType, payloadJson } = event
  const payload = JSON.parse(payloadJson)

  if (eventType === 'text_delta') {
    process.stdout.write(payload.text)
  }
})

// Initialize — `defaultProvider` and `defaultModel` are the agent's
// configured LLM identity. Every code path (sendMessage, cron jobs,
// skills, follow-up) inherits these unless the caller explicitly
// overrides per-call. See "Configuring the LLM provider" below.
await NativeAgent.initialize({
  dbPath: 'files://agent.db',
  workspacePath: '/path/to/workspace',
  authProfilesPath: '/path/to/auth-profiles.json',
  defaultProvider: 'openai',
  defaultModel: 'gpt-4o',
})

// Set auth
await NativeAgent.setAuthKey({
  key: 'sk-...',
  provider: 'openai',
  authType: 'api_key',
})

// Send a message — uses the configured default provider/model.
const { runId } = await NativeAgent.sendMessage({
  prompt: 'Hello!',
  sessionKey: 'session-1',
  systemPrompt: 'You are a helpful assistant.',
})
```

## Configuring the LLM provider

The agent's `provider` and `model` are resolved at every turn (interactive `sendMessage`, cron jobs fired from background, skill kickoffs, follow-up turns) using this precedence chain:

1. **Per-call override** — `SendMessageParams.provider` / `model` if explicitly set on a single call.
2. **Configured default** — `InitConfig.defaultProvider` / `defaultModel` set once at `initialize()`.
3. **Hardcoded last-resort** — `anthropic` + that provider's default model. The native side emits a loud `eprintln!` whenever this branch fires; a properly-configured install never reaches it.

This means a cron job created with no explicit provider will run on whatever the agent was set up with at `initialize()`-time — not silently fall back to Anthropic. Cron skills can additionally pin a per-skill `provider` / `model` override (see `CronSkillInput`) when one specific skill needs a different model than the agent default.

Note: when a caller overrides `provider` but not `model`, the configured `defaultModel` is **not** applied (model strings are tied to providers). The resolver falls through to the per-provider default model instead.

## API

See [definitions.ts](src/definitions.ts) for the full TypeScript interface.

### Core Methods

| Method | Description |
|--------|-------------|
| `initialize()` | Create the native agent handle |
| `checkAvailability()` | Probe whether the native lib loads on this device ABI (never rejects) |
| `scheduleBackgroundWakes()` | Periodic cron/heartbeat wake in the background (Android JobScheduler / iOS BGProcessingTask) |
| `cancelBackgroundWakes()` | Cancel the periodic background wake |
| `sendMessage()` | Start an agent turn |
| `followUp()` | Continue the conversation |
| `abort()` | Cancel the running turn |
| `steer()` | Inject guidance into a running turn |

### Auth

| Method | Description |
|--------|-------------|
| `getAuthToken()` | Get stored auth token |
| `setAuthKey()` | Store API key or OAuth token |
| `deleteAuth()` | Remove auth for a provider |
| `refreshToken()` | Refresh an OAuth token |
| `getAuthStatus()` | Get masked key status |

### Sessions

| Method | Description |
|--------|-------------|
| `listSessions()` | List all sessions |
| `loadSession()` | Load session message history |
| `resumeSession()` | Resume a previous session |
| `clearSession()` | Clear current session |

### Cron & Scheduling

| Method | Description |
|--------|-------------|
| `addCronJob()` | Create a scheduled job |
| `updateCronJob()` | Update job config |
| `removeCronJob()` | Delete a job |
| `listCronJobs()` | List all jobs |
| `runCronJob()` | Force-trigger a job |
| `handleWake()` | Evaluate due jobs (called from WorkManager) |
| `getSchedulerConfig()` | Get scheduler + heartbeat config |
| `setSchedulerConfig()` | Update scheduler config |
| `setHeartbeatConfig()` | Update heartbeat config |

### Tools

| Method | Description |
|--------|-------------|
| `invokeTool()` | Execute a tool directly |
| `startMcp()` | Start MCP server |
| `restartMcp()` | Restart MCP with new tools |

## Event Types

Events are emitted via `addListener('nativeAgentEvent', handler)`:

- `text_delta` — Streaming text chunk
- `thinking` — Model thinking content
- `tool_use` — Tool invocation started
- `tool_result` — Tool completed
- `agent.completed` — Turn finished with usage stats
- `agent.error` — Error occurred
- `approval_request` — Tool needs user approval
- `cron.job.started` / `cron.job.completed` / `cron.job.error` — Cron lifecycle
- `heartbeat.*` — Heartbeat lifecycle
- `scheduler.status` — Scheduler state updates

## Supported LLM providers

The `provider` argument is a free string. The Rust agent loop currently accepts:

| Provider string | Default model | Endpoint |
|---|---|---|
| `anthropic` | `claude-sonnet-4-20250514` | Anthropic Messages API |
| `openai` | `gpt-4o` | OpenAI Chat Completions |
| `openrouter` | `anthropic/claude-sonnet-4.5` | OpenRouter |
| `kimi` (aliases `kimi-coding`, `kimi-code`) | `kimi-for-coding` | Kimi Coding (Anthropic-messages-compatible, https://api.kimi.com/coding) |

The "Default model" column is what the resolver picks when a provider is selected but no model is supplied. To use a different model with a given provider, pass it explicitly via `defaultModel` at `initialize()` or per-call on `sendMessage`.

## Platform Support

| Platform | Status |
|----------|--------|
| Android  | Supported. `scripts/build-android.sh` builds **all ABIs** (`arm64-v8a`, `armeabi-v7a`, `x86_64`, `x86`) into `android/src/main/jniLibs/`. The 0.9.14 published binary currently contains `arm64-v8a` only — re-run the build script (needs access to the `rust/native-agent-ffi` submodule) to add the other ABIs. |
| iOS      | Supported. `xcframework` ships device (`ios-arm64`) + Apple Silicon simulator (`ios-arm64-simulator`) slices; `scripts/build-ios.sh` also adds an Intel simulator slice (`x86_64-simulator`) when built on an Intel-capable Mac. All shipping iPhone/iPad hardware is arm64. |
| Web      | N/A (throws unavailable error). |

### Every device, gracefully

The plugin never hard-crashes on an unsupported architecture:

- If the device's ABI has no `libnative_agent_ffi.so` in the package (e.g. a
  32-bit phone when only `arm64-v8a` was shipped), `initialize()` **rejects
  with a clear JS error** instead of dying with a native
  `UnsatisfiedLinkError`.
- Call `NativeAgent.checkAvailability()` at startup to show a friendly
  "this device is not supported" screen:

```typescript
const { available, abi, reason } = await NativeAgent.checkAvailability()
if (!available) console.warn(`NativeAgent unavailable on ${abi}: ${reason}`)
```

- The native handle is **process-wide** (a shared registry), so multiple
  activities/webviews in one process share a single Rust engine instead of
  opening duplicate SQLite handles and duplicate schedulers.

### Background execution (cron / heartbeat)

Runs outside the WebView lifecycle:

- **Android** — the plugin ships a dependency-free `JobService`
  (`NativeAgentJobService`, registered in its merged manifest). Call
  `scheduleBackgroundWakes({ intervalMinutes: 30 })` after `initialize()`;
  the OS wakes the engine periodically (floor: 15 min on API 24+, 30 min on
  API 23; job is persisted across reboots; requires network connectivity).
- **iOS** — `scheduleBackgroundWakes()` uses `BGProcessingTask`
  (opportunistic, OS-chosen idle windows). The host app must add
  `BGTaskSchedulerPermittedIdentifiers` containing `io.t6x.nativeagent.wake`
  to its Info.plist and enable Background Modes → "Background fetch".
  Without that, the call resolves with `jobScheduled: false` + a reason
  (no crash).

Both paths restore the engine from the config saved at `initialize()`, so
cron jobs keep evaluating even when the app was relaunched headless.

### Memory (LanceDB) is optional

The LanceDB-backed memory provider compiles into the plugin **only** when
the host app also integrates `capacitor-lancedb` (Android: automatic via
Gradle project detection; iOS: the Swift sources guard on
`#if canImport(...)` and fall back to a no-op). Apps without it build and
run fine; the agent simply has no long-term memory store.

## Lightweight profile

- The Rust release build uses `lto=thin`, `codegen-units=1`, `strip=symbols`
  and `opt-level=s` by default (`SIZE_OPT_LEVEL=3` for max performance).
- Publish an **App Bundle (.AAB)** to Play: ABI splits mean each user
  downloads only their architecture's `.so` (no size penalty for shipping
  all ABIs).
- iOS memory: the xcframework slices no longer duplicate the generated
  Swift binding (removed ~250KB from the published artifacts).

## License

MIT
