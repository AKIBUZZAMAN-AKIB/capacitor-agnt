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

## Android Setup

The npm package includes the Kotlin plugin source and UniFFI bindings, but **not** the compiled Rust shared library. You must build and place it yourself:

### 1. Build the Rust .so

```bash
cd rust/native-agent-ffi
cargo ndk -t arm64-v8a build --release
```

### 2. Place the .so in your app

Copy the built library to your Android app's jniLibs:

```bash
cp target/aarch64-linux-android/release/libnative_agent_ffi.so \
   <your-app>/android/app/src/main/jniLibs/arm64-v8a/
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

// Initialize
await NativeAgent.initialize({
  dbPath: 'files://agent.db',
  workspacePath: '/path/to/workspace',
  authProfilesPath: '/path/to/auth-profiles.json',
})

// Set auth
await NativeAgent.setAuthKey({
  key: 'sk-ant-...',
  provider: 'anthropic',
  authType: 'api_key',
})

// Send a message
const { runId } = await NativeAgent.sendMessage({
  prompt: 'Hello!',
  sessionKey: 'session-1',
  systemPrompt: 'You are a helpful assistant.',
})
```

## API

See [definitions.ts](src/definitions.ts) for the full TypeScript interface.

### Provider routing

Detailed Bengali audit of protocol/model/auth/tool/streaming behavior, current public catalog findings, privacy and remaining verification limits: [Provider/API audit](../../docs/PROVIDER-API-AUDIT.bn.md).

`defaultProvider` defaults to `auto`, the **Free Router**: Kilo `kilo-auto/free` is always tried first and OpenRouter `openrouter/free` is the only cross-provider fallback. Both are provider-maintained virtual routers over their live free inventory. Auto routing is a deny-by-default cost boundary: paid defaults and unknown-price models are rejected; an explicit provider selection is required for paid use. `autoRouting` retains transient-failover limits, while its free route order is locked. Model-specific overrides are available through `providerModelProtocols`, `providerToolCapabilities`, `providerModelAuthRequirements`, and `providerModelStreamingCapabilities`. These maps contain model IDs/capability metadata only; API keys stay in the separate auth store. Dynamic catalogs should be refreshed before pinning a model, and tool calls are routed only when that exact model is confirmed to support them.

### Tool exposure and approvals

If `allowedToolsJson` is omitted, the agent starts from the built-in tool catalog plus registered MCP tools. An explicit list narrows that set; `[]` exposes none. The schema is further filtered for tools marked disabled, missing host capabilities, missing memory storage, or unavailable WebView/MCP callbacks. For example, `execute_command` is not advertised on iOS because iOS apps cannot spawn shell processes. Provider/model tool-call capability is a separate gate: a tool in the catalog does not make an incompatible model capable of calling it.

Exposure is not authorization. A fabricated or stale tool call is checked again at dispatch. `enabled: false` denies it; allow-lists never bypass approval. With no saved permission row, read-only built-ins are permitted while writes, shell, network fetch, cron changes, and memory mutations require interactive approval. MCP tools ask by default. Approval settings can explicitly change that policy. In the Agent Lab, “Seed defaults” inserts all built-in defaults without overwriting existing user choices.

### Context and memory

The active short-term memory is the persisted per-session transcript in SQLite. `contextCharBudget` is a character-based approximation, not a provider tokenizer or a guarantee of the selected model's context window. The engine reserves estimated room for the system prompt, tool schemas, and output, then—when the transcript exceeds the remaining budget—makes a tool-free summary request through the selected routing plan. It replaces an older, tool-call-safe prefix with a hidden internal-context message that provider adapters send as user content—not as elevated system instructions—and emits `context.compacted`. That note is session-scoped; it is not written to `MEMORY.md` or long-term memory. The summarizer is instructed to preserve goals, explicit constraints, decisions, verified outcomes, and next steps, and to omit secrets, but model-generated summaries can be lossy. If summarization fails, the engine falls back to removing the oldest safe prefix and emits `context.trimmed`. If even the newest message is too large, the estimate can remain over budget and the provider may still reject it.

Long-term memory is separate: workspace `MEMORY.md` is loaded into the normal workspace system prompt, and the `memory_*` tools use a local platform-owned JSON store. Built-in Android/iOS stores use bounded lexical/token-overlap search, not guaranteed semantic or vector search. Memory entries are not automatically promoted from a session summary; the model must explicitly use memory tools, and `memory_store` / `memory_forget` require approval by default. Review stored memory before allowing persistent changes.

### Core Methods

| Method | Description |
|--------|-------------|
| `initialize()` | Create the native agent handle |
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
- `context.compacted` / `context.trimmed` — Session transcript was summarized or safely trimmed to the approximate prompt budget
- `cron.job.started` / `cron.job.completed` / `cron.job.error` — Cron lifecycle
- `heartbeat.*` — Heartbeat lifecycle
- `scheduler.status` — Scheduler state updates

## Platform Support

| Platform | Status |
|----------|--------|
| Android  | Supported |
| iOS      | Not yet implemented |
| Web      | N/A (throws unavailable error) |

## License

MIT
