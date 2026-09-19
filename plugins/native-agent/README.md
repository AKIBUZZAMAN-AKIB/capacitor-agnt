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
